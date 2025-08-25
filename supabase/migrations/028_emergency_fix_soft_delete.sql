-- Migration: Emergency Fix for Soft Delete Issues
-- This migration immediately fixes the critical soft delete problems
-- Created: 2025-08-20

-- 1) Fix the inventory_summary view (current one is breaking)
DROP VIEW IF EXISTS public.inventory_summary;
CREATE OR REPLACE VIEW public.inventory_summary AS
SELECT
  s.id,
  s.description,
  s.type,
  s.product_category,
  s.unit,
  -- Calculate on_hand from layers, excluding consumed quantities from soft deleted movements
  COALESCE(
    SUM(
      CASE 
        WHEN fl.remaining_quantity > 0 THEN 
          fl.remaining_quantity + COALESCE(soft_deleted_consumptions.total_consumed, 0)
        ELSE 0 
      END
    ), 
    0
  )::numeric as on_hand,
  s.reserved,
  s.min_stock,
  s.max_stock,
  s.active,
  -- Status computed against corrected on_hand
  CASE 
    WHEN COALESCE(
      SUM(
        CASE 
          WHEN fl.remaining_quantity > 0 THEN 
            fl.remaining_quantity + COALESCE(soft_deleted_consumptions.total_consumed, 0)
          ELSE 0 
        END
      ), 
      0
    ) <= s.min_stock THEN 'BELOW_MIN'
    WHEN s.max_stock IS NOT NULL 
         AND COALESCE(
           SUM(
             CASE 
               WHEN fl.remaining_quantity > 0 THEN 
                 fl.remaining_quantity + COALESCE(soft_deleted_consumptions.total_consumed, 0)
               ELSE 0 
             END
           ), 
           0
         ) >= s.max_stock THEN 'OVERSTOCK'
    ELSE 'OK'
  END as status,
  -- Weighted average cost
  COALESCE(
    SUM(
      CASE 
        WHEN fl.remaining_quantity > 0 THEN 
          (fl.remaining_quantity + COALESCE(soft_deleted_consumptions.total_consumed, 0)) * fl.unit_cost 
        ELSE 0 
      END
    ) / NULLIF(
      SUM(
        CASE 
          WHEN fl.remaining_quantity > 0 THEN 
            fl.remaining_quantity + COALESCE(soft_deleted_consumptions.total_consumed, 0)
          ELSE 0 
        END
      ), 
      0
    ),
    s.average_cost,
    0
  ) as current_avg_cost,
  COUNT(fl.id) FILTER (WHERE fl.remaining_quantity > 0) as active_layers
FROM public.skus s
LEFT JOIN public.fifo_layers fl ON fl.sku_id = s.id
LEFT JOIN (
  -- Calculate total consumed from soft deleted movements per layer
  SELECT 
    lc.layer_id,
    SUM(lc.quantity_consumed) as total_consumed
  FROM public.layer_consumptions lc
  JOIN public.movements m ON lc.movement_id = m.id
  WHERE m.deleted_at IS NOT NULL
  GROUP BY lc.layer_id
) soft_deleted_consumptions ON fl.id = soft_deleted_consumptions.layer_id
GROUP BY s.id, s.description, s.type, s.product_category, s.unit, 
         s.reserved, s.min_stock, s.max_stock, s.active, s.average_cost;

-- Grant permissions
GRANT SELECT ON public.inventory_summary TO anon, authenticated, service_role;

-- 2) Create immediate repair function for current state
CREATE OR REPLACE FUNCTION emergency_repair_current_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_restored_layers jsonb := '[]';
  v_cleaned_consumptions integer := 0;
  v_consumption record;
  v_layer_info jsonb;
  v_affected_skus text[] := '{}';
  v_sku text;
