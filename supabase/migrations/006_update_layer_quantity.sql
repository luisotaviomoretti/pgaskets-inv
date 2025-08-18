-- 006_update_layer_quantity.sql
-- Creates RPC used by FIFO consumption to update layer remaining_quantity safely

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
BEGIN
  UPDATE public.fifo_layers
  SET 
    remaining_quantity = remaining_quantity + p_quantity_change,
    last_movement_at = NOW()
  WHERE id = p_layer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', p_layer_id USING ERRCODE = 'P0002';
  END IF;

  -- Guardrails: do not allow negative remaining or exceeding original
  UPDATE public.fifo_layers
  SET remaining_quantity = GREATEST(0, LEAST(remaining_quantity, original_quantity))
  WHERE id = p_layer_id;
END;
$$;

-- Ensure minimal execute rights
GRANT EXECUTE ON FUNCTION public.update_layer_quantity(text, numeric) TO anon, authenticated;

COMMIT;
