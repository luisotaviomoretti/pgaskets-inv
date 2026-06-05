-- 060_fix_init_layers_value_date.sql
-- ONE-TIME DATA CORRECTION (not a schema change).
--
-- The opening-balance load (March 12, 2026) stored receiving_date = the load
-- date on all 120 INIT-* FIFO layers. Per the business owner, those physical
-- counts represent stock AS OF 2026-02-28. With migrations 056-059 now
-- positioning layers by receiving_date (value date), the opening balance must
-- carry its true value date for the Inventory Query to reflect it correctly
-- "as of" late February rather than mid-March.
--
-- Scope: UPDATE fifo_layers SET receiving_date = '2026-02-28'
--        WHERE created_by_movement_id IS NULL AND receiving_date = '2026-03-12'.
--   * Touches ONLY receiving_date. Quantities, costs, created_at, status,
--     and links are untouched.
--   * Today's on_hand is unaffected: both 2026-02-28 and 2026-03-12 are <=
--     today, so the layer is "alive today" either way. Triggers on
--     fifo_layers only react to quantity/deleted_at changes, not dates; the
--     AFTER-UPDATE on_hand re-sync recomputes the identical value.
--
-- Guard: the UPDATE must affect EXACTLY 120 rows. If the count differs (data
-- drifted since planning), RAISE EXCEPTION rolls the whole thing back so no
-- partial/unexpected correction is applied.
--
-- Rollback: a pre-change backup of (id, receiving_date) was captured in
-- table _backup_init_receiving_date_20260605 (Phase 0). To revert:
--   UPDATE fifo_layers f SET receiving_date = b.receiving_date
--   FROM _backup_init_receiving_date_20260605 b WHERE f.id = b.id;

BEGIN;

DO $$
DECLARE
  v_expected integer := 120;
  v_affected integer;
  v_remaining integer;
BEGIN
  -- Pre-condition: backup must exist with the expected row count.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '_backup_init_receiving_date_20260605'
  ) THEN
    RAISE EXCEPTION 'Backup table _backup_init_receiving_date_20260605 is missing — aborting data correction.';
  END IF;

  -- Apply the correction.
  UPDATE public.fifo_layers
  SET    receiving_date = DATE '2026-02-28'
  WHERE  created_by_movement_id IS NULL
    AND  receiving_date = DATE '2026-03-12';

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected <> v_expected THEN
    RAISE EXCEPTION 'Expected to update % INIT layers but updated % — rolling back.',
      v_expected, v_affected;
  END IF;

  -- Post-condition: no orphan layer should remain on the old load date.
  SELECT COUNT(*) INTO v_remaining
  FROM   public.fifo_layers
  WHERE  created_by_movement_id IS NULL
    AND  receiving_date = DATE '2026-03-12';

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'Post-check failed: % orphan layers still on 2026-03-12 — rolling back.', v_remaining;
  END IF;

  RAISE NOTICE 'INIT opening-balance correction applied: % layers moved to 2026-02-28.', v_affected;
END $$;

COMMIT;
