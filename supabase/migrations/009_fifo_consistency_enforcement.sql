-- 009_fifo_consistency_enforcement.sql
-- Automatic FIFO consistency enforcement through constraints, triggers and transactional RPCs

BEGIN;

-- =====================================================
-- 1. CONSTRAINTS FOR DATA INTEGRITY
-- =====================================================

-- Ensure layer consumptions never exceed layer remaining quantity
CREATE OR REPLACE FUNCTION validate_layer_consumption()
RETURNS TRIGGER AS $$
DECLARE
  v_remaining numeric;
  v_total_consumed numeric;
BEGIN
  -- Get current remaining quantity for the layer
  SELECT remaining_quantity INTO v_remaining
  FROM public.fifo_layers
  WHERE id = NEW.layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', NEW.layer_id USING ERRCODE = 'P0002';
  END IF;
  
  -- Calculate total consumed including this new consumption
  SELECT COALESCE(SUM(quantity_consumed), 0) + NEW.quantity_consumed
  INTO v_total_consumed
  FROM public.layer_consumptions
  WHERE layer_id = NEW.layer_id;
  
  -- Check if total consumption would exceed original quantity
  IF v_total_consumed > (SELECT original_quantity FROM public.fifo_layers WHERE id = NEW.layer_id) THEN
    RAISE EXCEPTION 'Total consumption (%) would exceed layer original quantity for layer %', 
      v_total_consumed, NEW.layer_id USING ERRCODE = '23514';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure idempotent trigger creation
DROP TRIGGER IF EXISTS trigger_validate_layer_consumption ON public.layer_consumptions;
CREATE TRIGGER trigger_validate_layer_consumption
  BEFORE INSERT OR UPDATE ON public.layer_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION validate_layer_consumption();

-- =====================================================
-- 2. TRANSACTIONAL RECEIVING OPERATION
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_receiving_transaction(
  p_sku_id text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_receiving_date date DEFAULT CURRENT_DATE,
  p_vendor_id text DEFAULT NULL,
  p_packing_slip_no text DEFAULT NULL,
  p_reference text DEFAULT 'RECEIVE',
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement_id integer;
  v_layer_id text;
  v_total_value numeric;
BEGIN
  -- Validate inputs
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive: %', p_quantity USING ERRCODE = '23514';
  END IF;
  
  IF p_unit_cost <= 0 THEN
    RAISE EXCEPTION 'Unit cost must be positive: %', p_unit_cost USING ERRCODE = '23514';
  END IF;
  
  -- Check if SKU exists
  IF NOT EXISTS (SELECT 1 FROM public.skus WHERE id = p_sku_id) THEN
    RAISE EXCEPTION 'SKU not found: %', p_sku_id USING ERRCODE = 'P0002';
  END IF;
  
  v_total_value := p_quantity * p_unit_cost;
  
  -- Create movement record
  INSERT INTO public.movements (
    datetime, type, sku_id, quantity, unit_cost, total_value, reference, notes
  ) VALUES (
    NOW(), 'RECEIVE', p_sku_id, p_quantity, p_unit_cost, v_total_value, p_reference, p_notes
  ) RETURNING id INTO v_movement_id;
  
  -- Generate unique layer ID
  v_layer_id := p_sku_id || '-L' || EXTRACT(EPOCH FROM NOW())::bigint;
  
  -- Create FIFO layer
  INSERT INTO public.fifo_layers (
    id, sku_id, receiving_date, original_quantity, remaining_quantity, 
    unit_cost, vendor_id, packing_slip_no, status, created_by_movement_id
  ) VALUES (
    v_layer_id, p_sku_id, p_receiving_date, p_quantity, p_quantity,
    p_unit_cost, p_vendor_id, p_packing_slip_no, 'ACTIVE', v_movement_id
  );
  
  -- Update SKU on_hand (trigger handles this, but explicit for clarity)
  UPDATE public.skus 
  SET on_hand = on_hand + p_quantity, updated_at = NOW()
  WHERE id = p_sku_id;
  
  -- Return transaction summary
  RETURN jsonb_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'layer_id', v_layer_id,
    'quantity', p_quantity,
    'total_value', v_total_value
  );
END;
$$;

-- =====================================================
-- 3. ENHANCED FIFO CONSUMPTION WITH VALIDATION
-- =====================================================

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
  v_current_on_hand numeric;