BEGIN
  -- Step 1: Restore FIFO layers from soft deleted consumptions
  FOR v_consumption IN
    SELECT lc.*, m.sku_id, m.reference
    FROM layer_consumptions lc
    JOIN movements m ON lc.movement_id = m.id
    WHERE m.deleted_at IS NOT NULL
  LOOP
    -- Restore quantity to the layer
    UPDATE fifo_layers 
    SET 
      remaining_quantity = remaining_quantity + v_consumption.quantity_consumed,
      status = CASE 
        WHEN remaining_quantity + v_consumption.quantity_consumed > 0 THEN 'ACTIVE'
        ELSE status 
      END,
      updated_at = NOW()
    WHERE id = v_consumption.layer_id;
    
    -- Track what we restored
    SELECT jsonb_build_object(
      'layer_id', id,
      'old_remaining', remaining_quantity - v_consumption.quantity_consumed,
      'restored_quantity', v_consumption.quantity_consumed,
      'new_remaining', remaining_quantity,
      'movement_id', v_consumption.movement_id,
      'movement_sku', v_consumption.sku_id
    ) INTO v_layer_info
    FROM fifo_layers 
    WHERE id = v_consumption.layer_id;
    
    v_restored_layers := v_restored_layers || v_layer_info;
    
    -- Track affected SKUs
    IF v_consumption.sku_id IS NOT NULL AND NOT (v_consumption.sku_id = ANY(v_affected_skus)) THEN
      v_affected_skus := v_affected_skus || v_consumption.sku_id;
    END IF;
    
    -- Delete the orphaned consumption
    DELETE FROM layer_consumptions WHERE id = v_consumption.id;
    v_cleaned_consumptions := v_cleaned_consumptions + 1;
  END LOOP;
  
  -- Step 2: Sync all affected SKUs
  FOREACH v_sku IN ARRAY v_affected_skus
  LOOP
    PERFORM public.sync_sku_on_hand_from_layers(v_sku);
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'restored_layers_count', jsonb_array_length(v_restored_layers),
    'cleaned_consumptions', v_cleaned_consumptions,
    'affected_skus', v_affected_skus,
    'restored_layers', v_restored_layers,
    'timestamp', NOW()
  );
END;
$$;

-- 3) Create function to check and fix availability for Work Orders
CREATE OR REPLACE FUNCTION check_sku_availability_fixed(p_sku_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_in_layers numeric;
  v_sku_on_hand numeric;
  v_soft_deleted_consumed numeric;
  v_true_available numeric;
BEGIN
  -- Get SKU on_hand
  SELECT on_hand INTO v_sku_on_hand FROM skus WHERE id = p_sku_id;
  
  -- Get total from active layers
  SELECT COALESCE(SUM(remaining_quantity), 0) 
  INTO v_total_in_layers
  FROM fifo_layers 
  WHERE sku_id = p_sku_id AND status = 'ACTIVE';
  
  -- Get quantity consumed by soft deleted movements
  SELECT COALESCE(SUM(lc.quantity_consumed), 0)
  INTO v_soft_deleted_consumed
  FROM layer_consumptions lc
  JOIN movements m ON lc.movement_id = m.id
  JOIN fifo_layers fl ON lc.layer_id = fl.id
  WHERE fl.sku_id = p_sku_id AND m.deleted_at IS NOT NULL;
  
  -- True available is layers + soft deleted consumed
  v_true_available := v_total_in_layers + v_soft_deleted_consumed;
  
  RETURN jsonb_build_object(
    'sku_id', p_sku_id,
    'sku_on_hand', v_sku_on_hand,
    'total_in_layers', v_total_in_layers,
    'soft_deleted_consumed', v_soft_deleted_consumed,
    'true_available', v_true_available,
    'needs_repair', v_sku_on_hand != v_true_available OR v_soft_deleted_consumed > 0
  );
END;
$$;

-- 4) Update sync function to handle soft deleted consumptions properly
CREATE OR REPLACE FUNCTION sync_sku_on_hand_from_layers_fixed(p_sku_id text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_from_layers numeric;
  v_soft_deleted_consumed numeric;
  v_corrected_total numeric;
BEGIN
  -- Calculate total from active layers
  SELECT COALESCE(SUM(remaining_quantity), 0)
  INTO v_total_from_layers
  FROM fifo_layers
  WHERE sku_id = p_sku_id AND status = 'ACTIVE';
  
  -- Add back quantities consumed by soft deleted movements
  SELECT COALESCE(SUM(lc.quantity_consumed), 0)
  INTO v_soft_deleted_consumed
  FROM layer_consumptions lc
  JOIN movements m ON lc.movement_id = m.id
  JOIN fifo_layers fl ON lc.layer_id = fl.id
  WHERE fl.sku_id = p_sku_id AND m.deleted_at IS NOT NULL;
  
  v_corrected_total := v_total_from_layers + v_soft_deleted_consumed;
  
  -- Update SKU
  UPDATE skus 
  SET 
    on_hand = v_corrected_total,
    updated_at = NOW()
  WHERE id = p_sku_id;
  
  RETURN v_corrected_total;
END;
$$;

-- 5) Create comprehensive diagnostic function
CREATE OR REPLACE FUNCTION diagnose_system_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movements_stats jsonb;
  v_layer_stats jsonb;
  v_consumption_stats jsonb;
  v_sku_stats jsonb;
