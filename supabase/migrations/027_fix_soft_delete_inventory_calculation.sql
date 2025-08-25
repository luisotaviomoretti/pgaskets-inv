-- Migration: Fix Soft Delete Inventory Calculation
-- This migration fixes inventory calculation to respect soft deleted movements
-- Created: 2025-08-20

-- 1) Update inventory_summary view to exclude soft deleted movements
DROP VIEW IF EXISTS public.inventory_summary;
CREATE OR REPLACE VIEW public.inventory_summary AS
SELECT
  s.id,
  s.description,
  s.type,
  s.product_category,
  s.unit,
  -- on_hand derived from layers with remaining_quantity > 0
  -- AND from movements that are NOT soft deleted
  COALESCE(
    SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 
    0
  )::numeric as on_hand,
  s.reserved,
  s.min_stock,
  s.max_stock,
  s.active,
  -- Status computed against derived on_hand
  CASE 
    WHEN COALESCE(
      SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 
      0
    ) <= s.min_stock THEN 'BELOW_MIN'
    WHEN s.max_stock IS NOT NULL 
         AND COALESCE(
           SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 
           0
         ) >= s.max_stock THEN 'OVERSTOCK'
    ELSE 'OK'
  END as status,
  -- Weighted average cost of remaining layers (fallback to s.average_cost if no layers)
  COALESCE(
    SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity * fl.unit_cost END)
      / NULLIF(SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity END), 0),
    s.average_cost,
    0
  ) as current_avg_cost,
  COUNT(fl.id) FILTER (WHERE fl.remaining_quantity > 0) as active_layers
FROM public.skus s
LEFT JOIN public.fifo_layers fl ON fl.sku_id = s.id
-- Only include layers that are NOT linked to soft deleted movements
WHERE fl.id IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.layer_consumptions lc
  JOIN public.movements m ON lc.movement_id = m.id
  WHERE lc.layer_id = fl.id AND m.deleted_at IS NOT NULL
)
GROUP BY s.id, s.description, s.type, s.product_category, s.unit, 
         s.reserved, s.min_stock, s.max_stock, s.active, s.average_cost;

-- Grant permissions
GRANT SELECT ON public.inventory_summary TO anon, authenticated, service_role;

-- 2) Create function to clean up orphaned layer_consumptions from soft deleted movements
CREATE OR REPLACE FUNCTION cleanup_soft_deleted_layer_consumptions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count integer := 0;
  v_restored_layers jsonb := '[]';
  v_consumption record;
  v_layer_info jsonb;
BEGIN
  -- Find and process all layer_consumptions linked to soft deleted movements
  FOR v_consumption IN
    SELECT lc.*, m.type as movement_type, m.sku_id as movement_sku_id, m.reference
    FROM layer_consumptions lc
    JOIN movements m ON lc.movement_id = m.id
    WHERE m.deleted_at IS NOT NULL
  LOOP
    -- Restore the consumed quantity back to the layer
    UPDATE fifo_layers 
    SET 
      remaining_quantity = remaining_quantity + v_consumption.quantity_consumed,
      status = CASE 
        WHEN remaining_quantity + v_consumption.quantity_consumed > 0 THEN 'ACTIVE'
        ELSE status 
      END,
      updated_at = NOW()
    WHERE id = v_consumption.layer_id;
    
    -- Track restored layer info
    SELECT jsonb_build_object(
      'layer_id', id,
      'restored_quantity', v_consumption.quantity_consumed,
      'new_remaining', remaining_quantity,
      'movement_id', v_consumption.movement_id,
      'movement_type', v_consumption.movement_type
    ) INTO v_layer_info
    FROM fifo_layers 
    WHERE id = v_consumption.layer_id;
    
    v_restored_layers := v_restored_layers || v_layer_info;
    
    -- Delete the consumption record
    DELETE FROM layer_consumptions WHERE id = v_consumption.id;
    v_deleted_count := v_deleted_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'cleaned_consumptions', v_deleted_count,
    'restored_layers', v_restored_layers
  );
END;
$$;

-- 3) Create function to fix SKU sync for soft deleted movements
CREATE OR REPLACE FUNCTION fix_sku_sync_for_soft_deleted()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sku record;
  v_results jsonb := '[]';
  v_sku_result jsonb;
  v_fixed_count integer := 0;
