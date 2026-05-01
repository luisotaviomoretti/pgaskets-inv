-- 045_idempotent_receiving_rpc.sql
-- Make create_receiving_transaction atomically idempotent and use the
-- fifo_layer_seq sequence (introduced in 043) instead of EXTRACT(EPOCH ...).
--
-- The idempotency key is movements.client_request_id (added in 042). The
-- frontend will pass a UUID per Submit click; rapid retries of the same
-- click reuse the UUID and dedupe. Distinct submissions get distinct UUIDs.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_receiving_transaction(
  p_sku_id            text,
  p_quantity          numeric,
  p_unit_cost         numeric,
  p_receiving_date    date    DEFAULT CURRENT_DATE,
  p_vendor_id         text    DEFAULT NULL,
  p_packing_slip_no   text    DEFAULT NULL,
  p_reference         text    DEFAULT 'RECEIVE',
  p_notes             text    DEFAULT NULL,
  p_client_request_id uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement_id     integer;
  v_layer_id        text;
  v_total_value     numeric;
  v_existing_movt   integer;
  v_existing_layer  text;
BEGIN
  ------------------------------------------------------------------
  -- 1) Idempotency short-circuit
  ------------------------------------------------------------------
  IF p_client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_movt
    FROM public.movements
    WHERE client_request_id = p_client_request_id
    LIMIT 1;

    IF v_existing_movt IS NOT NULL THEN
      -- Find the layer created from this movement
      SELECT id INTO v_existing_layer
      FROM public.fifo_layers
      WHERE created_by_movement_id = v_existing_movt
      LIMIT 1;

      RETURN jsonb_build_object(
        'success',       true,
        'was_duplicate', true,
        'movement_id',   v_existing_movt,
        'layer_id',      v_existing_layer,
        'quantity',      p_quantity,
        'total_value',   p_quantity * p_unit_cost
      );
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- 2) Input validation
  ------------------------------------------------------------------
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INVALID_INPUT',
      'detail', format('Quantity must be positive: %s', p_quantity)
    )::text USING ERRCODE = '23514';
  END IF;
  IF p_unit_cost <= 0 THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INVALID_INPUT',
      'detail', format('Unit cost must be positive: %s', p_unit_cost)
    )::text USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.skus WHERE id = p_sku_id) THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'NOT_FOUND',
      'detail', format('SKU not found: %s', p_sku_id)
    )::text USING ERRCODE = 'P0002';
  END IF;

  v_total_value := ROUND(p_quantity * p_unit_cost, 4);

  ------------------------------------------------------------------
  -- 3) Insert the movement, with client_request_id for dedup. Catch
  --    unique_violation in case of a concurrent race.
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value, reference, notes,
      client_request_id
    ) VALUES (
      NOW(), 'RECEIVE', p_sku_id, p_quantity, p_unit_cost, v_total_value, p_reference, p_notes,
      p_client_request_id
    ) RETURNING id INTO v_movement_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT id INTO v_existing_movt
      FROM public.movements
      WHERE client_request_id = p_client_request_id
      LIMIT 1;

      IF v_existing_movt IS NOT NULL THEN
        SELECT id INTO v_existing_layer
        FROM public.fifo_layers
        WHERE created_by_movement_id = v_existing_movt
        LIMIT 1;

        RETURN jsonb_build_object(
          'success',       true,
          'was_duplicate', true,
          'movement_id',   v_existing_movt,
          'layer_id',      v_existing_layer,
          'quantity',      p_quantity,
          'total_value',   v_total_value
        );
      END IF;
      RAISE;
  END;

  ------------------------------------------------------------------
  -- 4) Layer ID via sequence (atomic, no EPOCH collisions)
  ------------------------------------------------------------------
  v_layer_id := p_sku_id || '-L' || nextval('public.fifo_layer_seq')::text;

  INSERT INTO public.fifo_layers (
    id, sku_id, receiving_date, original_quantity, remaining_quantity,
    unit_cost, vendor_id, packing_slip_no, status, created_by_movement_id
  ) VALUES (
    v_layer_id, p_sku_id, p_receiving_date, p_quantity, p_quantity,
    p_unit_cost, p_vendor_id, p_packing_slip_no, 'ACTIVE', v_movement_id
  );

  PERFORM public.sync_sku_on_hand_from_layers(p_sku_id);

  RETURN jsonb_build_object(
    'success',       true,
    'was_duplicate', false,
    'movement_id',   v_movement_id,
    'layer_id',      v_layer_id,
    'quantity',      p_quantity,
    'total_value',   v_total_value
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_receiving_transaction(
  text, numeric, numeric, date, text, text, text, text, uuid
) TO anon, authenticated;

COMMIT;
