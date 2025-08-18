-- Migration: Movement Deletion and FIFO Restoration Functions
-- This migration adds functions to safely delete/reverse movements and restore FIFO layer integrity

-- Function to reverse a movement and restore FIFO layers
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
        'function', 'reverse_movement',
        'timestamp', NOW(),
        'restored_layers_count', jsonb_array_length(v_restored_layers)
      )
    ) INTO v_audit_id;
    
    -- Mark movement as reversed
    UPDATE movements 
    SET 
      reversed_at = NOW(),
      reversed_by = p_deleted_by,
      updated_at = NOW()
    WHERE id = p_movement_id;
    
    -- Build result
    v_result := jsonb_build_object(
      'success', true,
      'movement_id', p_movement_id,
      'movement_type', v_movement.type,
      'restored_layers', v_restored_layers,
      'reversed_at', NOW(),
      'audit_id', v_audit_id
    );
    
    RETURN v_result;
    
  EXCEPTION WHEN OTHERS THEN
    -- Rollback will happen automatically
    RAISE EXCEPTION 'Failed to reverse movement %: %', p_movement_id, SQLERRM;
  END;
END;
$$;

-- Function to completely delete a movement (more aggressive than reverse)
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
  
  -- First reverse the movement to restore FIFO integrity
  SELECT reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;
  
  -- Log the complete deletion to audit table
  SELECT log_movement_deletion(
    v_movement,
    'DELETE',
    p_deletion_reason,
    p_deleted_by,
    v_result->'restored_layers',
    jsonb_build_object(
      'function', 'delete_movement',
      'timestamp', NOW(),
      'reverse_audit_id', v_result->'audit_id'
    )
  ) INTO v_audit_id;
  
  -- Then physically delete the movement record
  DELETE FROM movements WHERE id = p_movement_id;
  
  -- Update result to indicate deletion
  v_result := v_result || jsonb_build_object(
    'deleted', true,
    'deletion_audit_id', v_audit_id
  );
  
  RETURN v_result;
END;
$$;

-- Function to get movement details with consumption info (for UI confirmation)
CREATE OR REPLACE FUNCTION get_movement_deletion_info(
  p_movement_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_consumptions jsonb := '[]';
  v_consumption_info jsonb;
  v_result jsonb;
BEGIN
  -- Get movement
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Movement not found');
  END IF;
  
  -- Get consumption details if any
  SELECT jsonb_agg(
    jsonb_build_object(
      'layer_id', lc.layer_id,
      'quantity_consumed', lc.quantity_consumed,
      'unit_cost', lc.unit_cost,
      'total_cost', lc.total_cost,
      'layer_remaining', fl.remaining_quantity,
      'layer_original', fl.original_quantity
    )
  ) INTO v_consumptions
  FROM layer_consumptions lc
  JOIN fifo_layers fl ON fl.id = lc.layer_id
  WHERE lc.movement_id = p_movement_id;
  
  -- Build result
  v_result := jsonb_build_object(
    'movement_id', v_movement.id,
    'type', v_movement.type,
    'sku_id', v_movement.sku_id,
    'quantity', v_movement.quantity,
    'unit_cost', v_movement.unit_cost,
    'total_value', v_movement.total_value,
    'reference', v_movement.reference,
    'datetime', v_movement.datetime,
    'can_delete', v_movement.type IN ('RECEIVE', 'PRODUCE') AND v_movement.reversed_at IS NULL,
    'is_reversed', v_movement.reversed_at IS NOT NULL,
    'consumptions', COALESCE(v_consumptions, '[]'::jsonb)
  );
  
  RETURN v_result;
END;
$$;

-- Add indexes for better performance on deletion operations
CREATE INDEX IF NOT EXISTS idx_movements_reversed_at ON movements(reversed_at) WHERE reversed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_layer_consumptions_movement_id ON layer_consumptions(movement_id);
CREATE INDEX IF NOT EXISTS idx_fifo_layers_created_at ON fifo_layers(created_at);

-- Helper: get production group deletion info by reference
CREATE OR REPLACE FUNCTION get_production_group_deletion_info(
  p_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_produce boolean;
  v_is_any_reversed boolean;
  v_movements jsonb := '[]';
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM movements m WHERE m.reference = p_reference AND m.type = 'PRODUCE'
  ) INTO v_has_produce;

  SELECT EXISTS(
    SELECT 1 FROM movements m WHERE m.reference = p_reference AND m.reversed_at IS NOT NULL
  ) INTO v_is_any_reversed;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', m.id,
      'type', m.type,
      'sku_id', m.sku_id,
      'quantity', m.quantity,
      'total_value', m.total_value,
      'datetime', m.datetime,
      'reversed_at', m.reversed_at
    ) ORDER BY m.datetime DESC
  ), '[]'::jsonb)
  INTO v_movements
  FROM movements m
  WHERE m.reference = p_reference;

  RETURN jsonb_build_object(
    'reference', p_reference,
    'has_produce', v_has_produce,
    'any_reversed', v_is_any_reversed,
    'can_delete', v_has_produce AND NOT v_is_any_reversed,
    'movements', v_movements
  );
