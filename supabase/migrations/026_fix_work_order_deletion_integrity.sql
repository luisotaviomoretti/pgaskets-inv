-- Migration: Fix Work Order Deletion Integrity
-- This migration ensures complete and atomic Work Order deletion with proper stock restoration
-- Created: 2025-08-20

-- 1) Create function to validate Work Order state before deletion
CREATE OR REPLACE FUNCTION validate_work_order_state(p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movements jsonb := '[]';
  v_has_produce boolean := false;
  v_has_issue boolean := false;
  v_has_waste boolean := false;
  v_active_count integer := 0;
  v_deleted_count integer := 0;
  v_issues jsonb := '[]';
BEGIN
  -- Get all movements for this reference
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'type', type,
      'sku_id', sku_id,
      'quantity', quantity,
      'total_value', total_value,
      'deleted_at', deleted_at,
      'reversed_at', reversed_at
    ) ORDER BY datetime ASC
  ) INTO v_movements
  FROM movements 
  WHERE reference = p_reference;
  
  -- Count movement types and states
  SELECT 
    COUNT(*) FILTER (WHERE type = 'PRODUCE') > 0,
    COUNT(*) FILTER (WHERE type = 'ISSUE') > 0,
    COUNT(*) FILTER (WHERE type = 'WASTE') > 0,
    COUNT(*) FILTER (WHERE deleted_at IS NULL),
    COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)
  INTO v_has_produce, v_has_issue, v_has_waste, v_active_count, v_deleted_count
  FROM movements 
  WHERE reference = p_reference;
  
  -- Validate Work Order structure
  IF NOT v_has_produce THEN
    v_issues := v_issues || jsonb_build_object(
      'type', 'missing_produce',
      'message', 'Work Order must have a PRODUCE movement'
    );
  END IF;
  
  IF NOT v_has_issue THEN
    v_issues := v_issues || jsonb_build_object(
      'type', 'missing_issue',
      'message', 'Work Order should have at least one ISSUE movement'
    );
  END IF;
  
  -- Check for partial deletion
  IF v_active_count > 0 AND v_deleted_count > 0 THEN
    v_issues := v_issues || jsonb_build_object(
      'type', 'partial_deletion',
      'message', 'Work Order has mixed active and deleted movements',
      'active_count', v_active_count,
      'deleted_count', v_deleted_count
    );
  END IF;
  
  RETURN jsonb_build_object(
    'reference', p_reference,
    'movements', COALESCE(v_movements, '[]'::jsonb),
    'has_produce', v_has_produce,
    'has_issue', v_has_issue,
    'has_waste', v_has_waste,
    'active_count', v_active_count,
    'deleted_count', v_deleted_count,
    'is_valid', jsonb_array_length(v_issues) = 0,
    'issues', v_issues,
    'can_delete', v_active_count > 0 AND jsonb_array_length(v_issues) = 0,
    'can_restore', v_deleted_count > 0
  );
END;
$$;