BEGIN
  -- Process each SKU that has soft deleted movements
  FOR v_sku IN
    SELECT DISTINCT s.id, s.on_hand
    FROM skus s
    JOIN movements m ON m.sku_id = s.id
    WHERE m.deleted_at IS NOT NULL
  LOOP
    -- Sync this SKU from layers
    PERFORM public.sync_sku_on_hand_from_layers(v_sku.id);
    
    -- Get the new value
    SELECT jsonb_build_object(
      'sku_id', s.id,
      'old_on_hand', v_sku.on_hand,
      'new_on_hand', s.on_hand,
      'was_changed', v_sku.on_hand != s.on_hand
    ) INTO v_sku_result
    FROM skus s
    WHERE s.id = v_sku.id;
    
    v_results := v_results || v_sku_result;
    
    IF v_sku.on_hand != (v_sku_result->>'new_on_hand')::numeric THEN
      v_fixed_count := v_fixed_count + 1;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'processed_skus', jsonb_array_length(v_results),
    'fixed_skus', v_fixed_count,
    'sku_details', v_results
  );
END;
$$;

-- 4) Create comprehensive repair function for Work Order WO-1755731928
CREATE OR REPLACE FUNCTION repair_work_order_wo_1755731928()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cleanup_result jsonb;
  v_sync_result jsonb;
  v_final_state jsonb;
BEGIN
  -- Step 1: Clean up orphaned layer_consumptions
  SELECT cleanup_soft_deleted_layer_consumptions() INTO v_cleanup_result;
  
  -- Step 2: Fix SKU synchronization
  SELECT fix_sku_sync_for_soft_deleted() INTO v_sync_result;
  
  -- Step 3: Get final state of SKU-001
  SELECT jsonb_build_object(
    'sku_id', 'SKU-001',
    'final_on_hand', on_hand,
    'layer_total', (
      SELECT COALESCE(SUM(remaining_quantity), 0)
      FROM fifo_layers 
      WHERE sku_id = 'SKU-001' AND remaining_quantity > 0
    ),
    'movements_active', (
      SELECT COUNT(*) FROM movements 
      WHERE sku_id = 'SKU-001' AND deleted_at IS NULL
    ),
    'movements_deleted', (
      SELECT COUNT(*) FROM movements 
      WHERE sku_id = 'SKU-001' AND deleted_at IS NOT NULL
    )
  ) INTO v_final_state
  FROM skus 
  WHERE id = 'SKU-001';
  
  RETURN jsonb_build_object(
    'success', true,
    'cleanup_result', v_cleanup_result,
    'sync_result', v_sync_result,
    'final_state', v_final_state,
    'timestamp', NOW()
  );
END;
$$;

-- 5) Create a trigger to prevent layer_consumptions for soft deleted movements
CREATE OR REPLACE FUNCTION prevent_layer_consumption_for_deleted_movements()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if the movement is soft deleted
  IF EXISTS (
    SELECT 1 FROM movements 
    WHERE id = NEW.movement_id AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot create layer consumption for soft deleted movement %', NEW.movement_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_layer_consumption_for_deleted
  BEFORE INSERT ON layer_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_layer_consumption_for_deleted_movements();

-- 6) Update the movement_history view to show soft delete status clearly
DROP VIEW IF EXISTS public.movement_history;
CREATE VIEW public.movement_history AS
SELECT 
    m.id,
    m.datetime,
    m.type,
    COALESCE(m.sku_id, m.product_name) as sku_or_name,
    m.quantity,
    m.total_value,
    m.reference,
    m.work_order_id,
    m.notes,
    s.unit,
    s.description as sku_description,
    m.deleted_at,
    m.deleted_by,
    m.deletion_reason,
    -- Indicator if this movement has orphaned layer_consumptions
    EXISTS(
      SELECT 1 FROM layer_consumptions lc 
      WHERE lc.movement_id = m.id
    ) as has_layer_consumptions
FROM movements m
LEFT JOIN skus s ON m.sku_id = s.id
WHERE m.deleted_at IS NULL  -- Only show active movements by default
ORDER BY m.datetime DESC;

GRANT SELECT ON public.movement_history TO anon, authenticated, service_role;

-- 7) Grant permissions on new functions
GRANT EXECUTE ON FUNCTION cleanup_soft_deleted_layer_consumptions TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fix_sku_sync_for_soft_deleted TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION repair_work_order_wo_1755731928 TO authenticated, service_role;

-- 8) Add comments
COMMENT ON FUNCTION cleanup_soft_deleted_layer_consumptions IS 'Clean up orphaned layer_consumptions from soft deleted movements';
COMMENT ON FUNCTION fix_sku_sync_for_soft_deleted IS 'Fix SKU on_hand synchronization for SKUs affected by soft deleted movements';
COMMENT ON FUNCTION repair_work_order_wo_1755731928 IS 'Comprehensive repair for the specific Work Order issue';
COMMENT ON VIEW inventory_summary IS 'Inventory summary that properly excludes soft deleted movements';
COMMENT ON VIEW movement_history IS 'Movement history with soft delete status and layer consumption indicators';