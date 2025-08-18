-- 012_update_work_order_transaction_waste.sql
-- Purpose: Allow create_work_order_transaction to record WASTE as WASTE (not ISSUE)
-- Changes:
-- - p_materials items now accept an optional "type" field ('ISSUE' | 'WASTE'), defaulting to 'ISSUE'
-- - During iteration, movements are inserted with the provided type
-- - FIFO consumption and costing remain the same

BEGIN;

CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name text,
  p_output_quantity numeric,
  p_output_unit text DEFAULT 'unit',
  p_mode work_order_mode DEFAULT 'AUTO',
  p_client_name text DEFAULT NULL,
  p_invoice_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_materials jsonb DEFAULT '[]'::jsonb -- [{"sku_id": "SKU-001", "quantity": 10, "type": "ISSUE"|"WASTE"}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id text;
  v_produce_movement_id integer;
  v_consume_movement_id integer;
  v_material record;
  v_total_cost numeric := 0;
  v_consumption_result jsonb;
  v_results jsonb[] := '{}';
  v_movement_type movement_type; -- enum type used by movements.type
BEGIN
  -- Validate inputs
  IF p_output_quantity <= 0 THEN
    RAISE EXCEPTION 'Output quantity must be positive: %', p_output_quantity USING ERRCODE = '23514';
  END IF;

  -- Generate work order ID
  v_work_order_id := 'WO-' || EXTRACT(EPOCH FROM NOW())::bigint;

  -- Create work order
  INSERT INTO public.work_orders (
    id, output_name, output_quantity, output_unit, mode,
    client_name, invoice_no, notes, status, created_at
  ) VALUES (
    v_work_order_id, p_output_name, p_output_quantity, p_output_unit, p_mode,
    p_client_name, p_invoice_no, p_notes, 'COMPLETED', NOW()
  );

  -- Process each material consumption
  FOR v_material IN
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
  LOOP
    -- Normalize/validate type (default ISSUE)
    v_movement_type := COALESCE(NULLIF(TRIM(UPPER(v_material.type)), ''), 'ISSUE')::movement_type;

    -- Create ISSUE/WASTE movement according to provided type
    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      NOW(), v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id, CASE WHEN v_movement_type = 'WASTE' THEN 'Waste consumption' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    -- Execute FIFO consumption with validation
    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_consume_movement_id
    ) INTO v_consumption_result;

    -- Update movement total_value with actual FIFO cost
    UPDATE public.movements
    SET total_value = -(v_consumption_result->>'total_cost')::numeric
    WHERE id = v_consume_movement_id;

    -- Track total cost (waste cost is included in total cost of the WO)
    v_total_cost := v_total_cost + (v_consumption_result->>'total_cost')::numeric;

    -- Track results
    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'consumption', v_consumption_result
    );
  END LOOP;

  -- Create PRODUCE movement (output)
  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    NOW(), 'PRODUCE', p_output_name, p_output_quantity,
    CASE WHEN p_output_quantity > 0 THEN v_total_cost / p_output_quantity ELSE 0 END,
    v_total_cost, v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

  -- Update work order total cost
  UPDATE public.work_orders
  SET total_cost = v_total_cost, completed_at = NOW()
  WHERE id = v_work_order_id;

  -- Return transaction summary
  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', v_work_order_id,
    'produce_movement_id', v_produce_movement_id,
    'total_cost', v_total_cost,
    'material_consumptions', v_results
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;

COMMIT;