-- 2) Create atomic Work Order deletion function
CREATE OR REPLACE FUNCTION delete_work_order_atomic(
  p_reference text,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_validation jsonb;
  v_movement record;
  v_results jsonb := '[]';
  v_deleted_count integer := 0;
  v_restore_results jsonb := '[]';
  v_delete_result jsonb;
  v_sku_list text[] := '{}';
  v_sku text;
BEGIN
  -- Validate Work Order state
  SELECT validate_work_order_state(p_reference) INTO v_validation;
  
  IF NOT (v_validation->>'can_delete')::boolean THEN
    RAISE EXCEPTION 'Cannot delete Work Order %: %', p_reference, v_validation->>'issues';
  END IF;
  
  -- Start atomic transaction
  BEGIN
    -- Phase 1: Delete in correct order (PRODUCE → WASTE → ISSUE)
    -- This order ensures FIFO layers are properly restored
    
    -- Step 1: Delete PRODUCE movements (removes produced layers)
    FOR v_movement IN
      SELECT * FROM movements 
      WHERE reference = p_reference 
        AND type = 'PRODUCE' 
        AND deleted_at IS NULL
      ORDER BY datetime DESC
    LOOP
      -- Use reverse_movement for PRODUCE to restore FIFO properly
      SELECT reverse_movement(v_movement.id, p_deletion_reason, p_deleted_by) INTO v_delete_result;
      v_results := v_results || v_delete_result;
      v_deleted_count := v_deleted_count + 1;
      
      -- Track SKUs affected
      IF v_movement.sku_id IS NOT NULL AND NOT (v_movement.sku_id = ANY(v_sku_list)) THEN
        v_sku_list := v_sku_list || v_movement.sku_id;
      END IF;
    END LOOP;
    
    -- Step 2: Delete WASTE movements (restores consumed layers)
    FOR v_movement IN
      SELECT * FROM movements 
      WHERE reference = p_reference 
        AND type = 'WASTE' 
        AND deleted_at IS NULL
      ORDER BY datetime DESC
    LOOP
      -- WASTE movements should restore their layer consumptions
      IF EXISTS(SELECT 1 FROM layer_consumptions WHERE movement_id = v_movement.id) THEN
        -- Restore consumed layers for WASTE
        UPDATE fifo_layers fl
        SET 
          remaining_quantity = remaining_quantity + lc.quantity_consumed,
          status = CASE WHEN remaining_quantity + lc.quantity_consumed > 0 THEN 'ACTIVE' ELSE status END,
          updated_at = NOW()
        FROM layer_consumptions lc
        WHERE lc.movement_id = v_movement.id AND fl.id = lc.layer_id;
        
        -- Delete consumption records
        DELETE FROM layer_consumptions WHERE movement_id = v_movement.id;
      END IF;
      
      -- Soft delete the WASTE movement
      SELECT soft_delete_movement(v_movement.id, p_deletion_reason, p_deleted_by) INTO v_delete_result;
      v_results := v_results || v_delete_result;
      v_deleted_count := v_deleted_count + 1;
      
      -- Track SKUs affected
      IF v_movement.sku_id IS NOT NULL AND NOT (v_movement.sku_id = ANY(v_sku_list)) THEN
        v_sku_list := v_sku_list || v_movement.sku_id;
      END IF;
    END LOOP;
    
    -- Step 3: Delete ISSUE movements (restores consumed layers)
    FOR v_movement IN
      SELECT * FROM movements 
      WHERE reference = p_reference 
        AND type = 'ISSUE' 
        AND deleted_at IS NULL
      ORDER BY datetime DESC
    LOOP
      -- ISSUE movements should restore their layer consumptions
      IF EXISTS(SELECT 1 FROM layer_consumptions WHERE movement_id = v_movement.id) THEN
        -- Restore consumed layers for ISSUE
        UPDATE fifo_layers fl
        SET 
          remaining_quantity = remaining_quantity + lc.quantity_consumed,
          status = CASE WHEN remaining_quantity + lc.quantity_consumed > 0 THEN 'ACTIVE' ELSE status END,
          updated_at = NOW()
        FROM layer_consumptions lc
        WHERE lc.movement_id = v_movement.id AND fl.id = lc.layer_id;
        
        -- Delete consumption records
        DELETE FROM layer_consumptions WHERE movement_id = v_movement.id;
      END IF;
      
      -- Soft delete the ISSUE movement
      SELECT soft_delete_movement(v_movement.id, p_deletion_reason, p_deleted_by) INTO v_delete_result;
      v_results := v_results || v_delete_result;
      v_deleted_count := v_deleted_count + 1;
      
      -- Track SKUs affected
      IF v_movement.sku_id IS NOT NULL AND NOT (v_movement.sku_id = ANY(v_sku_list)) THEN
        v_sku_list := v_sku_list || v_movement.sku_id;
      END IF;
    END LOOP;
    
    -- Phase 2: Sync all affected SKUs
    FOREACH v_sku IN ARRAY v_sku_list
    LOOP
      PERFORM public.sync_sku_on_hand_from_layers(v_sku);
    END LOOP;
    
    -- Phase 3: Log the complete Work Order deletion
    INSERT INTO movement_deletion_audit (
      original_movement_id, original_movement_type, original_sku_id,
      original_quantity, original_total_value, original_reference,
      original_datetime, deletion_type, deletion_reason, deleted_by,
      session_info
    ) VALUES (
      0, 'WORK_ORDER'::movement_type, NULL,
      0, 0, p_reference,
      NOW(), 'WORK_ORDER_DELETION', 
      COALESCE(p_deletion_reason, 'Complete Work Order deletion'), 
      p_deleted_by,
      jsonb_build_object(
        'work_order_reference', p_reference,
        'deleted_movements_count', v_deleted_count,
        'affected_skus', v_sku_list,
        'deletion_method', 'atomic'
      )
    );
    
    RETURN jsonb_build_object(
      'success', true,
      'reference', p_reference,
      'deleted_movements_count', v_deleted_count,
      'affected_skus', v_sku_list,
      'deleted_movements', v_results,
      'validation', v_validation
    );
    
  EXCEPTION WHEN OTHERS THEN
    -- Rollback happens automatically
    RAISE EXCEPTION 'Failed to delete Work Order %: %', p_reference, SQLERRM;
  END;
END;
$$;

-- 3) Update delete_movement to automatically handle Work Orders
CREATE OR REPLACE FUNCTION delete_movement(
  p_movement_id integer,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_result jsonb;
  v_validation jsonb;
BEGIN
  -- Get movement info
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movement not found: %', p_movement_id;
  END IF;
  
  -- Check if already deleted
  IF v_movement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movement % is already deleted', p_movement_id;
  END IF;
  
  -- Special handling for PRODUCE movements - delete entire Work Order
  IF v_movement.type = 'PRODUCE' AND v_movement.work_order_id IS NOT NULL THEN
    -- Use work_order_id if available, otherwise use reference
    IF v_movement.work_order_id IS NOT NULL THEN
      -- Find reference by work_order_id
      SELECT reference INTO v_movement.reference 
      FROM movements 
      WHERE work_order_id = v_movement.work_order_id 
      LIMIT 1;
    END IF;
    
    -- Validate if this is part of a complete Work Order
    SELECT validate_work_order_state(v_movement.reference) INTO v_validation;
    
    IF (v_validation->>'has_issue')::boolean OR (v_validation->>'has_waste')::boolean THEN
      -- This is part of a Work Order - delete the entire Work Order atomically
      SELECT delete_work_order_atomic(v_movement.reference, p_deletion_reason, p_deleted_by) INTO v_result;
      RETURN v_result;
    END IF;
  END IF;
  
  -- For non-Work Order movements or single movements, use original logic
  -- For RECEIVE movements, check stock constraints first
  IF v_movement.type = 'RECEIVE' AND v_movement.sku_id IS NOT NULL THEN
    DECLARE
      v_current_stock numeric;
    BEGIN
      SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
      
      -- If would cause negative stock, use soft delete without reversal
      IF v_current_stock - v_movement.quantity < 0 THEN
        SELECT soft_delete_movement_without_reversal(p_movement_id, 
          COALESCE(p_deletion_reason, 'Cannot reverse due to insufficient stock'), 
          p_deleted_by) INTO v_result;
        RETURN v_result;
      END IF;
    END;
  END IF;
  
  -- Try normal reversal for RECEIVE/PRODUCE
  IF v_movement.type IN ('RECEIVE', 'PRODUCE') AND v_movement.reversed_at IS NULL THEN
    BEGIN
      SELECT reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
    EXCEPTION WHEN OTHERS THEN
      -- If reversal fails, fall back to soft delete without reversal
      SELECT soft_delete_movement_without_reversal(p_movement_id, 
        COALESCE(p_deletion_reason, 'Reversal failed: ' || SQLERRM), 
        p_deleted_by) INTO v_result;
    END;
  ELSE
    -- For other movements, just soft delete
    SELECT soft_delete_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  END IF;
  
  RETURN v_result;
END;
$$;

-- 4) Create Work Order restoration function
CREATE OR REPLACE FUNCTION restore_work_order_atomic(
  p_reference text,
  p_restored_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_validation jsonb;
  v_movement record;
  v_results jsonb := '[]';
  v_restored_count integer := 0;
  v_restore_result jsonb;
  v_sku_list text[] := '{}';
  v_sku text;
BEGIN
  -- Validate Work Order state
  SELECT validate_work_order_state(p_reference) INTO v_validation;
  
  IF NOT (v_validation->>'can_restore')::boolean THEN
    RAISE EXCEPTION 'Cannot restore Work Order %: No deleted movements found', p_reference;
  END IF;
  
  -- Restore in reverse order (ISSUE → WASTE → PRODUCE)
  FOR v_movement IN
    SELECT * FROM movements 
    WHERE reference = p_reference 
      AND deleted_at IS NOT NULL
    ORDER BY CASE 
      WHEN type = 'ISSUE' THEN 1
      WHEN type = 'WASTE' THEN 2  
      WHEN type = 'PRODUCE' THEN 3
      ELSE 4
    END, datetime ASC
  LOOP
    SELECT restore_movement(v_movement.id, p_restored_by) INTO v_restore_result;
    v_results := v_results || v_restore_result;
    v_restored_count := v_restored_count + 1;
    
    -- Track SKUs affected
    IF v_movement.sku_id IS NOT NULL AND NOT (v_movement.sku_id = ANY(v_sku_list)) THEN
      v_sku_list := v_sku_list || v_movement.sku_id;
    END IF;
  END LOOP;
  
  -- Sync all affected SKUs
  FOREACH v_sku IN ARRAY v_sku_list
  LOOP
    PERFORM public.sync_sku_on_hand_from_layers(v_sku);
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'reference', p_reference,
    'restored_movements_count', v_restored_count,
    'affected_skus', v_sku_list,
    'restored_movements', v_results
  );
