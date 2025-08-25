-- Migration: Fix Delete Movement Logic to Avoid Stock Constraint Issues
-- This migration ensures delete_movement always works regardless of stock constraints
-- Created: 2025-08-20

-- 1) Update the trigger to NOT automatically adjust stock on soft delete
CREATE OR REPLACE FUNCTION handle_movement_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- Only handle hard operations, not soft delete operations
    -- Soft delete should not automatically adjust stock to avoid constraint violations
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Update the main delete_movement function to be more defensive
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
  v_can_reverse jsonb;
  v_result jsonb;
  v_current_stock numeric;
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
  
  -- For RECEIVE movements, check stock constraints first
  IF v_movement.type = 'RECEIVE' AND v_movement.sku_id IS NOT NULL THEN
    SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
    
    -- If would cause negative stock, use soft delete without reversal
    IF v_current_stock - v_movement.quantity < 0 THEN
      -- Use soft delete without FIFO reversal
      SELECT soft_delete_movement_without_reversal(p_movement_id, 
        COALESCE(p_deletion_reason, 'Cannot reverse due to insufficient stock'), 
        p_deleted_by) INTO v_result;
      RETURN v_result;
    END IF;
  END IF;
  
  -- For PRODUCE movements, check if we can reverse
  IF v_movement.type = 'PRODUCE' THEN
    -- Check if we can safely reverse
    BEGIN
      SELECT can_reverse_movement(p_movement_id) INTO v_can_reverse;
      
      IF NOT (v_can_reverse->>'can_reverse')::boolean THEN
        -- Cannot reverse safely, use soft delete without reversal
        SELECT soft_delete_movement_without_reversal(p_movement_id, 
          COALESCE(p_deletion_reason, v_can_reverse->>'reason'), 
          p_deleted_by) INTO v_result;
        RETURN v_result;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- If checking fails, default to soft delete without reversal
      SELECT soft_delete_movement_without_reversal(p_movement_id, 
        COALESCE(p_deletion_reason, 'Cannot check reversal safety'), 
        p_deleted_by) INTO v_result;
      RETURN v_result;
    END;
  END IF;
  
  -- If we get here, try normal reversal for RECEIVE/PRODUCE
  IF v_movement.type IN ('RECEIVE', 'PRODUCE') AND v_movement.reversed_at IS NULL THEN
    BEGIN
      SELECT reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
    EXCEPTION WHEN OTHERS THEN
      -- If reversal fails for any reason, fall back to soft delete without reversal
      SELECT soft_delete_movement_without_reversal(p_movement_id, 
        COALESCE(p_deletion_reason, 'Reversal failed: ' || SQLERRM), 
        p_deleted_by) INTO v_result;
    END;
  ELSE
    -- For other movements or already reversed ones, just soft delete
    SELECT soft_delete_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  END IF;
  
  RETURN v_result;
END;
$$;

-- 3) Create a simpler, safer reverse_movement that doesn't touch skus table directly
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
      -- Remove the FIFO layer (this will trigger the sync function)
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
      
      -- Let the sync function handle the SKU update
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
      
      -- Let the sync function handle the SKU update
      IF v_movement.sku_id IS NOT NULL THEN
        PERFORM public.sync_sku_on_hand_from_layers(v_movement.sku_id);
      END IF;
      
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
        'function', 'reverse_movement_safe',
        'timestamp', NOW(),
        'restored_layers_count', jsonb_array_length(v_restored_layers),
        'uses_sync_function', true
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

-- 4) Ensure soft_delete_movement_without_reversal doesn't touch stock
CREATE OR REPLACE FUNCTION soft_delete_movement_without_reversal(
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
BEGIN
  -- Get the movement
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movement not found: %', p_movement_id;
  END IF;
  
  -- Check if already deleted
  IF v_movement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movement % is already deleted', p_movement_id;
  END IF;
  
  -- Log to audit table
  INSERT INTO movement_deletion_audit (
    original_movement_id, original_movement_type, original_sku_id,
    original_quantity, original_total_value, original_reference,
    original_datetime, deletion_type, deletion_reason, deleted_by,
    session_info
  ) VALUES (
    v_movement.id, v_movement.type, v_movement.sku_id,
    v_movement.quantity, v_movement.total_value, v_movement.reference,
    v_movement.datetime, 'SOFT_DELETE_NO_REVERSAL', 
    COALESCE(p_deletion_reason, 'Soft delete without reversal to preserve stock integrity'), 
    p_deleted_by,
    jsonb_build_object(
      'note', 'Movement deleted without FIFO reversal to preserve stock integrity',
      'preserves_stock_levels', true
    )
  );
  
  -- Soft delete the movement without any stock adjustments
  UPDATE movements 
  SET 
    deleted_at = NOW(),
    deleted_by = p_deleted_by,
    deletion_reason = COALESCE(p_deletion_reason, 'Soft delete without reversal'),
    updated_at = NOW()
  WHERE id = p_movement_id;
  
  -- Build result
  v_result := jsonb_build_object(
    'success', true,
    'movement_id', p_movement_id,
    'movement_type', v_movement.type,
    'deleted_at', NOW(),
    'deleted_by', p_deleted_by,
    'deletion_reason', COALESCE(p_deletion_reason, 'Soft delete without reversal'),
    'note', 'Movement soft deleted without FIFO reversal to preserve stock integrity',
    'preserves_stock_levels', true
  );
  
  RETURN v_result;
END;
$$;

-- 5) Add a test function to check movement deletion safety
CREATE OR REPLACE FUNCTION test_movement_deletion_safety(p_movement_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_current_stock numeric;
  v_result jsonb;
BEGIN
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Movement not found');
  END IF;
  
  IF v_movement.sku_id IS NOT NULL THEN
    SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
  END IF;
  
  v_result := jsonb_build_object(
    'movement_id', p_movement_id,
    'movement_type', v_movement.type,
    'movement_quantity', v_movement.quantity,
    'current_stock', v_current_stock,
    'would_be_negative', CASE 
      WHEN v_movement.type = 'RECEIVE' AND v_current_stock - v_movement.quantity < 0 
      THEN true 
      ELSE false 
    END,
    'recommended_action', CASE 
      WHEN v_movement.type = 'RECEIVE' AND v_current_stock - v_movement.quantity < 0 
      THEN 'soft_delete_without_reversal'
      ELSE 'can_reverse_safely'
    END
  );
  
  RETURN v_result;
END;
$$;

-- 6) Grant permissions
GRANT EXECUTE ON FUNCTION test_movement_deletion_safety TO authenticated, service_role;

-- 7) Add comment
COMMENT ON FUNCTION delete_movement IS 'Smart delete that always succeeds by choosing safe deletion method';
COMMENT ON FUNCTION test_movement_deletion_safety IS 'Test function to check what deletion method would be used';