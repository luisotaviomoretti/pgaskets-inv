-- 040_add_work_order_date_to_rpc.sql
-- Add p_work_order_date parameter to create_work_order_transaction RPC
-- and use it for work_order_date column + movement datetime

BEGIN;

-- Backfill existing rows: set work_order_date from created_at where NULL
UPDATE public.work_orders
SET work_order_date = (created_at AT TIME ZONE 'UTC')::date
WHERE work_order_date IS NULL;

-- Set default so future inserts without the param still get a value
ALTER TABLE public.work_orders
  ALTER COLUMN work_order_date SET DEFAULT CURRENT_DATE;

-- Recreate the RPC with the new p_work_order_date parameter
CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name text,
  p_output_quantity numeric,
  p_output_unit text DEFAULT 'unit',
  p_mode work_order_mode DEFAULT 'AUTO',
  p_client_name text DEFAULT NULL,
  p_invoice_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_materials jsonb DEFAULT '[]'::jsonb,
  p_work_order_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id       text;
  v_produce_movement_id integer;
  v_consume_movement_id integer;
  v_material            record;
  v_total_raw_cost      numeric := 0;
  v_total_waste_cost    numeric := 0;
  v_net_produce_cost    numeric := 0;
  v_consumption_result  jsonb;
  v_results             jsonb[] := '{}';
  v_movement_type       movement_type;
  v_wo_timestamp        timestamptz;
BEGIN
  IF p_output_quantity <= 0 THEN
    RAISE EXCEPTION 'Output quantity must be positive: %', p_output_quantity USING ERRCODE = '23514';
  END IF;

  -- Use the provided date at noon UTC as the timestamp for movements
  v_wo_timestamp := (p_work_order_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC';

  -- Generate WO ID
  v_work_order_id := 'WO-' || EXTRACT(EPOCH FROM NOW())::bigint;

  -- Create work order with user-provided date
  INSERT INTO public.work_orders (
    id, output_name, output_quantity, output_unit, mode,
    client_name, invoice_no, notes, status, created_at, work_order_date
  ) VALUES (
    v_work_order_id, p_output_name, p_output_quantity, p_output_unit, p_mode,
    p_client_name, p_invoice_no, p_notes, 'COMPLETED', NOW(), p_work_order_date
  );

  -- Process each material consumption (ISSUE/WASTE) with real FIFO
  FOR v_material IN
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
  LOOP
    v_movement_type := COALESCE(NULLIF(TRIM(UPPER(v_material.type)), ''), 'ISSUE')::movement_type;

    -- Insert movement placeholder with user-provided date
    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      v_wo_timestamp, v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id,
      CASE WHEN v_movement_type = 'WASTE' THEN 'Waste consumption' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    -- Validated FIFO consumption
    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_consume_movement_id
    ) INTO v_consumption_result;

    -- Update movement with real FIFO cost
    UPDATE public.movements
    SET unit_cost  = CASE WHEN v_material.quantity > 0 THEN (v_consumption_result->>'total_cost')::numeric / v_material.quantity ELSE 0 END,
        total_value = -((v_consumption_result->>'total_cost')::numeric)
    WHERE id = v_consume_movement_id;

    -- Accumulate by type
    IF v_movement_type = 'WASTE' THEN
      v_total_waste_cost := v_total_waste_cost + (v_consumption_result->>'total_cost')::numeric;
    ELSE
      v_total_raw_cost := v_total_raw_cost + (v_consumption_result->>'total_cost')::numeric;
    END IF;

    -- Track details
    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'fifo_cost', (v_consumption_result->>'total_cost')::numeric,
      'consumption', v_consumption_result
    );
  END LOOP;

  -- Net production cost
  v_net_produce_cost := v_total_raw_cost - v_total_waste_cost;

  -- Insert PRODUCE (COGS) with net cost and user-provided date
  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    v_wo_timestamp, 'PRODUCE', p_output_name, p_output_quantity,
    CASE WHEN p_output_quantity > 0 THEN v_net_produce_cost / p_output_quantity ELSE 0 END,
    v_net_produce_cost,
    v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

  -- Update WO cost
  UPDATE public.work_orders
  SET total_cost = v_net_produce_cost, completed_at = NOW()
  WHERE id = v_work_order_id;

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

-- Update grants to include the new signature
GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb, date) TO anon, authenticated;

COMMIT;