BEGIN
  -- Movement statistics
  SELECT jsonb_build_object(
    'total_movements', COUNT(*),
    'active_movements', COUNT(*) FILTER (WHERE deleted_at IS NULL),
    'soft_deleted_movements', COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)
  ) INTO v_movements_stats
  FROM movements;
  
  -- Layer statistics
  SELECT jsonb_build_object(
    'total_layers', COUNT(*),
    'active_layers', COUNT(*) FILTER (WHERE status = 'ACTIVE'),
    'total_remaining_quantity', COALESCE(SUM(remaining_quantity), 0)
  ) INTO v_layer_stats
  FROM fifo_layers;
  
  -- Consumption statistics
  SELECT jsonb_build_object(
    'total_consumptions', COUNT(*),
    'orphaned_consumptions', COUNT(*) FILTER (WHERE m.deleted_at IS NOT NULL),
    'orphaned_consumed_quantity', COALESCE(SUM(CASE WHEN m.deleted_at IS NOT NULL THEN lc.quantity_consumed ELSE 0 END), 0)
  ) INTO v_consumption_stats
  FROM layer_consumptions lc
  JOIN movements m ON lc.movement_id = m.id;
  
  -- SKU statistics
  SELECT jsonb_build_object(
    'total_skus', COUNT(*),
    'skus_with_stock', COUNT(*) FILTER (WHERE on_hand > 0),
    'total_on_hand', COALESCE(SUM(on_hand), 0)
  ) INTO v_sku_stats
  FROM skus;
  
  RETURN jsonb_build_object(
    'movements', v_movements_stats,
    'layers', v_layer_stats,
    'consumptions', v_consumption_stats,
    'skus', v_sku_stats,
    'timestamp', NOW()
  );
END;
$$;

-- 6) Grant permissions
GRANT EXECUTE ON FUNCTION emergency_repair_current_state TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION check_sku_availability_fixed TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION sync_sku_on_hand_from_layers_fixed TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION diagnose_system_state TO authenticated, service_role;

-- 7) Add comments
COMMENT ON FUNCTION emergency_repair_current_state IS 'Emergency repair for current soft delete issues';
COMMENT ON FUNCTION check_sku_availability_fixed IS 'Check SKU availability accounting for soft deleted consumptions';
COMMENT ON FUNCTION sync_sku_on_hand_from_layers_fixed IS 'Fixed sync function that handles soft deleted consumptions';
COMMENT ON FUNCTION diagnose_system_state IS 'Comprehensive system state diagnosis';
COMMENT ON VIEW inventory_summary IS 'Fixed inventory summary that accounts for soft deleted consumptions';