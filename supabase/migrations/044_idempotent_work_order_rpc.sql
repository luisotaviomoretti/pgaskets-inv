-- 044_idempotent_work_order_rpc.sql
-- Refactor create_work_order_transaction to be atomically idempotent
-- using client_request_id (UUID) and to use the work_order_seq sequence
-- introduced in migration 043 instead of the racy EPOCH-based ID.
--
-- Idempotency contract:
--   - If a WO with the given client_request_id already exists, return it
--     unchanged (was_duplicate=true). No re-execution, no double-consumption.
--   - If two callers race with the same client_request_id, the database's
--     UNIQUE index forces one of them to lose with sqlstate 23505. We catch
--     that and return the winner. Net effect: exactly-once persistence.
--
-- Backwards compatibility:
--   - p_client_request_id is OPTIONAL. If NULL the RPC behaves like the
--     previous version (no idempotency, no dedup). This lets old frontend
--     builds keep working during the rollout window.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name      text,
  p_output_quantity  numeric,
  p_output_unit      text DEFAULT 'unit',
  p_mode             work_order_mode DEFAULT 'AUTO',
  p_client_name      text DEFAULT NULL,
  p_invoice_no       text DEFAULT NULL,
  p_notes            text DEFAULT NULL,
  p_materials        jsonb DEFAULT '[]'::jsonb,
  p_work_order_date  date DEFAULT CURRENT_DATE,
  p_client_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id        text;
  v_existing_wo_id       text;
  v_produce_movement_id  integer;
  v_consume_movement_id  integer;
  v_material             record;
  v_total_raw_cost       numeric := 0;
  v_total_waste_cost     numeric := 0;
  v_net_produce_cost     numeric := 0;
  v_consumption_result   jsonb;
  v_results              jsonb[] := '{}';
  v_movement_type        movement_type;
  v_wo_timestamp         timestamptz;
BEGIN
  ------------------------------------------------------------------
  -- 1) Idempotency short-circuit: if this client_request_id was
  --    already processed, return the existing WO without re-executing.
  ------------------------------------------------------------------
  IF p_client_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_wo_id
    FROM public.work_orders
    WHERE client_request_id = p_client_request_id
    LIMIT 1;

    IF v_existing_wo_id IS NOT NULL THEN
      RETURN public.read_back_work_order(v_existing_wo_id, true);
    END IF;
  END IF;

  ------------------------------------------------------------------
  -- 2) Input validation
  ------------------------------------------------------------------
  IF p_output_quantity <= 0 THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INVALID_INPUT',
      'detail', format('Output quantity must be positive: %s', p_output_quantity)
    )::text USING ERRCODE = '23514';
  END IF;

  v_wo_timestamp := (p_work_order_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC';

  ------------------------------------------------------------------
  -- 3) Generate WO ID via sequence (atomic, no EPOCH collisions)
  ------------------------------------------------------------------
  v_work_order_id := 'WO-' || nextval('public.work_order_seq')::text;

  ------------------------------------------------------------------
  -- 4) Insert the WO row. If two requests race with the same
  --    client_request_id, the UNIQUE index forces the loser to raise
  --    23505. We catch and return the winner.
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO public.work_orders (
      id, output_name, output_quantity, output_unit, mode,
      client_name, invoice_no, notes, status, created_at,
      work_order_date, client_request_id
    ) VALUES (
      v_work_order_id, p_output_name, p_output_quantity, p_output_unit, p_mode,
      p_client_name, p_invoice_no, p_notes, 'COMPLETED', NOW(),
      p_work_order_date, p_client_request_id
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- Race condition: another concurrent call with same client_request_id
      -- already inserted the WO. Read it back.
      SELECT id INTO v_existing_wo_id
      FROM public.work_orders
      WHERE client_request_id = p_client_request_id
      LIMIT 1;

      IF v_existing_wo_id IS NOT NULL THEN
        RETURN public.read_back_work_order(v_existing_wo_id, true);
      END IF;

      -- If we land here, the unique_violation was on something else (e.g. WO id collision).
      -- Re-raise.
      RAISE;
  END;

  ------------------------------------------------------------------
  -- 5) Process each material (ISSUE/WASTE) using validated FIFO.
  --    A failure here rolls back the entire transaction including
  --    the WO insert above (PostgreSQL atomic semantics).
  ------------------------------------------------------------------
  FOR v_material IN
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
  LOOP
    v_movement_type := COALESCE(NULLIF(TRIM(UPPER(v_material.type)), ''), 'ISSUE')::movement_type;

    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      v_wo_timestamp, v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id,
      CASE WHEN v_movement_type = 'WASTE' THEN 'Waste consumption' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_consume_movement_id
    ) INTO v_consumption_result;

    UPDATE public.movements
    SET unit_cost  = CASE WHEN v_material.quantity > 0
                          THEN ROUND((v_consumption_result->>'total_cost')::numeric / v_material.quantity, 4)
                          ELSE 0 END,
        total_value = -((v_consumption_result->>'total_cost')::numeric)
    WHERE id = v_consume_movement_id;

    IF v_movement_type = 'WASTE' THEN
      v_total_waste_cost := v_total_waste_cost + (v_consumption_result->>'total_cost')::numeric;
    ELSE
      v_total_raw_cost := v_total_raw_cost + (v_consumption_result->>'total_cost')::numeric;
    END IF;

    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'fifo_cost', (v_consumption_result->>'total_cost')::numeric,
      'consumption', v_consumption_result
    );
  END LOOP;

  v_net_produce_cost := v_total_raw_cost - v_total_waste_cost;

  ------------------------------------------------------------------
  -- 6) PRODUCE movement
  ------------------------------------------------------------------
  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    v_wo_timestamp, 'PRODUCE', p_output_name, p_output_quantity,
    CASE WHEN p_output_quantity > 0 THEN ROUND(v_net_produce_cost / p_output_quantity, 4) ELSE 0 END,
    v_net_produce_cost,
    v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

  UPDATE public.work_orders
  SET total_cost = v_net_produce_cost, completed_at = NOW()
  WHERE id = v_work_order_id;

  RETURN jsonb_build_object(
    'success',                true,
    'was_duplicate',          false,
    'work_order_id',          v_work_order_id,
    'produce_movement_id',    v_produce_movement_id,
    'total_raw_cost',         v_total_raw_cost,
    'total_waste_cost',       v_total_waste_cost,
    'net_produce_cost',       v_net_produce_cost,
    'produce_unit_cost',      CASE WHEN p_output_quantity > 0 THEN v_net_produce_cost / p_output_quantity ELSE 0 END,
    'material_consumptions',  v_results
  );