END;
$$;

-- 5) Create diagnostic functions
CREATE OR REPLACE FUNCTION diagnose_work_order_integrity(p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_validation jsonb;
  v_sku_states jsonb := '[]';
  v_sku text;
  v_sku_info jsonb;
  v_layer_total numeric;
  v_sku_on_hand numeric;
BEGIN
  -- Get basic validation
  SELECT validate_work_order_state(p_reference) INTO v_validation;
  
  -- Check each affected SKU
  FOR v_sku IN
    SELECT DISTINCT sku_id 
    FROM movements 
    WHERE reference = p_reference AND sku_id IS NOT NULL
  LOOP
    -- Get SKU on_hand
    SELECT on_hand INTO v_sku_on_hand FROM skus WHERE id = v_sku;
    
    -- Get total from layers
    SELECT COALESCE(SUM(remaining_quantity), 0) 
    INTO v_layer_total
    FROM fifo_layers 
    WHERE sku_id = v_sku AND remaining_quantity > 0;
    
    v_sku_info := jsonb_build_object(
      'sku_id', v_sku,
      'sku_on_hand', v_sku_on_hand,
      'layer_total', v_layer_total,
      'is_synchronized', v_sku_on_hand = v_layer_total,
      'difference', v_sku_on_hand - v_layer_total
    );
    
    v_sku_states := v_sku_states || v_sku_info;
  END LOOP;
  
  RETURN jsonb_build_object(
    'reference', p_reference,
    'validation', v_validation,
    'sku_integrity', v_sku_states,
    'overall_integrity', NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_sku_states) AS elem
      WHERE NOT (elem->>'is_synchronized')::boolean
    )
  );
