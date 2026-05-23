-- 050_inventory_query_snapshot_rpc_orphan_layers.sql
-- Patch get_inventory_snapshot_as_of to handle "orphan" FIFO layers — layers
-- whose created_by_movement_id is NULL because they were loaded directly by
-- a stock-load / opening-balance script (the INIT-* layer family), not via
-- the normal RECEIVE flow.
--
-- Rationale (discovered during Phase 2 parity test):
--   * 120 of 166 layers in production have created_by_movement_id IS NULL,
--     holding 167,359 units / $234,884 in active value.
--   * The original RPC INNER-JOINed movements, so it silently excluded all
--     of that opening-balance stock, producing severe under-counting vs.
--     skus.on_hand.
--
-- Fix: treat each layer's origin timestamp as
--   COALESCE(m_create.datetime, l.created_at)
-- and only apply the deleted_at / reversed_at exclusions when there *is* a
-- linked movement. This is purely an additive change to a read-only RPC;
-- the function signature, return shape, and security attributes are
-- unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_inventory_snapshot_as_of(
  p_target_date date,
  p_tz          text default 'America/Toronto',
  p_sku_filter  text default null,
  p_limit       integer default 100,
  p_offset      integer default 0,
  p_sort        text default 'sku_code_asc'
)
RETURNS TABLE (
  sku_id           text,
  description      text,
  product_type     text,
  product_category text,
  unit             text,
  on_hand          numeric,
  average_cost     numeric,
  total_value      numeric,
  active_layers    integer,
  total_count      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cutoff AS (
    SELECT ((p_target_date + 1)::timestamp AT TIME ZONE p_tz) AS ts_end
  ),
  -- Layers that existed and were "live" on or before the cutoff.
  -- A layer counts if EITHER:
  --   (a) it has a linked RECEIVE movement that's not deleted/reversed and
  --       whose datetime is before the cutoff, OR
  --   (b) it has no linked movement (opening-balance / orphan) and its own
  --       created_at is before the cutoff.
  active_layers AS (
    SELECT l.sku_id,
           l.id           AS layer_id,
           l.unit_cost,
           l.original_quantity,
           COALESCE(m_create.datetime, l.created_at) AS layer_origin_ts
    FROM   fifo_layers l
    LEFT   JOIN movements m_create ON m_create.id = l.created_by_movement_id
    WHERE  COALESCE(m_create.datetime, l.created_at) < (SELECT ts_end FROM cutoff)
      AND  (
            -- Orphan layer: no movement link, always counted.
            l.created_by_movement_id IS NULL
            OR
            -- Linked layer: source movement must still be live.
            (m_create.deleted_at IS NULL AND m_create.reversed_at IS NULL)
           )
  ),
  consumed_to_date AS (
    SELECT lc.layer_id,
           SUM(lc.quantity_consumed) AS consumed
    FROM   layer_consumptions lc
    JOIN   movements mc ON mc.id = lc.movement_id
    WHERE  lc.deleted_at IS NULL
      AND  mc.deleted_at IS NULL
      AND  mc.reversed_at IS NULL
      AND  mc.datetime    < (SELECT ts_end FROM cutoff)
    GROUP BY lc.layer_id
  ),
  layer_state AS (
    SELECT al.sku_id,
           al.layer_id,
           al.unit_cost,
           GREATEST(al.original_quantity - COALESCE(c.consumed, 0), 0)::numeric AS qty_remaining
    FROM   active_layers al
    LEFT   JOIN consumed_to_date c ON c.layer_id = al.layer_id
  ),
  per_sku AS (
    SELECT sku_id,
           SUM(qty_remaining)                                                       AS on_hand,
           SUM(qty_remaining * unit_cost)                                            AS total_value,
           CASE WHEN SUM(qty_remaining) > 0
                THEN SUM(qty_remaining * unit_cost) / SUM(qty_remaining)
                ELSE 0 END                                                           AS average_cost,
           COUNT(*) FILTER (WHERE qty_remaining > 0)::integer                        AS active_layers
    FROM   layer_state
    GROUP  BY sku_id
  ),
  filtered AS (
    SELECT s.id                              AS sku_id,
           s.description,
           s.type::text                       AS product_type,
           s.product_category,
           s.unit,
           COALESCE(p.on_hand, 0)             AS on_hand,
           COALESCE(p.average_cost, 0)        AS average_cost,
           COALESCE(p.total_value, 0)         AS total_value,
           COALESCE(p.active_layers, 0)       AS active_layers
    FROM   skus s
    LEFT   JOIN per_sku p ON p.sku_id = s.id
    WHERE  s.active = true
      AND  (
            p_sku_filter IS NULL
         OR s.id          ILIKE '%' || p_sku_filter || '%'
         OR s.description ILIKE '%' || p_sku_filter || '%'
           )
  )
  SELECT  sku_id,
          description,
          product_type,
          product_category,
          unit,
          on_hand,
          average_cost,
          total_value,
          active_layers,
          COUNT(*) OVER ()::bigint AS total_count
  FROM    filtered
  ORDER BY
    CASE WHEN p_sort = 'sku_code_asc'     THEN sku_id      END ASC  NULLS LAST,
    CASE WHEN p_sort = 'sku_code_desc'    THEN sku_id      END DESC NULLS LAST,
    CASE WHEN p_sort = 'on_hand_desc'     THEN on_hand     END DESC NULLS LAST,
    CASE WHEN p_sort = 'on_hand_asc'      THEN on_hand     END ASC  NULLS LAST,
    CASE WHEN p_sort = 'total_value_desc' THEN total_value END DESC NULLS LAST,
    CASE WHEN p_sort = 'total_value_asc'  THEN total_value END ASC  NULLS LAST,
    sku_id ASC
  LIMIT  GREATEST(LEAST(p_limit, 1000), 1)
  OFFSET GREATEST(p_offset, 0);
$$;

COMMENT ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) IS
  'Reconstructs per-SKU on_hand / average_cost / total_value as of end-of-day in the given timezone. Read-only. Treats fifo_layers with NULL created_by_movement_id (opening-balance/INIT-* layers) as originating at their own created_at, so historical reconstruction includes script-loaded stock. Filters deleted_at/reversed_at on linked movements and on layer_consumptions. Sort is validated via CASE whitelist.';

-- Grants are preserved by CREATE OR REPLACE, but reassert defensively in
-- case anyone has been editing them by hand.
REVOKE ALL     ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) TO authenticated, service_role;

COMMIT;
