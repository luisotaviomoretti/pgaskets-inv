-- apply_critical_fixes.sql
-- Execute this script to apply all critical integrity fixes
-- This is a consolidated version that can be run directly on the database

-- =====================================================
-- STEP 1: Apply Migration 033 (Critical Integrity Fixes)
-- =====================================================

-- FIFO Validation Fix
CREATE OR REPLACE FUNCTION validate_layer_consumption()
RETURNS TRIGGER AS $$
DECLARE
  v_remaining numeric;
BEGIN
  SELECT remaining_quantity INTO v_remaining
  FROM public.fifo_layers
  WHERE id = NEW.layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', NEW.layer_id USING ERRCODE = 'P0002';
  END IF;
  
  IF NEW.quantity_consumed > v_remaining THEN
    RAISE EXCEPTION 'Consumption (%) would exceed layer remaining quantity (%) for layer %', 
      NEW.quantity_consumed, v_remaining, NEW.layer_id USING ERRCODE = '23514';
  END IF;
  
  IF NEW.quantity_consumed <= 0 THEN
    RAISE EXCEPTION 'Consumption quantity must be positive: %', NEW.quantity_consumed USING ERRCODE = '23514';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Work Order Transaction Fix
CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name text,
  p_output_quantity numeric,
  p_output_unit text DEFAULT 'unit',
  p_mode work_order_mode DEFAULT 'AUTO',
  p_client_name text DEFAULT NULL,
  p_invoice_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_materials jsonb DEFAULT '[]'::jsonb
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
  v_total_raw_cost numeric := 0;
  v_total_waste_cost numeric := 0;
  v_net_produce_cost numeric := 0;
  v_consumption_result jsonb;
  v_results jsonb[] := '{}';
  v_movement_type movement_type;
  v_calculated_cost numeric;
BEGIN
  IF p_output_quantity <= 0 THEN
    RAISE EXCEPTION 'Output quantity must be positive: %', p_output_quantity USING ERRCODE = '23514';
  END IF;

  v_work_order_id := 'WO-' || EXTRACT(EPOCH FROM NOW())::bigint;

  INSERT INTO public.work_orders (
    id, output_name, output_quantity, output_unit, mode,
    client_name, invoice_no, notes, status, created_at
  ) VALUES (
    v_work_order_id, p_output_name, p_output_quantity, p_output_unit, p_mode,
    p_client_name, p_invoice_no, p_notes, 'COMPLETED', NOW()
  );

  FOR v_material IN
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
  LOOP
    v_movement_type := COALESCE(NULLIF(TRIM(UPPER(v_material.type)), ''), 'ISSUE')::movement_type;

    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      NOW(), v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id, 
      CASE WHEN v_movement_type = 'WASTE' THEN 'Waste consumption' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_consume_movement_id
    ) INTO v_consumption_result;

    v_calculated_cost := (v_consumption_result->>'total_cost')::numeric;

    UPDATE public.movements
    SET unit_cost = CASE 
                     WHEN v_material.quantity > 0 THEN v_calculated_cost / v_material.quantity 
                     ELSE 0 
                   END,
        total_value = -v_calculated_cost
    WHERE id = v_consume_movement_id;

    IF v_movement_type = 'WASTE' THEN
      v_total_waste_cost := v_total_waste_cost + v_calculated_cost;
    ELSE
      v_total_raw_cost := v_total_raw_cost + v_calculated_cost;
    END IF;

    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'fifo_cost', v_calculated_cost,
      'consumption', v_consumption_result
    );
  END LOOP;

  v_net_produce_cost := v_total_raw_cost - v_total_waste_cost;

  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    NOW(), 'PRODUCE', p_output_name, p_output_quantity,
    CASE WHEN p_output_quantity > 0 THEN v_net_produce_cost / p_output_quantity ELSE 0 END,
    v_net_produce_cost, 
    v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

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

-- Repair function for existing data
CREATE OR REPLACE FUNCTION public.repair_work_order_costs(p_work_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement record;
  v_layer_cost numeric;
  v_produce_total numeric := 0;
  v_repairs_made integer := 0;
BEGIN
  FOR v_movement IN
    SELECT id, type, quantity, total_value
    FROM public.movements
    WHERE work_order_id = p_work_order_id 
      AND type IN ('ISSUE', 'WASTE')
  LOOP
    SELECT COALESCE(SUM(total_cost), 0) INTO v_layer_cost
    FROM public.layer_consumptions
    WHERE movement_id = v_movement.id;
    
    UPDATE public.movements
    SET unit_cost = CASE 
                     WHEN ABS(v_movement.quantity) > 0 THEN v_layer_cost / ABS(v_movement.quantity)
                     ELSE 0 
                   END,
        total_value = -v_layer_cost
    WHERE id = v_movement.id
      AND ABS(ABS(total_value) - v_layer_cost) > 0.01;
    
    IF FOUND THEN
      v_repairs_made := v_repairs_made + 1;
    END IF;
    
    v_produce_total := v_produce_total + v_layer_cost;
  END LOOP;
  
  UPDATE public.movements
  SET unit_cost = CASE WHEN quantity > 0 THEN v_produce_total / quantity ELSE 0 END,
      total_value = v_produce_total
  WHERE work_order_id = p_work_order_id 
    AND type = 'PRODUCE'
    AND ABS(total_value - v_produce_total) > 0.01;
  
  IF FOUND THEN
    v_repairs_made := v_repairs_made + 1;
  END IF;
  
  UPDATE public.work_orders
  SET total_cost = v_produce_total
  WHERE id = p_work_order_id
    AND ABS(COALESCE(total_cost, 0) - v_produce_total) > 0.01;
    
  IF FOUND THEN
    v_repairs_made := v_repairs_made + 1;
  END IF;
  
  RETURN jsonb_build_object(
    'work_order_id', p_work_order_id,
    'repairs_made', v_repairs_made,
    'corrected_produce_total', v_produce_total
  );
END;
$$;

-- =====================================================
-- STEP 2: Repair the problematic Work Order
-- =====================================================

SELECT public.repair_work_order_costs('WO-1756124257');

-- =====================================================
-- STEP 3: Grant permissions
-- =====================================================

GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_work_order_costs(text) TO anon, authenticated;

-- =====================================================
-- STEP 4: Log the fix
-- =====================================================

INSERT INTO public.movements (
  datetime, type, product_name, quantity, unit_cost, total_value, reference, notes
) VALUES (
  NOW(), 'ADJUSTMENT', 'CRITICAL_INTEGRITY_FIXES', 0, 0, 0, 'CRITICAL_FIXES_APPLIED', 
  'Applied critical Work Order integrity fixes: FIFO validation corrected, cost calculations fixed, WO-1756124257 repaired.'
);