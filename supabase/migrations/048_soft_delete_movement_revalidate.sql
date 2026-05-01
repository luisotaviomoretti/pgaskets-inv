-- 048_soft_delete_movement_revalidate.sql
-- Move the RECEIVE-deletion safety check into the RPC and run it AFTER
-- acquiring row-level locks on the affected FIFO layers. This eliminates
-- the race window between the JS-side `canDeleteReceivingMovement` lookup
-- and the call to `soft_delete_movement`.
--
-- Behavior change:
--   - RECEIVE movements: the function locks every FIFO layer created by the
--     movement (FOR UPDATE), then verifies that no quantity has been consumed
--     (i.e. remaining_quantity = original_quantity for every active layer).
--     If any layer has been consumed, the function raises with a stable
--     INTEGRITY_VIOLATION JSON envelope and the soft delete does NOT happen.
--   - Non-RECEIVE movements: behavior unchanged (no safety check applies).
--
-- Idempotent: re-running the migration is safe (CREATE OR REPLACE).

BEGIN;

CREATE OR REPLACE FUNCTION public.soft_delete_movement(
  p_movement_id integer,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement      public.movements%ROWTYPE;
  v_consumed_count integer;
  v_result        jsonb;
BEGIN
  -- 1) Fetch + lock the movement itself
  SELECT * INTO v_movement
  FROM public.movements
  WHERE id = p_movement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'NOT_FOUND',
      'detail', format('Movement not found: %s', p_movement_id)
    )::text USING ERRCODE = 'P0002';
  END IF;

  IF v_movement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION '%', jsonb_build_object(
      'code', 'INVALID_INPUT',
      'detail', format('Movement %s is already deleted', p_movement_id)
    )::text USING ERRCODE = '23514';
  END IF;

  -- 2) For RECEIVE movements, lock the layers this movement created and
  --    verify none have been consumed.
  IF v_movement.type = 'RECEIVE' THEN
    PERFORM 1
    FROM public.fifo_layers
    WHERE created_by_movement_id = p_movement_id
    FOR UPDATE;

    SELECT COUNT(*) INTO v_consumed_count
    FROM public.fifo_layers
    WHERE created_by_movement_id = p_movement_id
      AND status = 'ACTIVE'
      AND remaining_quantity < original_quantity;

    IF v_consumed_count > 0 THEN
      RAISE EXCEPTION '%', jsonb_build_object(
        'code', 'INTEGRITY_VIOLATION',
        'detail', format(
          'Cannot soft-delete RECEIVE movement %s: %s of its FIFO layer(s) have been consumed by Work Orders',
          p_movement_id, v_consumed_count
        ),
        'movement_id', p_movement_id,
        'consumed_layer_count', v_consumed_count
      )::text USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 3) Soft delete
  UPDATE public.movements
  SET
    deleted_at      = NOW(),
    deleted_by      = p_deleted_by,
    deletion_reason = p_deletion_reason,
    updated_at      = NOW()
  WHERE id = p_movement_id;

  v_result := jsonb_build_object(
    'success',         true,
    'movement_id',     p_movement_id,
    'movement_type',   v_movement.type,
    'deleted_at',      NOW(),
    'deleted_by',      p_deleted_by,
    'deletion_reason', p_deletion_reason
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.soft_delete_movement(integer, text, text)
  TO anon, authenticated;

COMMIT;
