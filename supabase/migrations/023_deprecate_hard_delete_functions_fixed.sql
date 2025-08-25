-- Migration: Update Delete Functions to Use Soft Delete
-- This migration safely transitions from hard delete to soft delete
-- Created: 2025-08-20

-- 1) Create new reverse_movement function that uses soft delete
CREATE OR REPLACE FUNCTION reverse_movement(
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
  v_consumption layer_consumptions%ROWTYPE;
  v_result jsonb := '{}';
  v_restored_layers jsonb := '[]';
  v_layer_info jsonb;
  v_audit_id integer;
BEGIN
  -- Get the movement to reverse
  SELECT * INTO v_movement 
  FROM movements 
  WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movement not found: %', p_movement_id;
  END IF;
  
  -- Check if already deleted
  IF v_movement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movement % is already deleted', p_movement_id;
  END IF;
  
  -- Check if already reversed
  IF v_movement.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movement % is already reversed', p_movement_id;
  END IF;
  
  -- Only allow reversing RECEIVE and PRODUCE movements for now
  IF v_movement.type NOT IN ('RECEIVE', 'PRODUCE') THEN
    RAISE EXCEPTION 'Cannot reverse movement type: %', v_movement.type;
  END IF;
  
  -- Start transaction
  BEGIN
    -- For RECEIVE movements: remove the FIFO layer that was created
    IF v_movement.type = 'RECEIVE' THEN
      -- Prefer exact link via created_by_movement_id; fallback to heuristic if not present
      DELETE FROM fifo_layers 
      WHERE created_by_movement_id = p_movement_id
      RETURNING jsonb_build_object(
        'layer_id', id,
        'remaining_quantity', remaining_quantity,
        'original_quantity', original_quantity
      ) INTO v_layer_info;

      IF v_layer_info IS NULL THEN
        -- Fallback heuristic for legacy rows without link
        DELETE FROM fifo_layers 
        WHERE sku_id = v_movement.sku_id 
          AND original_quantity = v_movement.quantity
          AND unit_cost = v_movement.unit_cost
          AND created_at >= v_movement.created_at
          AND created_at <= v_movement.created_at + INTERVAL '1 minute'
        RETURNING jsonb_build_object(
          'layer_id', id,
          'remaining_quantity', remaining_quantity,
          'original_quantity', original_quantity
        ) INTO v_layer_info;
      END IF;
      
      IF v_layer_info IS NOT NULL THEN
        v_restored_layers := v_restored_layers || v_layer_info;
      END IF;
      
      -- Sync SKU on_hand from layers (trigger may also handle this)
      PERFORM public.sync_sku_on_hand_from_layers(v_movement.sku_id);
      
    -- For PRODUCE movements: restore consumed layers and remove produced layer
    ELSIF v_movement.type = 'PRODUCE' THEN
      -- Restore all consumed layers from layer_consumptions
      FOR v_consumption IN 
        SELECT * FROM layer_consumptions 
        WHERE movement_id = p_movement_id
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
          'new_remaining', remaining_quantity
        ) INTO v_layer_info
        FROM fifo_layers 
        WHERE id = v_consumption.layer_id;
        
        v_restored_layers := v_restored_layers || v_layer_info;
      END LOOP;
      
      -- Remove the produced layer (if it exists)
      DELETE FROM fifo_layers 
      WHERE sku_id = v_movement.sku_id 
        AND original_quantity = v_movement.quantity
        AND unit_cost = v_movement.unit_cost
        AND created_at >= v_movement.created_at
        AND created_at <= v_movement.created_at + INTERVAL '1 minute';
      
      -- Update SKU quantity (subtract the produced amount, add back consumed amounts)
      UPDATE skus 
      SET 
        on_hand = on_hand - v_movement.quantity,
        updated_at = NOW()
      WHERE id = v_movement.sku_id;
      
      -- Delete layer consumption records
      DELETE FROM layer_consumptions 
      WHERE movement_id = p_movement_id;
    END IF;
    
    -- Log to audit table before marking as reversed
    SELECT log_movement_deletion(
      v_movement,
      'REVERSE',
      p_deletion_reason,
      p_deleted_by,
      v_restored_layers,
      jsonb_build_object(
        'function', 'reverse_movement_soft',
        'timestamp', NOW(),
        'restored_layers_count', jsonb_array_length(v_restored_layers)
      )
    ) INTO v_audit_id;
    
    -- Mark movement as reversed AND soft deleted
    UPDATE movements 
    SET 
        reversed_at = NOW(),
        reversed_by = p_deleted_by,
        deleted_at = NOW(),
        deleted_by = p_deleted_by,
        deletion_reason = COALESCE(p_deletion_reason, 'Reversed movement'),
        updated_at = NOW()
    WHERE id = p_movement_id;
    
    -- Build result
    v_result := jsonb_build_object(
      'success', true,
      'movement_id', p_movement_id,
      'movement_type', v_movement.type,
      'restored_layers', v_restored_layers,
      'reversed_at', NOW(),
      'deleted_at', NOW(),
      'audit_id', v_audit_id
    );
    
    RETURN v_result;
    
  EXCEPTION WHEN OTHERS THEN
    -- Rollback will happen automatically
    RAISE EXCEPTION 'Failed to reverse movement %: %', p_movement_id, SQLERRM;
  END;
