-- 039_rename_category_and_retag_skus.sql
-- Adds RPC to safely rename a category and retag SKUs within a single transaction.
-- Non-disruptive: does not change existing table structure.

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
