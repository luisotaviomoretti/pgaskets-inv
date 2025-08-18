-- 008_fix_update_layer_quantity_bounds.sql
-- Fix update_layer_quantity to clamp remaining in a single UPDATE to satisfy check constraints

BEGIN;

CREATE OR REPLACE FUNCTION public.update_layer_quantity(
  p_layer_id text,
  p_quantity_change numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_remaining numeric;
BEGIN
  -- Single-statement clamped update to avoid transient negative values
  UPDATE public.fifo_layers
  SET 
    remaining_quantity = GREATEST(0, LEAST(remaining_quantity + p_quantity_change, original_quantity)),
    last_movement_at = NOW(),
    status = CASE 
               WHEN GREATEST(0, LEAST(remaining_quantity + p_quantity_change, original_quantity)) = 0 THEN 'EXHAUSTED' 
               ELSE status 
             END
  WHERE id = p_layer_id
  RETURNING remaining_quantity INTO v_new_remaining;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', p_layer_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_layer_quantity(text, numeric) TO anon, authenticated;

COMMIT;