END;
$$;

-- 2) Create new delete_movement function that uses soft delete
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
  v_audit_id integer;
BEGIN
  -- Get movement info before deletion
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movement not found: %', p_movement_id;
  END IF;
  
  -- Check if already deleted
  IF v_movement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movement % is already deleted', p_movement_id;
  END IF;
  
  -- For movements that can be reversed, reverse them first
  IF v_movement.type IN ('RECEIVE', 'PRODUCE') AND v_movement.reversed_at IS NULL THEN
    -- Reverse and soft delete in one operation
    SELECT reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  ELSE
    -- For other movements or already reversed ones, just soft delete
    SELECT soft_delete_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  END IF;
  
  RETURN v_result;
END;
$$;

-- 3) Create new delete_production_group function that uses soft delete
CREATE OR REPLACE FUNCTION delete_production_group(
  p_reference text,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Use the soft delete version
  RETURN soft_delete_production_group(p_reference, p_deletion_reason, p_deleted_by);
END;
$$;

-- 4) Create admin functions for emergency hard delete (with warnings)
CREATE OR REPLACE FUNCTION admin_hard_delete_movement(
  p_movement_id integer,
  p_admin_confirmation text,
  p_deleted_by text DEFAULT 'admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_result jsonb;
BEGIN
  -- Require explicit confirmation
  IF p_admin_confirmation != 'CONFIRM_PERMANENT_DELETE' THEN
    RAISE EXCEPTION 'Admin confirmation required. Use CONFIRM_PERMANENT_DELETE as confirmation.';
  END IF;
  
  -- Get movement
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movement not found: %', p_movement_id;
  END IF;
  
  -- Log before permanent deletion
  INSERT INTO movement_deletion_audit (
    original_movement_id, original_movement_type, original_sku_id,
    original_quantity, original_total_value, original_reference,
    original_datetime, deletion_type, deletion_reason, deleted_by,
    session_info
  ) VALUES (
    v_movement.id, v_movement.type, v_movement.sku_id,
    v_movement.quantity, v_movement.total_value, v_movement.reference,
    v_movement.datetime, 'HARD_DELETE', 'Admin permanent deletion', p_deleted_by,
    jsonb_build_object('warning', 'PERMANENT_DELETION', 'timestamp', NOW())
  );
  
  -- Delete layer consumptions first
  DELETE FROM layer_consumptions WHERE movement_id = p_movement_id;
  
  -- Hard delete the movement
  DELETE FROM movements WHERE id = p_movement_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'warning', 'MOVEMENT_PERMANENTLY_DELETED',
    'movement_id', p_movement_id,
    'deleted_at', NOW()
  );