END;
$$;

------------------------------------------------------------------
-- Helper: read back an existing WO and return the same shape that the
-- main RPC returns. Used both by the idempotency short-circuit and
-- the unique_violation race recovery path.
------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_back_work_order(
  p_wo_id text,
  p_was_duplicate boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo            record;
  v_total_raw     numeric := 0;
  v_total_waste   numeric := 0;
  v_produce_id    integer;
  v_produce_qty   numeric := 0;
  v_results       jsonb[] := '{}';
  v_mat           record;
BEGIN
  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '%', jsonb_build_object('code', 'NOT_FOUND', 'detail', format('WO %s not found', p_wo_id))::text
      USING ERRCODE = 'P0002';
  END IF;

  -- Aggregate ISSUE/WASTE costs
  SELECT
    COALESCE(SUM(CASE WHEN m.type = 'ISSUE' THEN ABS(m.total_value) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.type = 'WASTE' THEN ABS(m.total_value) ELSE 0 END), 0)
  INTO v_total_raw, v_total_waste
  FROM public.movements m
  WHERE m.work_order_id = p_wo_id
    AND m.deleted_at IS NULL
    AND m.type IN ('ISSUE', 'WASTE');

  -- PRODUCE movement
  SELECT id, quantity INTO v_produce_id, v_produce_qty
  FROM public.movements
  WHERE work_order_id = p_wo_id AND type = 'PRODUCE' AND deleted_at IS NULL
  LIMIT 1;

  -- Per-material rows for material_consumptions array
  FOR v_mat IN
    SELECT
      m.sku_id,
      ABS(m.quantity)  AS qty,
      m.type::text      AS type,
      m.id             AS movement_id,
      ABS(m.total_value) AS fifo_cost
    FROM public.movements m
    WHERE m.work_order_id = p_wo_id
      AND m.deleted_at IS NULL
      AND m.type IN ('ISSUE', 'WASTE')
    ORDER BY m.id
  LOOP
    v_results := v_results || jsonb_build_object(
      'sku_id',      v_mat.sku_id,
      'quantity',    v_mat.qty,
      'type',        v_mat.type,
      'movement_id', v_mat.movement_id,
      'fifo_cost',   v_mat.fifo_cost,
      'consumption', null
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success',                true,
    'was_duplicate',          p_was_duplicate,
    'work_order_id',          p_wo_id,
    'produce_movement_id',    v_produce_id,
    'total_raw_cost',         v_total_raw,
    'total_waste_cost',       v_total_waste,
    'net_produce_cost',       (v_total_raw - v_total_waste),
    'produce_unit_cost',      CASE WHEN v_produce_qty > 0 THEN (v_total_raw - v_total_waste) / v_produce_qty ELSE 0 END,
    'material_consumptions',  v_results
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.read_back_work_order(text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(
  text, numeric, text, work_order_mode, text, text, text, jsonb, date, uuid
) TO anon, authenticated;

COMMIT;
