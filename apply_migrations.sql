-- Combined migration script to apply category features
-- Execute this in Supabase Dashboard SQL Editor

-- ============================================
-- MIGRATION 1: Create categories table
-- ============================================

BEGIN;

-- 1) Create table (if not exists for idempotency in local/dev environments)
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  sort_order INT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Indexes
CREATE INDEX IF NOT EXISTS idx_categories_active ON categories(active);
CREATE INDEX IF NOT EXISTS idx_categories_sort_order ON categories(sort_order);

-- 3) RLS
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Enable all for authenticated users' AND tablename = 'categories'
  ) THEN
    CREATE POLICY "Enable all for authenticated users" ON categories
      FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- 4) updated_at trigger using existing function
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_categories_updated_at'
  ) THEN
    CREATE TRIGGER trigger_categories_updated_at
      BEFORE UPDATE ON categories
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- 5) Seed/Backfill from existing SKUs (idempotent)
WITH distinct_names AS (
  SELECT DISTINCT trim(both from product_category) AS name_raw
  FROM skus
  WHERE product_category IS NOT NULL
    AND length(trim(both from product_category)) > 0
),
normalized AS (
  SELECT
    name_raw AS name,
    regexp_replace(lower(name_raw), '[^a-z0-9]+', '-', 'g') AS slug_candidate
  FROM distinct_names
),
dedup AS (
  SELECT
    name,
    regexp_replace(slug_candidate, '(^-+)|(-+$)', '', 'g') AS slug_base
  FROM normalized
),
ranked AS (
  SELECT
    name,
    slug_base,
    ROW_NUMBER() OVER (PARTITION BY slug_base ORDER BY name) AS rn
  FROM dedup
),
to_insert AS (
  SELECT
    CASE WHEN rn > 1 THEN slug_base || '-' || rn ELSE slug_base END AS id,
    name,
    slug_base
  FROM ranked
)
INSERT INTO categories (id, name, slug, active, sort_order)
SELECT id, name, slug_base, TRUE, NULL
FROM to_insert
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================
-- MIGRATION 2: Add rename category function
-- ============================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rename_category_and_retag_skus(
  old_name text,
  new_name text,
  dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_exists boolean;
  v_target_id text;
  v_categories_updated int := 0;
  v_skus_updated int := 0;
  v_slug text;
BEGIN
  IF trim(coalesce(old_name, '')) = '' THEN
    RAISE EXCEPTION 'old_name is required';
  END IF;
  IF trim(coalesce(new_name, '')) = '' THEN
    RAISE EXCEPTION 'new_name is required';
  END IF;

  -- Ensure source category exists
  SELECT id INTO v_target_id FROM categories WHERE name = old_name LIMIT 1;
  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'CATEGORY_NOT_FOUND';
  END IF;

  -- Prevent conflicts (another category with new_name already exists)
  SELECT EXISTS(
    SELECT 1 FROM categories
    WHERE lower(name) = lower(new_name)
      AND name <> old_name
  ) INTO v_exists;
  IF v_exists THEN
    RAISE EXCEPTION 'CATEGORY_NAME_EXISTS';
  END IF;

  -- Generate slug similar to frontend service
  v_slug := regexp_replace(lower(new_name), '[^a-z0-9]+', '-', 'g');
  v_slug := regexp_replace(v_slug, '(^-+)|(-+$)', '', 'g');
  IF v_slug IS NULL OR v_slug = '' THEN v_slug := 'category'; END IF;

  IF dry_run THEN
    SELECT count(*) INTO v_skus_updated FROM skus WHERE product_category = old_name;
    RETURN jsonb_build_object(
      'success', true,
      'dryRun', true,
      'categoriesUpdated', 1,
      'skusUpdated', v_skus_updated
    );
  END IF;

  -- Serialize concurrent renames on same pair using advisory lock
  PERFORM pg_advisory_xact_lock(hashtext('rename_category_and_retag_skus:'||old_name||'->'||new_name));

  -- Update category name and slug (keep ID stable for non-disruptiveness)
  UPDATE categories
     SET name = new_name,
         slug = v_slug,
         updated_at = now()
   WHERE id = v_target_id;
  GET DIAGNOSTICS v_categories_updated = ROW_COUNT;

  -- Retag SKUs that match the old name
  UPDATE skus
     SET product_category = new_name
   WHERE product_category = old_name;
  GET DIAGNOSTICS v_skus_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'dryRun', false,
    'categoriesUpdated', v_categories_updated,
    'skusUpdated', v_skus_updated
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', sqlerrm,
      'code', sqlstate
    );
END;
$$;

COMMIT;

-- ============================================
-- Verify migration was successful
-- ============================================
SELECT
  'Categories table created' as status,
  count(*) as category_count
FROM categories;