END;
$$;

-- 5) Create function to bulk soft delete movements by criteria
CREATE OR REPLACE FUNCTION bulk_soft_delete_movements(
  p_criteria jsonb,
  p_deletion_reason text DEFAULT 'Bulk deletion',
  p_deleted_by text DEFAULT 'system',
  p_dry_run boolean DEFAULT TRUE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sku_id text;
  v_type text;
  v_date_from timestamptz;
  v_date_to timestamptz;
  v_reference text;
  v_movement record;
  v_deleted_count integer := 0;
  v_results jsonb := '[]';
  v_delete_result jsonb;
BEGIN
  -- Extract criteria
  v_sku_id := p_criteria->>'sku_id';
  v_type := p_criteria->>'type';
  v_date_from := (p_criteria->>'date_from')::timestamptz;
  v_date_to := (p_criteria->>'date_to')::timestamptz;
  v_reference := p_criteria->>'reference';
  
  -- Find matching movements
  FOR v_movement IN
    SELECT * FROM movements
    WHERE deleted_at IS NULL
      AND (v_sku_id IS NULL OR sku_id = v_sku_id)
      AND (v_type IS NULL OR type::text = v_type)
      AND (v_date_from IS NULL OR datetime >= v_date_from)
      AND (v_date_to IS NULL OR datetime <= v_date_to)
      AND (v_reference IS NULL OR reference = v_reference)
    ORDER BY datetime DESC
  LOOP
    IF NOT p_dry_run THEN
      -- Actually delete
      SELECT soft_delete_movement(v_movement.id, p_deletion_reason, p_deleted_by) 
      INTO v_delete_result;
      v_results := v_results || v_delete_result;
    END IF;
    
    v_deleted_count := v_deleted_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'dry_run', p_dry_run,
    'criteria', p_criteria,
    'matching_movements', v_deleted_count,
    'deleted_movements', CASE WHEN p_dry_run THEN '[]'::jsonb ELSE v_results END
  );
END;
$$;

-- 6) Grant permissions
GRANT EXECUTE ON FUNCTION reverse_movement TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_movement TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_production_group TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_hard_delete_movement TO service_role;
GRANT EXECUTE ON FUNCTION bulk_soft_delete_movements TO authenticated, service_role;

-- 7) Add comments
COMMENT ON FUNCTION reverse_movement IS 'Reverse a movement and mark it as soft deleted';
COMMENT ON FUNCTION delete_movement IS 'Soft delete a movement (reverses if needed)';
COMMENT ON FUNCTION delete_production_group IS 'Soft delete all movements in a production group';
COMMENT ON FUNCTION admin_hard_delete_movement IS 'ADMIN ONLY: Permanently delete movement (irreversible)';
COMMENT ON FUNCTION bulk_soft_delete_movements IS 'Bulk soft delete movements by criteria (supports dry run)';

-- 8) Create migration status function
CREATE OR REPLACE FUNCTION get_soft_delete_migration_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_movements integer;
  v_active_movements integer;
  v_deleted_movements integer;
BEGIN
  SELECT COUNT(*) INTO v_total_movements FROM movements;
  SELECT COUNT(*) INTO v_active_movements FROM movements WHERE deleted_at IS NULL;
  SELECT COUNT(*) INTO v_deleted_movements FROM movements WHERE deleted_at IS NOT NULL;
  
  RETURN jsonb_build_object(
    'migration_status', 'completed',
    'total_movements', v_total_movements,
    'active_movements', v_active_movements,
    'deleted_movements', v_deleted_movements,
    'soft_delete_percentage', 
      CASE WHEN v_total_movements > 0 
        THEN ROUND((v_deleted_movements::decimal / v_total_movements) * 100, 2)
        ELSE 0 
      END,
    'can_rollback', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_soft_delete_migration_status TO authenticated, service_role;