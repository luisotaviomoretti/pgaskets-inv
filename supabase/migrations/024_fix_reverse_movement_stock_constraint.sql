-- Migration: Fix Reverse Movement Stock Constraint Issues
-- This migration fixes the stock constraint violation during movement reversal
-- Created: 2025-08-20

-- 1) Create improved reverse_movement function that handles stock constraints properly
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
  v_current_stock numeric;
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
      -- Check current stock before reversal
      SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
      
      -- Check if reversal would make stock negative
      IF v_current_stock - v_movement.quantity < 0 THEN
        RAISE EXCEPTION 'Cannot reverse RECEIVE movement: would result in negative stock (current: %, movement: %)', 
          v_current_stock, v_movement.quantity;
      END IF;
      
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
      
      -- Manually update stock (don't rely on trigger to avoid constraint violation)
      UPDATE skus 
      SET 
        on_hand = on_hand - v_movement.quantity,
        updated_at = NOW()
      WHERE id = v_movement.sku_id;
      
    -- For PRODUCE movements: restore consumed layers and remove produced layer
    ELSIF v_movement.type = 'PRODUCE' THEN
      -- Check current stock before reversal (for produced SKU)
      IF v_movement.sku_id IS NOT NULL THEN
        SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
        
        -- Check if reversal would make stock negative
        IF v_current_stock - v_movement.quantity < 0 THEN
          RAISE EXCEPTION 'Cannot reverse PRODUCE movement: would result in negative stock for produced SKU (current: %, movement: %)', 
            v_current_stock, v_movement.quantity;
        END IF;
      END IF;
      
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
      
      -- Update SKU quantity (subtract the produced amount)
      IF v_movement.sku_id IS NOT NULL THEN
        UPDATE skus 
        SET 
          on_hand = on_hand - v_movement.quantity,
          updated_at = NOW()
        WHERE id = v_movement.sku_id;
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
        'function', 'reverse_movement_fixed',
        'timestamp', NOW(),
        'restored_layers_count', jsonb_array_length(v_restored_layers),
        'stock_check_passed', true
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

-- 2) Create a function to check if a movement can be safely reversed
CREATE OR REPLACE FUNCTION can_reverse_movement(p_movement_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_current_stock numeric;
  v_can_reverse boolean := false;
  v_reason text := '';
BEGIN
  -- Get the movement
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'can_reverse', false,
      'reason', 'Movement not found'
    );
  END IF;
  
  -- Check if already deleted
  IF v_movement.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'can_reverse', false,
      'reason', 'Movement is already deleted'
    );
  END IF;
  
  -- Check if already reversed
  IF v_movement.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'can_reverse', false,
      'reason', 'Movement is already reversed'
    );
  END IF;
  
  -- Check movement type
  IF v_movement.type NOT IN ('RECEIVE', 'PRODUCE') THEN
    RETURN jsonb_build_object(
      'can_reverse', false,
      'reason', 'Movement type cannot be reversed'
    );
  END IF;
  
  -- Check stock constraints
  IF v_movement.sku_id IS NOT NULL THEN
    SELECT on_hand INTO v_current_stock FROM skus WHERE id = v_movement.sku_id;
    
    IF v_current_stock - v_movement.quantity < 0 THEN
      RETURN jsonb_build_object(
        'can_reverse', false,
        'reason', format('Insufficient stock: current %s, required %s', v_current_stock, v_movement.quantity),
        'current_stock', v_current_stock,
        'required_quantity', v_movement.quantity
      );
    END IF;
  END IF;
  
  -- If we get here, reversal is possible
  RETURN jsonb_build_object(
    'can_reverse', true,
    'reason', 'Movement can be safely reversed',
    'current_stock', v_current_stock,
    'movement_quantity', v_movement.quantity,
    'remaining_after_reversal', v_current_stock - v_movement.quantity
  );
END;
$$;

-- 3) Create alternative soft delete for movements that cannot be reversed
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
    COALESCE(p_deletion_reason, 'Soft delete without reversal due to stock constraints'), 
    p_deleted_by,
    jsonb_build_object('note', 'Movement deleted without FIFO reversal to preserve stock integrity')
  );
  
  -- Soft delete the movement without reversing FIFO
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
    'note', 'Movement soft deleted without FIFO reversal to preserve stock integrity'
  );
  
  RETURN v_result;
END;
$$;

-- 4) Update the main delete_movement function to handle stock constraints gracefully
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
  
  -- For movements that can be reversed, check if it's safe
  IF v_movement.type IN ('RECEIVE', 'PRODUCE') AND v_movement.reversed_at IS NULL THEN
    SELECT can_reverse_movement(p_movement_id) INTO v_can_reverse;
    
    IF (v_can_reverse->>'can_reverse')::boolean THEN
      -- Safe to reverse
      SELECT reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
    ELSE
      -- Cannot reverse safely, use soft delete without reversal
      SELECT soft_delete_movement_without_reversal(p_movement_id, 
        COALESCE(p_deletion_reason, v_can_reverse->>'reason'), 
        p_deleted_by) INTO v_result;
    END IF;
  ELSE
    -- For other movements or already reversed ones, just soft delete
    SELECT soft_delete_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  END IF;
  
  RETURN v_result;
END;
$$;

-- 5) Grant permissions
GRANT EXECUTE ON FUNCTION can_reverse_movement TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION soft_delete_movement_without_reversal TO authenticated, service_role;

-- 6) Add comments
COMMENT ON FUNCTION can_reverse_movement IS 'Check if a movement can be safely reversed without violating stock constraints';
COMMENT ON FUNCTION soft_delete_movement_without_reversal IS 'Soft delete a movement without reversing FIFO (for stock constraint cases)';
COMMENT ON FUNCTION reverse_movement IS 'Reverse a movement with stock constraint validation';
COMMENT ON FUNCTION delete_movement IS 'Smart delete that chooses between reversal and soft delete based on stock constraints';