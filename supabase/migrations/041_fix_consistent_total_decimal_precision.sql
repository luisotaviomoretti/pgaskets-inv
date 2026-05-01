-- 041_fix_consistent_total_decimal_precision.sql
-- Fix: Work Orders with decimal RAW quantities fail with
--   "new row for relation \"layer_consumptions\" violates check constraint \"consistent_total\""
--
-- Root cause:
--   layer_consumptions.consistent_total CHECK requires exact equality:
--     total_cost = quantity_consumed * unit_cost
--   But total_cost is DECIMAL(12,4) so it stores at most 4 decimal places, while the
--   product of DECIMAL(10,3) * DECIMAL(10,4) can yield up to 7 decimal places.
--   On insert, Postgres rounds total_cost to 4 places, then re-evaluates the CHECK
--   against the unrounded product -- equality fails.
--
--   Example with the C42 1/8 SKU at $14.7810 unit cost, qty 5.25:
--     5.25 * 14.7810 = 77.600250 (exact)
--     Stored as DECIMAL(12,4) = 77.6003 (banker's rounding)
--     CHECK rhs: 5.250 * 14.7810 = 77.6002500
--     77.6003 != 77.6002500  -> violates CHECK
--
-- Fix:
--   1) Replace the strict equality CHECK with a tiny-tolerance check that accepts
--      4-decimal rounding (delta < 0.0001).
--   2) Round v_consume_cost to 4 decimals inside execute_fifo_consumption_validated,
--      so the inserted value matches what the column will store. Defense in depth.
--
-- Safety:
--   - All existing rows satisfy the strict equality (delta = 0), so they trivially
--     satisfy the relaxed tolerance check. Migration is non-destructive.

BEGIN;

-- 1) Relax the CHECK to allow 4-decimal rounding
ALTER TABLE public.layer_consumptions
  DROP CONSTRAINT IF EXISTS consistent_total;

ALTER TABLE public.layer_consumptions
  ADD CONSTRAINT consistent_total
  CHECK (ABS(total_cost - (quantity_consumed * unit_cost)) < 0.0001);

-- 2) Round inside the RPC so inserted total_cost matches the stored representation
CREATE OR REPLACE FUNCTION public.execute_fifo_consumption_validated(
  p_sku_id text,
  p_quantity_needed numeric,
  p_movement_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_layer record;
  v_remaining_needed numeric := p_quantity_needed;
  v_total_cost numeric := 0;
  v_consumptions jsonb[] := '{}';
  v_available_layers numeric;
  v_consume_qty numeric;
  v_consume_cost numeric;
BEGIN
  -- Basic validation
  IF p_quantity_needed <= 0 THEN
    RAISE EXCEPTION 'Quantity needed must be positive: %', p_quantity_needed USING ERRCODE = '23514';
  END IF;

  -- Pre-validation based on layers availability (authoritative)
  SELECT public.get_available_from_layers(p_sku_id) INTO v_available_layers;
  IF v_available_layers < p_quantity_needed THEN
    RAISE EXCEPTION 'Insufficient stock (layers) for SKU %. Available: %, Needed: %',
      p_sku_id, v_available_layers, p_quantity_needed
      USING ERRCODE = '23514';
  END IF;

  -- Iterate layers in FIFO order and acquire row-level locks
  FOR v_layer IN
    SELECT id, remaining_quantity, unit_cost
    FROM public.fifo_layers
    WHERE sku_id = p_sku_id
      AND status = 'ACTIVE'
      AND remaining_quantity > 0
    ORDER BY receiving_date, created_at
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_needed <= 0;

    v_consume_qty := LEAST(v_remaining_needed, v_layer.remaining_quantity);
    -- Round to 4 decimals so the inserted total_cost matches the stored representation
    -- (column is DECIMAL(12,4)). Without this, the CHECK constraint can fail when
    -- the raw product has more than 4 decimal places.
    v_consume_cost := ROUND(v_consume_qty * v_layer.unit_cost, 4);

    INSERT INTO public.layer_consumptions (
      movement_id, layer_id, quantity_consumed, unit_cost, total_cost
    ) VALUES (
      p_movement_id, v_layer.id, v_consume_qty, v_layer.unit_cost, v_consume_cost
    );

    PERFORM public.update_layer_quantity(v_layer.id, -v_consume_qty);

    v_total_cost := v_total_cost + v_consume_cost;
    v_consumptions := v_consumptions || jsonb_build_object(
      'layer_id', v_layer.id,
      'quantity', v_consume_qty,
      'cost', v_consume_cost
    );

    v_remaining_needed := v_remaining_needed - v_consume_qty;
  END LOOP;

  IF v_remaining_needed > 0 THEN
    RAISE EXCEPTION 'Could not consume full quantity. Remaining: %', v_remaining_needed USING ERRCODE = '23514';
  END IF;

  PERFORM public.sync_sku_on_hand_from_layers(p_sku_id);

  RETURN jsonb_build_object(
    'success', true,
    'total_consumed', p_quantity_needed,
    'total_cost', v_total_cost,
    'consumptions', v_consumptions
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.execute_fifo_consumption_validated(text, numeric, integer) TO anon, authenticated;

COMMIT;
