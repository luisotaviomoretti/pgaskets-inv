-- 038_add_categories_table.sql
-- Safe, non-disruptive migration to introduce managed categories
-- - Adds categories table with RLS and indexes
-- - Adds updated_at trigger using existing update_updated_at() function
-- - Seeds initial categories from DISTINCT skus.product_category (idempotent)
--
-- Notes:
-- - This migration does NOT alter skus table to keep changes non-disruptive.
-- - Seed/backfill is idempotent and safe to re-run.

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
-- Optional: fuzzy search by name (pg_trgm should exist from initial schema)
DO $$ BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_trgm';
  IF FOUND THEN
    CREATE INDEX IF NOT EXISTS idx_categories_name_trgm ON categories USING gin(name gin_trgm_ops);
  END IF;
END $$;

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
--    - Extract DISTINCT product_category names
--    - Generate a safe slug and unique id
--    - Insert as active categories
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
