-- Transaction management functions for Supabase
-- These functions provide transaction control for complex operations

-- Begin transaction function
CREATE OR REPLACE FUNCTION begin_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Commit transaction function
CREATE OR REPLACE FUNCTION commit_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Rollback transaction function
CREATE OR REPLACE FUNCTION rollback_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Function to get inventory summary with calculated fields
CREATE OR REPLACE FUNCTION get_inventory_summary()
RETURNS TABLE (
  id text,
  description text,
  type text,
  product_category text,
  unit text,
  active boolean,
  min_stock numeric,
  on_hand numeric,
  status text,
  current_avg_cost numeric,
  active_layers integer
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id,
    s.description,
    s.type,
    s.product_category,
    s.unit,
    s.active,
    s.min_stock,
    s.on_hand,
    CASE 
      WHEN s.on_hand < s.min_stock THEN 'BELOW_MIN'
      WHEN s.on_hand > (s.min_stock * 3) THEN 'OVERSTOCK'
      ELSE 'OK'
    END as status,
    COALESCE(
      (SELECT AVG(fl.unit_cost) 
       FROM fifo_layers fl 
       WHERE fl.sku_id = s.id 
         AND fl.status = 'ACTIVE' 
         AND fl.remaining_quantity > 0), 
      0
    ) as current_avg_cost,
    COALESCE(
      (SELECT COUNT(*) 
       FROM fifo_layers fl 
       WHERE fl.sku_id = s.id 
         AND fl.status = 'ACTIVE' 
         AND fl.remaining_quantity > 0), 
      0
    )::integer as active_layers
  FROM skus s
  WHERE s.active = true
  ORDER BY s.id;
END;
$$;

-- Function to validate SKU availability for consumption
CREATE OR REPLACE FUNCTION check_sku_availability(
  p_sku_id text,
  p_required_qty numeric
)
RETURNS TABLE (
  available_qty numeric,
  can_fulfill boolean,
  shortage_qty numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_available numeric;
BEGIN
  -- Get total available quantity from active layers
  SELECT COALESCE(SUM(remaining_quantity), 0)
  INTO v_available
  FROM fifo_layers
  WHERE sku_id = p_sku_id
    AND status = 'ACTIVE'
    AND remaining_quantity > 0;
  
  RETURN QUERY
  SELECT 
    v_available as available_qty,
    (v_available >= p_required_qty) as can_fulfill,
    GREATEST(p_required_qty - v_available, 0) as shortage_qty;
END;
$$;

-- Function to get FIFO consumption plan
CREATE OR REPLACE FUNCTION get_fifo_plan(
  p_sku_id text,
  p_required_qty numeric
)
RETURNS TABLE (
  layer_id text,
  consume_qty numeric,
  unit_cost numeric,
  total_cost numeric,
  remaining_after numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_remaining_qty numeric := p_required_qty;
  v_layer_record RECORD;
BEGIN
  -- Loop through layers in FIFO order
  FOR v_layer_record IN
    SELECT id, remaining_quantity, unit_cost
    FROM fifo_layers
    WHERE sku_id = p_sku_id
      AND status = 'ACTIVE'
      AND remaining_quantity > 0
    ORDER BY receiving_date ASC, created_at ASC
  LOOP
    -- Exit if we've consumed enough
    IF v_remaining_qty <= 0 THEN
      EXIT;
    END IF;
    
    -- Calculate consumption for this layer
    DECLARE
      v_consume_qty numeric := LEAST(v_remaining_qty, v_layer_record.remaining_quantity);
    BEGIN
      RETURN QUERY
      SELECT 
        v_layer_record.id as layer_id,
        v_consume_qty as consume_qty,
        v_layer_record.unit_cost as unit_cost,
        (v_consume_qty * v_layer_record.unit_cost) as total_cost,
        (v_layer_record.remaining_quantity - v_consume_qty) as remaining_after;
      
      v_remaining_qty := v_remaining_qty - v_consume_qty;
    END;
  END LOOP;
END;
$$;

-- Function to update SKU on_hand quantity efficiently
CREATE OR REPLACE FUNCTION update_sku_quantity(
  p_sku_id text,
  p_quantity_change numeric
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_quantity numeric;
BEGIN
  UPDATE skus 
  SET 
    on_hand = on_hand + p_quantity_change,
    updated_at = NOW()
  WHERE id = p_sku_id
  RETURNING on_hand INTO v_new_quantity;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU not found: %', p_sku_id;
  END IF;
  
  RETURN v_new_quantity;
END;
$$;

-- Function to create movement with automatic ID generation
CREATE OR REPLACE FUNCTION create_movement(
  p_type text,
  p_sku_id text,
  p_quantity numeric,
  p_unit_cost numeric DEFAULT NULL,
  p_total_cost numeric DEFAULT NULL,
  p_movement_date date DEFAULT CURRENT_DATE,
  p_vendor_id text DEFAULT NULL,
  p_reference_doc text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_movement_id integer;
BEGIN
  INSERT INTO movements (
    type,
    sku_id,
    quantity,
    unit_cost,
    total_cost,
    movement_date,
    vendor_id,
    reference_doc,
    notes
  ) VALUES (
    p_type,
    p_sku_id,
    p_quantity,
    p_unit_cost,
    p_total_cost,
    p_movement_date,
    p_vendor_id,
    p_reference_doc,
    p_notes
  )
  RETURNING id INTO v_movement_id;
  
  RETURN v_movement_id;
END;
$$;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION begin_transaction() TO authenticated;
GRANT EXECUTE ON FUNCTION commit_transaction() TO authenticated;
GRANT EXECUTE ON FUNCTION rollback_transaction() TO authenticated;
GRANT EXECUTE ON FUNCTION get_inventory_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION check_sku_availability(text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION get_fifo_plan(text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION update_sku_quantity(text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION create_movement(text, text, numeric, numeric, numeric, date, text, text, text) TO authenticated;
