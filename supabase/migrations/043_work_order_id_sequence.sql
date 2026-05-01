-- 043_work_order_id_sequence.sql
-- Replace the EPOCH-based WO ID generator with a dedicated sequence.
--
-- Problem with the previous design:
--   v_work_order_id := 'WO-' || EXTRACT(EPOCH FROM NOW())::bigint;
--   Two RPC calls within the same SECOND collide on the WO PK and the
--   second insert fails with unique_violation. Under load this surfaces
--   as random "Work order creation failed" errors.
--
-- Fix:
--   - Create a dedicated SEQUENCE seeded above the highest existing epoch.
--   - The next migration (044) updates the WO RPC to use nextval() instead.
--
-- Layer IDs in create_receiving_transaction also use EXTRACT(EPOCH ...).
-- We add a second sequence and migration 045 will use it for layers.

BEGIN;

-- Compute starting values from existing data so sequences never collide
-- with historical IDs.
DO $$
DECLARE
  v_max_wo bigint;
  v_max_layer_suffix bigint;
BEGIN
  -- Highest numeric suffix in existing WO IDs (format: WO-<digits>)
  SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^WO-', '') AS BIGINT)), 0)
    INTO v_max_wo
    FROM public.work_orders
    WHERE id ~ '^WO-\d+$';

  -- Highest numeric suffix in existing layer IDs created via the EPOCH pattern
  -- (format: <sku_id>-L<digits>). Some layers were inserted manually and have
  -- different formats — we filter to the EPOCH pattern only.
  SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^.*-L', '') AS BIGINT)), 0)
    INTO v_max_layer_suffix
    FROM public.fifo_layers
    WHERE id ~ '-L\d{10,}$';

  -- Create sequences. We add a 1000 buffer to be safe against any in-flight
  -- WO/layer creation at the moment this migration runs.
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS public.work_order_seq START WITH %s INCREMENT BY 1 NO CYCLE',
    GREATEST(v_max_wo, 1) + 1000
  );

  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS public.fifo_layer_seq START WITH %s INCREMENT BY 1 NO CYCLE',
    GREATEST(v_max_layer_suffix, 1) + 1000
  );
END $$;

-- Allow authenticated users to read the sequence value (needed for nextval inside SECURITY DEFINER RPCs)
GRANT USAGE, SELECT ON SEQUENCE public.work_order_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.fifo_layer_seq TO anon, authenticated;

COMMENT ON SEQUENCE public.work_order_seq IS
  'Atomic ID generator for WO. Seeded above the highest legacy EPOCH-based id. Used by create_work_order_transaction (migration 044+).';

COMMENT ON SEQUENCE public.fifo_layer_seq IS
  'Atomic suffix for FIFO layer IDs. Used by create_receiving_transaction (migration 045+).';

COMMIT;
