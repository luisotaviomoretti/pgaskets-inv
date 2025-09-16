-- 034_fifo_locking_and_concurrency.sql
-- Purpose: Harden FIFO consumption against race conditions using row-level locks (FOR UPDATE)
--          while preserving current architecture and function signatures.
-- Notes:
--  - This migration keeps the existing interface of public.execute_fifo_consumption_validated
--    and only strengthens its internal concurrency controls.
--  - It relies on existing helper functions: get_available_from_layers() and
--    sync_sku_on_hand_from_layers().
--  - It keeps using update_layer_quantity() for consistency, acquiring row locks before updates.

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
    RAISE EXCEPTION 'Quantity needed must be positive: %', p_quantity_needed USING ERRCODE = '23514';
  END IF;

  -- Pre-validation based on layers availability (authoritative)
  SELECT public.get_available_from_layers(p_sku_id) INTO v_available_layers;
  IF v_available_layers < p_quantity_needed THEN
    RAISE EXCEPTION 'Insufficient stock (layers) for SKU %. Available: %, Needed: %',
      p_sku_id, v_available_layers, p_quantity_needed
      USING ERRCODE = '23514';
  END IF;

  -- Iterate layers in FIFO order and acquire row-level locks to prevent concurrent consumption
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

    -- Compute consumption for this locked layer
    v_consume_qty := LEAST(v_remaining_needed, v_layer.remaining_quantity);
    v_consume_cost := v_consume_qty * v_layer.unit_cost;

    -- Record consumption row (movement linkage and costing)
    INSERT INTO public.layer_consumptions (
      movement_id, layer_id, quantity_consumed, unit_cost, total_cost
    ) VALUES (
      p_movement_id, v_layer.id, v_consume_qty, v_layer.unit_cost, v_consume_cost
    );

    -- Update layer remaining using the canonical helper (already clamped)
    PERFORM public.update_layer_quantity(v_layer.id, -v_consume_qty);

    -- Accumulate totals and bookkeeping
    v_total_cost := v_total_cost + v_consume_cost;
    v_consumptions := v_consumptions || jsonb_build_object(
      'layer_id', v_layer.id,
      'quantity', v_consume_qty,
      'cost', v_consume_cost
    );

    v_remaining_needed := v_remaining_needed - v_consume_qty;
  END LOOP;

  -- Final check: ensure full quantity was consumed
  IF v_remaining_needed > 0 THEN
    RAISE EXCEPTION 'Could not consume full quantity. Remaining: %', v_remaining_needed USING ERRCODE = '23514';
  END IF;

  -- Sync (informational) to keep skus.on_hand aligned with layers
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