END;
$$;

-- Cascade delete a production group (PRODUCE + related ISSUE/WASTE sharing the same reference)
CREATE OR REPLACE FUNCTION delete_production_group(
  p_reference text,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_info jsonb;
  v_mov record;
  v_restored_layers jsonb := '[]';
  v_layer_info jsonb;
  v_deleted_count int := 0;
  v_reverse_audit_id int;
  v_delete_audit_id int;
BEGIN
  -- Validate group
  SELECT get_production_group_deletion_info(p_reference) INTO v_info;
  IF NOT (v_info->>'can_delete')::boolean THEN
    RAISE EXCEPTION 'Production group with reference % cannot be deleted. Info: %', p_reference, v_info;
  END IF;

  -- Process ISSUE and WASTE first (restore FIFO and on_hand)
  FOR v_mov IN
    SELECT * FROM movements WHERE reference = p_reference AND type IN ('ISSUE','WASTE') ORDER BY datetime DESC
  LOOP
    -- Restore each consumed layer tied to this movement
    FOR v_layer_info IN
      SELECT jsonb_build_object(
        'layer_id', lc.layer_id,
        'restored_quantity', lc.quantity_consumed,
        'unit_cost', lc.unit_cost
      )
      FROM layer_consumptions lc
      WHERE lc.movement_id = v_mov.id
    LOOP
      -- Apply restoration
      UPDATE fifo_layers fl
      SET remaining_quantity = remaining_quantity + (v_layer_info->>'restored_quantity')::numeric,
          status = CASE WHEN remaining_quantity + (v_layer_info->>'restored_quantity')::numeric > 0 THEN 'ACTIVE' ELSE status END,
          updated_at = NOW()
      WHERE fl.id = (v_layer_info->>'layer_id');

      v_restored_layers := v_restored_layers || v_layer_info;
    END LOOP;

    -- Adjust SKU on_hand back (ISSUE/WASTE have quantity negative)
    IF v_mov.sku_id IS NOT NULL THEN
      UPDATE skus SET on_hand = on_hand + ABS(v_mov.quantity), updated_at = NOW() WHERE id = v_mov.sku_id;
    END IF;

    -- Remove layer consumption records for this movement
    DELETE FROM layer_consumptions WHERE movement_id = v_mov.id;

    -- Log reverse (semantic) and delete
    SELECT log_movement_deletion(v_mov, 'REVERSE', p_deletion_reason, p_deleted_by, v_restored_layers,
            jsonb_build_object('function','delete_production_group','phase','reverse_issue_waste')) INTO v_reverse_audit_id;

    DELETE FROM movements WHERE id = v_mov.id;

    SELECT log_movement_deletion(v_mov, 'DELETE', p_deletion_reason, p_deleted_by, v_restored_layers,
            jsonb_build_object('function','delete_production_group','phase','delete_issue_waste','reverse_audit_id',v_reverse_audit_id)) INTO v_delete_audit_id;

    v_deleted_count := v_deleted_count + 1;
    v_restored_layers := '[]';
  END LOOP;

  -- Then handle PRODUCE (remove produced layer if any, decrement on_hand of produced SKU)
  FOR v_mov IN
    SELECT * FROM movements WHERE reference = p_reference AND type = 'PRODUCE' ORDER BY datetime DESC
  LOOP
    -- Remove produced layer via heuristic match (if SKU provided)
    IF v_mov.sku_id IS NOT NULL THEN
      DELETE FROM fifo_layers 
      WHERE sku_id = v_mov.sku_id 
        AND original_quantity = v_mov.quantity
        AND unit_cost = v_mov.unit_cost
        AND created_at >= v_mov.created_at
        AND created_at <= v_mov.created_at + INTERVAL '1 minute'
      RETURNING jsonb_build_object(
        'layer_id', id,
        'remaining_quantity', remaining_quantity,
        'original_quantity', original_quantity
      ) INTO v_layer_info;

      IF v_layer_info IS NOT NULL THEN
        v_restored_layers := v_restored_layers || v_layer_info;
      END IF;

      -- Decrement on_hand for produced SKU
      UPDATE skus SET on_hand = on_hand - v_mov.quantity, updated_at = NOW() WHERE id = v_mov.sku_id;
    END IF;

    -- Log reverse and delete
    SELECT log_movement_deletion(v_mov, 'REVERSE', p_deletion_reason, p_deleted_by, v_restored_layers,
            jsonb_build_object('function','delete_production_group','phase','reverse_produce')) INTO v_reverse_audit_id;

    DELETE FROM movements WHERE id = v_mov.id;

    SELECT log_movement_deletion(v_mov, 'DELETE', p_deletion_reason, p_deleted_by, v_restored_layers,
            jsonb_build_object('function','delete_production_group','phase','delete_produce','reverse_audit_id',v_reverse_audit_id)) INTO v_delete_audit_id;

    v_deleted_count := v_deleted_count + 1;
    v_restored_layers := '[]';
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'reference', p_reference,
    'deleted_count', v_deleted_count
  );
END;
$$;
