-- 049_inventory_query_snapshot_rpc.sql
-- Read-only RPC that reconstructs per-SKU on-hand, average cost, and total
-- value as of the end of a given calendar day in a chosen timezone.
--
-- Reconstruction is deterministic over append-only data:
--   * movements:          deleted_at IS NULL AND reversed_at IS NULL
--                         AND datetime < end-of-day(target_date, tz)
--   * layer_consumptions: deleted_at IS NULL  (cascades from movement deletion
--                         per migration 029) AND movement matches above filter
--   * fifo_layers:        created_by_movement_id points to a qualifying RECEIVE
--                         movement (per migration 014)
--
-- Pagination is offset/limit (sort keys include derived aggregates where
-- keyset is awkward; SKU counts are in the thousands). total_count is
-- returned via window function so the UI can render a pager.
--
-- Safety:
--   * Function is STABLE and SECURITY DEFINER, like other read RPCs.
--   * No writes, no DDL on existing objects.
--   * Sort parameter is validated via a CASE whitelist (no dynamic SQL).
--   * Grants: authenticated + service_role only; revoked from public.

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
    -- End of the chosen calendar day in the requested timezone, expressed as
    -- a UTC timestamptz: take midnight of (target_date + 1) in the local TZ
    -- and treat the resulting wall-clock as belonging to that TZ.
    SELECT ((p_target_date + 1)::timestamp AT TIME ZONE p_tz) AS ts_end
  ),
  -- Layers whose creating RECEIVE movement happened on or before the cutoff
  -- and is still considered "live" (not soft-deleted, not reversed).
  active_layers AS (
    SELECT l.sku_id,
           l.id           AS layer_id,
           l.unit_cost,
           l.original_quantity
    FROM   fifo_layers l
    JOIN   movements m_create ON m_create.id = l.created_by_movement_id
    WHERE  m_create.deleted_at  IS NULL
      AND  m_create.reversed_at IS NULL
      AND  m_create.datetime    < (SELECT ts_end FROM cutoff)
  ),
  -- Consumption (ISSUE/WASTE/PRODUCE input) charged to each layer by movements
  -- that happened on or before the cutoff and are still live. Soft-deleted
  -- consumptions cascade from soft-deleted movements (migration 029), so the
  -- two filters are redundant-but-defensive.
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
  -- Remaining quantity per layer at the cutoff. GREATEST(...,0) is purely
  -- defensive against floating-point drift; the schema CHECK already enforces
  -- remaining >= 0 at write time.
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
    sku_id ASC  -- deterministic tiebreaker
  LIMIT  GREATEST(LEAST(p_limit, 1000), 1)   -- clamp [1, 1000]
  OFFSET GREATEST(p_offset, 0);
$$;

COMMENT ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) IS
  'Reconstructs per-SKU on_hand / average_cost / total_value as of end-of-day in the given timezone. Read-only; reconstruction is deterministic over append-only movements + layer_consumptions + fifo_layers. Filters deleted_at IS NULL and reversed_at IS NULL. Sort is validated via CASE whitelist.';

-- Lock down execution. Reads through this function are equivalent to reading
-- skus + movements + fifo_layers + layer_consumptions, all of which already
-- have RLS policies granting access to authenticated users.
-- Lock down execution to authenticated callers only. Explicit REVOKE from
-- anon is required because the project-wide default GRANT to anon survives
-- the REVOKE FROM public on a fresh function.
REVOKE ALL    ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) TO authenticated, service_role;

COMMIT;