BEGIN
  -- Pre-validation: check available stock
  SELECT on_hand INTO v_current_on_hand
  FROM public.skus
  WHERE id = p_sku_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU not found: %', p_sku_id USING ERRCODE = 'P0002';
  END IF;
  
  IF v_current_on_hand < p_quantity_needed THEN
    RAISE EXCEPTION 'Insufficient stock. Available: %, Needed: %', 
      v_current_on_hand, p_quantity_needed USING ERRCODE = '23514';
  END IF;
  
  -- Process layers in FIFO order
  FOR v_layer IN
    SELECT id, remaining_quantity, unit_cost
    FROM public.fifo_layers
    WHERE sku_id = p_sku_id 
      AND status = 'ACTIVE' 
      AND remaining_quantity > 0
    ORDER BY receiving_date, created_at
  LOOP
    DECLARE
      v_consume_qty numeric;
      v_consume_cost numeric;
    BEGIN
      -- Calculate consumption for this layer
      v_consume_qty := LEAST(v_remaining_needed, v_layer.remaining_quantity);
      v_consume_cost := v_consume_qty * v_layer.unit_cost;
      
      -- Record consumption
      INSERT INTO public.layer_consumptions (
        movement_id, layer_id, quantity_consumed, unit_cost, total_cost
      ) VALUES (
        p_movement_id, v_layer.id, v_consume_qty, v_layer.unit_cost, v_consume_cost
      );
      
      -- Update layer quantity with bounds checking
      PERFORM public.update_layer_quantity(v_layer.id, -v_consume_qty);
      
      -- Track consumption
      v_total_cost := v_total_cost + v_consume_cost;
      v_consumptions := v_consumptions || jsonb_build_object(
        'layer_id', v_layer.id,
        'quantity', v_consume_qty,
        'cost', v_consume_cost
      );
      
      -- Update remaining needed
      v_remaining_needed := v_remaining_needed - v_consume_qty;
      
      -- Exit if fully consumed
      IF v_remaining_needed <= 0 THEN
        EXIT;
      END IF;
    END;
  END LOOP;
  
  -- Final validation
  IF v_remaining_needed > 0 THEN
    RAISE EXCEPTION 'Could not consume full quantity. Remaining: %', v_remaining_needed USING ERRCODE = '23514';
  END IF;
  
  -- Update SKU on_hand
  PERFORM public.update_sku_quantity(p_sku_id, -p_quantity_needed);
  
  -- Return consumption summary
  RETURN jsonb_build_object(
    'success', true,
    'total_consumed', p_quantity_needed,
    'total_cost', v_total_cost,
    'consumptions', v_consumptions
  );
END;
$$;

-- =====================================================
-- 4. TRANSACTIONAL WORK ORDER OPERATION
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name text,
  p_output_quantity numeric,
  p_output_unit text DEFAULT 'unit',
  p_mode work_order_mode DEFAULT 'AUTO',
  p_client_name text DEFAULT NULL,
  p_invoice_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_materials jsonb DEFAULT '[]'::jsonb -- [{"sku_id": "SKU-001", "quantity": 10}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id text;
  v_produce_movement_id integer;
  v_issue_movement_id integer;
  v_material record;
  v_total_cost numeric := 0;
  v_consumption_result jsonb;
  v_results jsonb[] := '{}';
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
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric)
  LOOP
    -- Create ISSUE movement
    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value, 
      reference, work_order_id, notes
    ) VALUES (
      NOW(), 'ISSUE', v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id, 'Material consumption'
    ) RETURNING id INTO v_issue_movement_id;
    
    -- Execute FIFO consumption with validation
    SELECT public.execute_fifo_consumption_validated(
      v_material.sku_id, v_material.quantity, v_issue_movement_id
    ) INTO v_consumption_result;
    
    -- Update movement total_value with actual FIFO cost
    UPDATE public.movements
    SET total_value = -(v_consumption_result->>'total_cost')::numeric
    WHERE id = v_issue_movement_id;
    
    -- Track total cost
    v_total_cost := v_total_cost + (v_consumption_result->>'total_cost')::numeric;
    
    -- Track results
    v_results := v_results || jsonb_build_object(
      'sku_id', v_material.sku_id,
      'quantity', v_material.quantity,
      'movement_id', v_issue_movement_id,
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

-- =====================================================
-- 5. CONSISTENCY CHECK FUNCTION
-- =====================================================

-- Ensure old signature is removed before (re)creating
DROP FUNCTION IF EXISTS public.validate_fifo_consistency();
CREATE OR REPLACE FUNCTION public.validate_fifo_consistency()
RETURNS TABLE(
  sku_id text,
  on_hand_vs_layers numeric,
  fifo_invariant numeric,
  movements_vs_onhand numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH mov AS (
    SELECT
      m.sku_id,
      SUM(CASE WHEN m.type = 'RECEIVE' THEN m.quantity ELSE 0 END) AS qty_in,
      SUM(CASE WHEN m.type IN ('ISSUE','WASTE','TRANSFER','ADJUSTMENT') THEN ABS(m.quantity) ELSE 0 END) AS qty_out
    FROM public.movements m
    WHERE m.sku_id IS NOT NULL
    GROUP BY m.sku_id
  ),
  lay AS (
    SELECT
      fl.sku_id,
      SUM(fl.original_quantity) AS layers_original,
      SUM(fl.remaining_quantity) AS layers_remaining
    FROM public.fifo_layers fl
    GROUP BY fl.sku_id
  ),
  cons AS (
    SELECT
      fl.sku_id,
      SUM(lc.quantity_consumed) AS consumed_total
    FROM public.layer_consumptions lc
    JOIN public.fifo_layers fl ON fl.id = lc.layer_id
    GROUP BY fl.sku_id
  )
  SELECT
    s.id,
    (COALESCE(l.layers_remaining,0) - s.on_hand) AS on_hand_vs_layers,
    (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) AS fifo_invariant,
    ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - s.on_hand) AS movements_vs_onhand,
    CASE 
      WHEN (COALESCE(l.layers_remaining,0) - s.on_hand) = 0 
       AND (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) = 0
       AND ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - s.on_hand) = 0
      THEN 'CONSISTENT'
      ELSE 'INCONSISTENT'
    END AS status
  FROM public.skus s
  LEFT JOIN lay l ON l.sku_id = s.id
  LEFT JOIN cons c ON c.sku_id = s.id
  LEFT JOIN mov m ON m.sku_id = s.id
  ORDER BY s.id;
END;
$$;

-- =====================================================
-- 6. GRANTS
-- =====================================================

GRANT EXECUTE ON FUNCTION public.create_receiving_transaction(text, numeric, numeric, date, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_fifo_consumption_validated(text, numeric, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fifo_consistency() TO anon, authenticated;

COMMIT;
