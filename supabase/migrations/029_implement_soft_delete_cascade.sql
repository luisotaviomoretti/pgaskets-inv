-- Migration: Implement Soft Delete Cascade Architecture
-- This migration implements proper soft delete cascade for complete data consistency
-- Created: 2025-08-20

-- 1) Add soft delete columns to layer_consumptions table
ALTER TABLE layer_consumptions 
ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN deleted_by TEXT DEFAULT NULL,
ADD COLUMN deletion_reason TEXT DEFAULT NULL;

-- 2) Create indexes for soft delete performance
CREATE INDEX idx_layer_consumptions_active ON layer_consumptions(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_layer_consumptions_deleted ON layer_consumptions(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_layer_consumptions_movement_active ON layer_consumptions(movement_id) WHERE deleted_at IS NULL;

-- 3) Create trigger function for soft delete cascade
CREATE OR REPLACE FUNCTION cascade_movement_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- When a movement is soft deleted
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    -- Soft delete all related layer_consumptions
    UPDATE layer_consumptions 
    SET 
      deleted_at = NEW.deleted_at,
      deleted_by = NEW.deleted_by,
      deletion_reason = COALESCE(NEW.deletion_reason, 'Cascaded from movement deletion')
    WHERE movement_id = NEW.id AND deleted_at IS NULL;
    
    -- Restore FIFO layers by recalculating remaining_quantity
    PERFORM recalculate_fifo_layer_quantities_for_movement(NEW.id);
  END IF;
  
  -- When a movement is restored (undeleted)
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    -- Restore all related layer_consumptions
    UPDATE layer_consumptions 
    SET 
      deleted_at = NULL,
      deleted_by = NULL,
      deletion_reason = NULL
    WHERE movement_id = NEW.id AND deleted_at IS NOT NULL;
    
    -- Recalculate FIFO layers
    PERFORM recalculate_fifo_layer_quantities_for_movement(NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4) Create function to recalculate FIFO layer quantities
CREATE OR REPLACE FUNCTION recalculate_fifo_layer_quantities_for_movement(p_movement_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_layer_id text;
BEGIN
  -- Get all layers affected by this movement and recalculate their remaining_quantity
  FOR v_layer_id IN
    SELECT DISTINCT layer_id 
    FROM layer_consumptions 
    WHERE movement_id = p_movement_id
  LOOP
    PERFORM recalculate_single_fifo_layer(v_layer_id);
  END LOOP;
END;
$$;

-- 5) Create function to recalculate a single FIFO layer
CREATE OR REPLACE FUNCTION recalculate_single_fifo_layer(p_layer_id text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_original_quantity numeric;
  v_total_consumed numeric;
  v_new_remaining numeric;
  v_new_status layer_status;
BEGIN
  -- Get original quantity
  SELECT original_quantity INTO v_original_quantity
  FROM fifo_layers 
  WHERE id = p_layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FIFO layer not found: %', p_layer_id;
  END IF;
  
  -- Calculate total consumed from ACTIVE consumptions only
  SELECT COALESCE(SUM(quantity_consumed), 0) INTO v_total_consumed
  FROM layer_consumptions 
  WHERE layer_id = p_layer_id AND deleted_at IS NULL;
  
  -- Calculate new remaining quantity
  v_new_remaining := v_original_quantity - v_total_consumed;
  
  -- Ensure remaining is not negative
  v_new_remaining := GREATEST(v_new_remaining, 0);
  
  -- Determine new status
  IF v_new_remaining = 0 THEN
    v_new_status := 'EXHAUSTED';
  ELSIF v_new_remaining > 0 THEN
    v_new_status := 'ACTIVE';
  END IF;
  
  -- Update the layer
  UPDATE fifo_layers 
  SET 
    remaining_quantity = v_new_remaining,
    status = v_new_status,
    updated_at = NOW()
  WHERE id = p_layer_id;
  
  RETURN v_new_remaining;
END;
$$;

-- 6) Create the soft delete cascade trigger
CREATE TRIGGER trigger_cascade_movement_soft_delete
  AFTER UPDATE OF deleted_at ON movements
  FOR EACH ROW
  EXECUTE FUNCTION cascade_movement_soft_delete();

-- 7) Create function to repair existing inconsistent data
CREATE OR REPLACE FUNCTION repair_existing_soft_delete_inconsistencies()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movements_processed integer := 0;
  v_consumptions_fixed integer := 0;
  v_layers_recalculated integer := 0;
  v_movement record;
  v_layer_id text;
  v_affected_layers text[] := '{}';
