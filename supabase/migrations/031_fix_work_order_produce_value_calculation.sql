-- Migration: Fix Work Order PRODUCE Value Calculation
-- Problem: PRODUCE value incorrectly includes WASTE cost
-- Solution: PRODUCE = Total RAW cost - Total WASTE cost
-- WASTE movements get their own FIFO-based cost
-- Created: 2025-08-21

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
  v_total_raw_cost numeric := 0;    -- Track RAW costs separately
  v_total_waste_cost numeric := 0;  -- Track WASTE costs separately
  v_net_produce_cost numeric := 0;  -- PRODUCE cost = RAW - WASTE
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

    -- Create ISSUE/WASTE movement (placeholder values, will be updated after FIFO)
    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      NOW(), v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id, 
      CASE WHEN v_movement_type = 'WASTE' THEN 'Waste consumption' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    -- Execute FIFO consumption with correct movement_id
    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_consume_movement_id
    ) INTO v_consumption_result;

    -- Update movement with actual FIFO costs
    UPDATE public.movements
    SET unit_cost = CASE WHEN v_material.quantity > 0 THEN (v_consumption_result->>'total_cost')::numeric / v_material.quantity ELSE 0 END,
        total_value = -((v_consumption_result->>'total_cost')::numeric)
    WHERE id = v_consume_movement_id;

    -- Track costs by type
    IF v_movement_type = 'WASTE' THEN
      v_total_waste_cost := v_total_waste_cost + (v_consumption_result->>'total_cost')::numeric;
    ELSE
      -- ISSUE or other RAW material consumption
      v_total_raw_cost := v_total_raw_cost + (v_consumption_result->>'total_cost')::numeric;
    END IF;

    -- Track results
    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'fifo_cost', (v_consumption_result->>'total_cost')::numeric,
      'consumption', v_consumption_result
    );
  END LOOP;

  -- Calculate net produce cost: RAW cost minus WASTE cost
  v_net_produce_cost := v_total_raw_cost - v_total_waste_cost;

  -- Create PRODUCE movement with corrected value
  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    NOW(), 'PRODUCE', p_output_name, p_output_quantity,
    -- Unit cost = Net produce cost / quantity
    CASE WHEN p_output_quantity > 0 THEN v_net_produce_cost / p_output_quantity ELSE 0 END,
    -- Total value = Net produce cost (RAW - WASTE)
    v_net_produce_cost, 
    v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

  -- Update work order with corrected total cost (net produce cost)
  UPDATE public.work_orders
  SET total_cost = v_net_produce_cost, completed_at = NOW()
  WHERE id = v_work_order_id;

  -- Return transaction summary with detailed cost breakdown
  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', v_work_order_id,
    'produce_movement_id', v_produce_movement_id,
    'total_raw_cost', v_total_raw_cost,
    'total_waste_cost', v_total_waste_cost,
    'net_produce_cost', v_net_produce_cost,
    'produce_unit_cost', CASE WHEN p_output_quantity > 0 THEN v_net_produce_cost / p_output_quantity ELSE 0 END,
    'material_consumptions', v_results
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;

COMMIT;