-- 007_fix_update_sku_quantity_grants.sql
-- Ensure update_sku_quantity is invocable from client (SECURITY DEFINER + grants)

BEGIN;

-- Recreate function with SECURITY DEFINER to bypass RLS for internal update
CREATE OR REPLACE FUNCTION public.update_sku_quantity(
  p_sku_id text,
  p_quantity_change numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_quantity numeric;
BEGIN
  UPDATE public.skus 
  SET 
    on_hand = on_hand + p_quantity_change,
    updated_at = NOW()
  WHERE id = p_sku_id
  RETURNING on_hand INTO v_new_quantity;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU not found: %', p_sku_id USING ERRCODE = 'P0002';
  END IF;
  
  RETURN v_new_quantity;
END;
$$;

-- Grant execute to both anon and authenticated roles
GRANT EXECUTE ON FUNCTION public.update_sku_quantity(text, numeric) TO anon, authenticated;

COMMIT;