END;
$$;

-- 6) Create repair function for out-of-sync SKUs
CREATE OR REPLACE FUNCTION repair_sku_integrity(p_sku_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old_on_hand numeric;
  v_new_on_hand numeric;
  v_layer_total numeric;
BEGIN
  -- Get current values
  SELECT on_hand INTO v_old_on_hand FROM skus WHERE id = p_sku_id;
  
  -- Calculate from layers
  SELECT COALESCE(SUM(remaining_quantity), 0) 
  INTO v_layer_total
  FROM fifo_layers 
  WHERE sku_id = p_sku_id AND remaining_quantity > 0;
  
  -- Sync using the official function
  PERFORM public.sync_sku_on_hand_from_layers(p_sku_id);
  
  -- Get new value
  SELECT on_hand INTO v_new_on_hand FROM skus WHERE id = p_sku_id;
  
  RETURN jsonb_build_object(
    'sku_id', p_sku_id,
    'old_on_hand', v_old_on_hand,
    'layer_total', v_layer_total,
    'new_on_hand', v_new_on_hand,
    'was_repaired', v_old_on_hand != v_new_on_hand,
    'is_now_synchronized', v_new_on_hand = v_layer_total
  );
END;
$$;

-- 7) Grant permissions
GRANT EXECUTE ON FUNCTION validate_work_order_state TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_work_order_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION restore_work_order_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION diagnose_work_order_integrity TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION repair_sku_integrity TO authenticated, service_role;

-- 8) Add comments
COMMENT ON FUNCTION validate_work_order_state IS 'Validate Work Order structure and state for safe operations';
COMMENT ON FUNCTION delete_work_order_atomic IS 'Atomically delete entire Work Order with proper FIFO restoration';
COMMENT ON FUNCTION restore_work_order_atomic IS 'Atomically restore entire Work Order';
COMMENT ON FUNCTION diagnose_work_order_integrity IS 'Diagnose Work Order and SKU integrity issues';
COMMENT ON FUNCTION repair_sku_integrity IS 'Repair SKU on_hand synchronization with FIFO layers';