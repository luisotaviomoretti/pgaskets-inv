-- 016_update_delete_reverse_functions.sql
-- Safely replace delete_movement and reverse_movement by dropping conflicting signatures first

BEGIN;

-- Drop old versions if signatures/return types differ in target DB
DROP FUNCTION IF EXISTS public.delete_movement(integer, text, text);
DROP FUNCTION IF EXISTS public.reverse_movement(integer, text, text);

-- Recreate reverse_movement (updated logic uses created_by_movement_id and sync)
CREATE OR REPLACE FUNCTION public.reverse_movement(
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
  SELECT * INTO v_movement FROM public.movements WHERE id = p_movement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movement not found: %', p_movement_id; END IF;
  IF v_movement.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'Movement % is already reversed', p_movement_id; END IF;
  IF v_movement.type NOT IN ('RECEIVE','PRODUCE') THEN RAISE EXCEPTION 'Cannot reverse movement type: %', v_movement.type; END IF;

  BEGIN
    IF v_movement.type = 'RECEIVE' THEN
      DELETE FROM public.fifo_layers
      WHERE created_by_movement_id = p_movement_id
      RETURNING jsonb_build_object(
        'layer_id', id,
        'remaining_quantity', remaining_quantity,
        'original_quantity', original_quantity
      ) INTO v_layer_info;

      IF v_layer_info IS NULL THEN
        DELETE FROM public.fifo_layers 
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

      IF v_layer_info IS NOT NULL THEN v_restored_layers := v_restored_layers || v_layer_info; END IF;
      PERFORM public.sync_sku_on_hand_from_layers(v_movement.sku_id);

    ELSIF v_movement.type = 'PRODUCE' THEN
      FOR v_consumption IN SELECT * FROM public.layer_consumptions WHERE movement_id = p_movement_id LOOP
        UPDATE public.fifo_layers 
        SET remaining_quantity = remaining_quantity + v_consumption.quantity_consumed,
            status = CASE WHEN remaining_quantity + v_consumption.quantity_consumed > 0 THEN 'ACTIVE' ELSE status END,
            updated_at = NOW()
        WHERE id = v_consumption.layer_id;

        SELECT jsonb_build_object('layer_id', id, 'restored_quantity', v_consumption.quantity_consumed, 'new_remaining', remaining_quantity)
          INTO v_layer_info
        FROM public.fifo_layers WHERE id = v_consumption.layer_id;

        v_restored_layers := v_restored_layers || v_layer_info;
      END LOOP;

      DELETE FROM public.fifo_layers 
      WHERE sku_id = v_movement.sku_id 
        AND original_quantity = v_movement.quantity
        AND unit_cost = v_movement.unit_cost
        AND created_at >= v_movement.created_at
        AND created_at <= v_movement.created_at + INTERVAL '1 minute';

      UPDATE public.skus SET on_hand = on_hand - v_movement.quantity, updated_at = NOW() WHERE id = v_movement.sku_id;
      DELETE FROM public.layer_consumptions WHERE movement_id = p_movement_id;
    END IF;

    SELECT log_movement_deletion(
      v_movement,
      'REVERSE',
      p_deletion_reason,
      p_deleted_by,
      v_restored_layers,
      jsonb_build_object('function','reverse_movement','timestamp',NOW(),'restored_layers_count',jsonb_array_length(v_restored_layers))
    ) INTO v_audit_id;

    UPDATE public.movements 
    SET reversed_at = NOW(), reversed_by = p_deleted_by, updated_at = NOW()
    WHERE id = p_movement_id;

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
    RAISE EXCEPTION 'Failed to reverse movement %: %', p_movement_id, SQLERRM;
  END;
END;
$$;

-- Recreate delete_movement
CREATE OR REPLACE FUNCTION public.delete_movement(
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
  SELECT * INTO v_movement FROM public.movements WHERE id = p_movement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movement not found: %', p_movement_id; END IF;

  SELECT public.reverse_movement(p_movement_id, p_deletion_reason, p_deleted_by) INTO v_result;

  SELECT log_movement_deletion(
    v_movement,
    'DELETE',
    p_deletion_reason,
    p_deleted_by,
    v_result->'restored_layers',
    jsonb_build_object('function','delete_movement','timestamp',NOW(),'reverse_audit_id',v_result->'audit_id')
  ) INTO v_audit_id;

  DELETE FROM public.movements WHERE id = p_movement_id;

  v_result := v_result || jsonb_build_object('deleted', true, 'deletion_audit_id', v_audit_id);
  RETURN v_result;
END;
$$;

COMMIT;
