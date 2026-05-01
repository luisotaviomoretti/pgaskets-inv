-- 046_error_code_envelope.sql
-- All RAISE EXCEPTION sites in the inventory pipeline now emit a JSON
-- envelope as the message: {"code": "...", "detail": "..."}.
-- The frontend parses this once via parseRpcError() and switches on the
-- code. This eliminates the brittle if (msg.includes('Insufficient stock'))
-- regex chain in WorkOrder.tsx (line ~683) and gives us a stable contract.
--
-- Codes used:
--   INSUFFICIENT_STOCK   - layers don't have enough remaining qty
--   INVALID_INPUT        - non-positive qty/cost, etc.
--   NOT_FOUND            - SKU/layer/movement not found
--   INTEGRITY_VIOLATION  - unexpected CHECK/FK/trigger failure
--   DECIMAL_PRECISION    - reserved (only fires if migration 041 was reverted)
--
-- We update execute_fifo_consumption_validated (last definition: migration 034
-- with the rounding from migration 041). All other RPCs (044, 045) already
-- use the JSON envelope.

BEGIN;

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
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INVALID_INPUT',
      'detail', format('Quantity needed must be positive: %s', p_quantity_needed)
    )::text USING ERRCODE = '23514';
  END IF;

  -- Pre-validation based on layers availability (authoritative)
  SELECT public.get_available_from_layers(p_sku_id) INTO v_available_layers;
  IF v_available_layers < p_quantity_needed THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INSUFFICIENT_STOCK',
      'detail', format('SKU %s has %s available; needed %s', p_sku_id, v_available_layers, p_quantity_needed),
      'sku_id', p_sku_id,
      'available', v_available_layers,
      'needed', p_quantity_needed
    )::text USING ERRCODE = '23514';
  END IF;

  -- Iterate layers in FIFO order with row-level locks to prevent concurrent consumption
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
    -- Round to 4 decimals so the inserted total_cost matches the DECIMAL(12,4)
    -- column representation (defends the consistent_total CHECK; see 041).
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
    -- This should not happen given the pre-validation, but defensively:
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INSUFFICIENT_STOCK',
      'detail', format('Could not consume full quantity for SKU %s. Remaining unmet: %s', p_sku_id, v_remaining_needed),
      'sku_id', p_sku_id,
      'unmet', v_remaining_needed
    )::text USING ERRCODE = '23514';
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