BEGIN
  -- Find all soft deleted movements with active layer_consumptions
  FOR v_movement IN
    SELECT DISTINCT m.id, m.deleted_at, m.deleted_by, m.deletion_reason
    FROM movements m
    JOIN layer_consumptions lc ON lc.movement_id = m.id
    WHERE m.deleted_at IS NOT NULL AND lc.deleted_at IS NULL
  LOOP
    -- Soft delete the consumptions
    UPDATE layer_consumptions 
    SET 
      deleted_at = v_movement.deleted_at,
      deleted_by = v_movement.deleted_by,
      deletion_reason = COALESCE(v_movement.deletion_reason, 'Repair: cascaded from movement deletion')
    WHERE movement_id = v_movement.id AND deleted_at IS NULL;
    
    GET DIAGNOSTICS v_consumptions_fixed = ROW_COUNT;
    v_movements_processed := v_movements_processed + 1;
    
    -- Collect affected layers
    SELECT array_agg(DISTINCT layer_id) INTO v_affected_layers
    FROM layer_consumptions 
    WHERE movement_id = v_movement.id;
  END LOOP;
  
  -- Recalculate all affected layers
  IF array_length(v_affected_layers, 1) > 0 THEN
    FOREACH v_layer_id IN ARRAY v_affected_layers
    LOOP
      PERFORM recalculate_single_fifo_layer(v_layer_id);
      v_layers_recalculated := v_layers_recalculated + 1;
    END LOOP;
  END IF;
  
  RETURN jsonb_build_object(
    'success', true,
    'movements_processed', v_movements_processed,
    'consumptions_fixed', v_consumptions_fixed,
    'layers_recalculated', v_layers_recalculated,
    'affected_layers', v_affected_layers,
    'timestamp', NOW()
  );
END;
$$;

-- 8) Simplify inventory_summary view (now that FIFO layers are always correct)
DROP VIEW IF EXISTS public.inventory_summary;
CREATE OR REPLACE VIEW public.inventory_summary AS
SELECT
  s.id,
  s.description,
  s.type,
  s.product_category,
  s.unit,
  -- on_hand derived from layers with remaining_quantity > 0 (layers are now always correct)
  COALESCE(SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 0)::numeric as on_hand,
  s.reserved,
  s.min_stock,
  s.max_stock,
  s.active,
  -- Status computed against derived on_hand
  CASE 
    WHEN COALESCE(SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 0) <= s.min_stock THEN 'BELOW_MIN'
    WHEN s.max_stock IS NOT NULL 
         AND COALESCE(SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity ELSE 0 END), 0) >= s.max_stock THEN 'OVERSTOCK'
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
GROUP BY s.id, s.description, s.type, s.product_category, s.unit, 
         s.reserved, s.min_stock, s.max_stock, s.active, s.average_cost;

-- Grant permissions
GRANT SELECT ON public.inventory_summary TO anon, authenticated, service_role;

-- 9) Create view for layer_consumptions that filters soft deleted
CREATE OR REPLACE VIEW active_layer_consumptions AS
SELECT *
FROM layer_consumptions
WHERE deleted_at IS NULL;

GRANT SELECT ON active_layer_consumptions TO anon, authenticated, service_role;

-- 10) Update movement_history view to show cascade information
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
    -- Show cascade status
    CASE 
      WHEN m.deleted_at IS NOT NULL THEN
        (SELECT COUNT(*) FROM layer_consumptions lc WHERE lc.movement_id = m.id AND lc.deleted_at IS NOT NULL)
      ELSE 0
    END as cascaded_consumptions,
    -- Active consumptions
    (SELECT COUNT(*) FROM layer_consumptions lc WHERE lc.movement_id = m.id AND lc.deleted_at IS NULL) as active_consumptions
FROM movements m
LEFT JOIN skus s ON m.sku_id = s.id
WHERE m.deleted_at IS NULL  -- Only show active movements by default
ORDER BY m.datetime DESC;

