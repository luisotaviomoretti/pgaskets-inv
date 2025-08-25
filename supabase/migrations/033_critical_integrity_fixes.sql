-- 033_critical_integrity_fixes.sql
-- CRITICAL: Comprehensive fix for Work Order calculation integrity
-- 
-- PROBLEMS IDENTIFIED:
-- 1. Migration 032 not applied - FIFO validation still broken
-- 2. Migration 031 not applied - PRODUCE calculation incorrect  
-- 3. Movement costs not updated from FIFO calculations
-- 4. No integrity validations between layer_consumptions and movements
--
-- SOLUTIONS:
-- 1. Apply corrected validate_layer_consumption() function
-- 2. Apply corrected create_work_order_transaction() function
-- 3. Add integrity checks and constraints
-- 4. Add data validation functions

BEGIN;

-- =====================================================
-- 1. CRITICAL FIFO VALIDATION FIX (from 032)
-- =====================================================

CREATE OR REPLACE FUNCTION validate_layer_consumption()
RETURNS TRIGGER AS $$
DECLARE
  v_remaining numeric;
BEGIN
  -- Get current remaining quantity for the layer
  SELECT remaining_quantity INTO v_remaining
  FROM public.fifo_layers
  WHERE id = NEW.layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', NEW.layer_id USING ERRCODE = 'P0002';
  END IF;
  
  -- FIXED LOGIC: Check if new consumption exceeds remaining quantity
  -- This is the correct validation - we only care about remaining, not historical
  IF NEW.quantity_consumed > v_remaining THEN
    RAISE EXCEPTION 'Consumption (%) would exceed layer remaining quantity (%) for layer %', 
      NEW.quantity_consumed, v_remaining, NEW.layer_id USING ERRCODE = '23514';
  END IF;
  
  -- Additional safety check: ensure consumption is positive
  IF NEW.quantity_consumed <= 0 THEN
    RAISE EXCEPTION 'Consumption quantity must be positive: %', NEW.quantity_consumed USING ERRCODE = '23514';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 2. CORRECTED WORK ORDER TRANSACTION (from 031)
-- =====================================================

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
  v_calculated_cost numeric;
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

    -- CRITICAL: Get the actual FIFO cost from the result
    v_calculated_cost := (v_consumption_result->>'total_cost')::numeric;

    -- Update movement with actual FIFO costs (CRITICAL FIX)
    UPDATE public.movements
    SET unit_cost = CASE 
                     WHEN v_material.quantity > 0 THEN v_calculated_cost / v_material.quantity 
                     ELSE 0 
                   END,
        total_value = -v_calculated_cost  -- Negative because it's consumption
    WHERE id = v_consume_movement_id;

    -- Track costs by type
    IF v_movement_type = 'WASTE' THEN
      v_total_waste_cost := v_total_waste_cost + v_calculated_cost;
    ELSE
      -- ISSUE or other RAW material consumption
      v_total_raw_cost := v_total_raw_cost + v_calculated_cost;
    END IF;

    -- Track results
    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'type', v_movement_type,
      'movement_id', v_consume_movement_id,
      'fifo_cost', v_calculated_cost,
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

  -- INTEGRITY CHECK: Validate that movements match layer consumptions
  PERFORM public.validate_work_order_integrity(v_work_order_id);

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

-- =====================================================
-- 3. INTEGRITY VALIDATION FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION public.validate_work_order_integrity(p_work_order_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement record;
  v_layer_consumptions_total numeric;
  v_movement_total numeric;
  v_tolerance numeric := 0.01; -- Allow 1 cent tolerance for rounding
BEGIN
  -- Check each ISSUE/WASTE movement against its layer consumptions
  FOR v_movement IN
    SELECT id, sku_id, type, total_value, quantity
    FROM public.movements
    WHERE work_order_id = p_work_order_id 
      AND type IN ('ISSUE', 'WASTE')
  LOOP
    -- Get total cost from layer consumptions for this movement
    SELECT COALESCE(SUM(total_cost), 0) INTO v_layer_consumptions_total
    FROM public.layer_consumptions
    WHERE movement_id = v_movement.id;
    
    -- Movement total_value should be negative of layer consumptions total
    v_movement_total := ABS(v_movement.total_value);
    
    IF ABS(v_movement_total - v_layer_consumptions_total) > v_tolerance THEN
      RAISE EXCEPTION 'Integrity violation in work order %: Movement % has total_value % but layer consumptions total %. SKU: %, Type: %',
        p_work_order_id, v_movement.id, v_movement_total, v_layer_consumptions_total, v_movement.sku_id, v_movement.type
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  
  RETURN true;
END;
$$;

-- =====================================================
-- 4. DATA CONSISTENCY REPAIR FUNCTION
-- =====================================================

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
  -- Fix ISSUE/WASTE movements that don't match their layer consumptions
  FOR v_movement IN
    SELECT id, type, quantity, total_value
    FROM public.movements
    WHERE work_order_id = p_work_order_id 
      AND type IN ('ISSUE', 'WASTE')
  LOOP
    -- Get the correct cost from layer consumptions
    SELECT COALESCE(SUM(total_cost), 0) INTO v_layer_cost
    FROM public.layer_consumptions
    WHERE movement_id = v_movement.id;
    
    -- Update movement with correct values
    UPDATE public.movements
    SET unit_cost = CASE 
                     WHEN ABS(v_movement.quantity) > 0 THEN v_layer_cost / ABS(v_movement.quantity)
                     ELSE 0 
                   END,
        total_value = -v_layer_cost  -- Negative for consumption
    WHERE id = v_movement.id
      AND ABS(ABS(total_value) - v_layer_cost) > 0.01; -- Only update if different
    
    IF FOUND THEN
      v_repairs_made := v_repairs_made + 1;
    END IF;
    
    v_produce_total := v_produce_total + v_layer_cost;
  END LOOP;
  
  -- Update PRODUCE movement with correct total
  UPDATE public.movements
  SET unit_cost = CASE WHEN quantity > 0 THEN v_produce_total / quantity ELSE 0 END,
      total_value = v_produce_total
  WHERE work_order_id = p_work_order_id 
    AND type = 'PRODUCE'
    AND ABS(total_value - v_produce_total) > 0.01; -- Only update if different
  
  IF FOUND THEN
    v_repairs_made := v_repairs_made + 1;
  END IF;
  
  -- Update work order total cost
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
-- 5. GRANTS AND PERMISSIONS
-- =====================================================

GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_work_order_integrity(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_work_order_costs(text) TO anon, authenticated;

-- =====================================================
-- 6. REPAIR EXISTING DATA (WO-1756124257)
-- =====================================================

-- Repair the problematic work order identified in the analysis
SELECT public.repair_work_order_costs('WO-1756124257');

-- =====================================================
-- 7. LOG THE FIX APPLICATION
-- =====================================================

INSERT INTO public.movements (
  datetime, type, product_name, quantity, unit_cost, total_value, reference, notes
) VALUES (
  NOW(), 'ADJUSTMENT', 'SYSTEM_INTEGRITY_FIX', 0, 0, 0, 'WO_INTEGRITY_FIX_033', 
  'Applied comprehensive work order integrity fixes: FIFO validation, cost calculation, and data repair functions.'
);

COMMIT;