GRANT SELECT ON public.movement_history TO anon, authenticated, service_role;

-- 11) Create diagnostic function for the new architecture
CREATE OR REPLACE FUNCTION diagnose_soft_delete_cascade_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movements_stats jsonb;
  v_consumptions_stats jsonb;
  v_layers_stats jsonb;
  v_inconsistencies jsonb;
BEGIN
  -- Movement statistics
  SELECT jsonb_build_object(
    'total_movements', COUNT(*),
    'active_movements', COUNT(*) FILTER (WHERE deleted_at IS NULL),
    'soft_deleted_movements', COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)
  ) INTO v_movements_stats
  FROM movements;
  
  -- Consumption statistics
  SELECT jsonb_build_object(
    'total_consumptions', COUNT(*),
    'active_consumptions', COUNT(*) FILTER (WHERE deleted_at IS NULL),
    'soft_deleted_consumptions', COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)
  ) INTO v_consumptions_stats
  FROM layer_consumptions;
  
  -- Layer statistics
  SELECT jsonb_build_object(
    'total_layers', COUNT(*),
    'active_layers', COUNT(*) FILTER (WHERE status = 'ACTIVE'),
    'exhausted_layers', COUNT(*) FILTER (WHERE status = 'EXHAUSTED'),
    'total_remaining_quantity', COALESCE(SUM(remaining_quantity), 0)
  ) INTO v_layers_stats
  FROM fifo_layers;
  
  -- Check for inconsistencies
  SELECT jsonb_build_object(
    'orphaned_consumptions', (
      SELECT COUNT(*) FROM layer_consumptions lc
      JOIN movements m ON lc.movement_id = m.id
      WHERE m.deleted_at IS NOT NULL AND lc.deleted_at IS NULL
    ),
    'inconsistent_layers', (
      SELECT COUNT(*) FROM fifo_layers fl
      WHERE fl.remaining_quantity != fl.original_quantity - COALESCE((
        SELECT SUM(lc.quantity_consumed)
        FROM layer_consumptions lc
        WHERE lc.layer_id = fl.id AND lc.deleted_at IS NULL
      ), 0)
    )
  ) INTO v_inconsistencies;
  
  RETURN jsonb_build_object(
    'movements', v_movements_stats,
    'consumptions', v_consumptions_stats,
    'layers', v_layers_stats,
    'inconsistencies', v_inconsistencies,
    'is_healthy', (v_inconsistencies->>'orphaned_consumptions')::integer = 0 
                  AND (v_inconsistencies->>'inconsistent_layers')::integer = 0,
    'timestamp', NOW()
  );
END;
$$;

-- 12) Grant permissions on new functions
GRANT EXECUTE ON FUNCTION recalculate_fifo_layer_quantities_for_movement TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION recalculate_single_fifo_layer TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION repair_existing_soft_delete_inconsistencies TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION diagnose_soft_delete_cascade_health TO authenticated, service_role;

-- 13) Add comments
COMMENT ON COLUMN layer_consumptions.deleted_at IS 'Soft delete timestamp (NULL = active, NOT NULL = deleted)';
COMMENT ON COLUMN layer_consumptions.deleted_by IS 'User who performed the soft delete';
COMMENT ON COLUMN layer_consumptions.deletion_reason IS 'Reason for soft delete';
COMMENT ON FUNCTION cascade_movement_soft_delete IS 'Trigger function for cascading soft delete from movements to layer_consumptions';
COMMENT ON FUNCTION recalculate_single_fifo_layer IS 'Recalculate FIFO layer remaining_quantity based on active consumptions only';
COMMENT ON FUNCTION repair_existing_soft_delete_inconsistencies IS 'One-time repair function for existing inconsistent data';
COMMENT ON FUNCTION diagnose_soft_delete_cascade_health IS 'Diagnostic function to check soft delete cascade system health';
COMMENT ON VIEW active_layer_consumptions IS 'View of layer_consumptions filtering out soft deleted records';
COMMENT ON VIEW inventory_summary IS 'Simplified inventory summary (FIFO layers are now always consistent)';
COMMENT ON VIEW movement_history IS 'Movement history with cascade information';