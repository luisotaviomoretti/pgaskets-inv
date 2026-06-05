-- 056_inventory_query_snapshot_value_date.sql
-- Reanchor get_inventory_snapshot_as_of from RECORDING time to VALUE date.
--
-- Problem (customer complaint, confirmed in data):
--   The snapshot positioned each FIFO layer in time by its *recording*
--   timestamp — COALESCE(m_create.datetime, l.created_at) — i.e. when the
--   row was entered, not the business date it represents. RECEIVE movements
--   store datetime = NOW() while the user-entered value date lives in
--   fifo_layers.receiving_date. Opening-balance INIT-* layers carry their
--   value date in receiving_date too. Result: stock counted "as of" a past
--   date was invisible if it was data-entered later (avg lag 21.7 days for
--   RECEIVE; the entire opening balance was off until its load date).
--
-- Fix:
--   Gate each layer's existence by l.receiving_date <= p_target_date (the
--   chosen calendar day in p_tz). receiving_date is the single source of the
--   value date for BOTH linked (RECEIVE) and orphan (INIT-*) layers, so this
--   one change fixes both root causes for the snapshot.
--
-- Deliberately UNCHANGED:
--   * Consumption gating stays on mc.datetime < end-of-day(target_date).
--     Consumptions originate from Work Orders, whose RPC already writes
--     movements.datetime = the user-chosen work_order_date (see migration
--     044). So datetime IS already the value date for consumption — no
--     asymmetry, just using the column that holds the value date on each side.
--   * Same-day FIFO ordering determinism is preserved by keeping the origin
--     timestamp as a tiebreaker where ordering matters (see detail RPC 057).
--   * Signature, return shape, STABLE/SECURITY DEFINER, sort whitelist, and
--     grants are identical to migration 050.
--
-- Safety: read-only, idempotent (CREATE OR REPLACE), no DDL on existing
-- objects, no writes. Reverts by re-applying migration 050.

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
    -- End-of-day cutoff (UTC timestamptz) for the requested calendar day —
    -- still used to gate CONSUMPTION by recording time (datetime).
    SELECT ((p_target_date + 1)::timestamp AT TIME ZONE p_tz) AS ts_end
  ),
  -- Layers that EXIST as of the value date. A layer counts if EITHER:
  --   (a) it has a live linked RECEIVE movement (not deleted/reversed), OR
  --   (b) it is an orphan/opening-balance layer (no movement link),
  -- AND in both cases its VALUE date (receiving_date) is on or before the
  -- target calendar day. This is the core reanchor: receiving_date instead
  -- of COALESCE(m_create.datetime, l.created_at).
  active_layers AS (
    SELECT l.sku_id,
           l.id           AS layer_id,
           l.unit_cost,
           l.original_quantity
    FROM   fifo_layers l
    LEFT   JOIN movements m_create ON m_create.id = l.created_by_movement_id
    WHERE  l.receiving_date <= p_target_date
      AND  (
            l.created_by_movement_id IS NULL
            OR (m_create.deleted_at IS NULL AND m_create.reversed_at IS NULL)
           )
  ),
  -- Consumption charged to each layer by movements on or before the cutoff
  -- and still live. UNCHANGED from 050: datetime is already the value date
  -- for consumption (Work Orders write the user's chosen date).
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
  'Reconstructs per-SKU on_hand / average_cost / total_value as of end-of-day in the given timezone. Layers are positioned in time by their VALUE date (fifo_layers.receiving_date <= target_date) — this holds for both RECEIVE-linked and orphan/opening-balance (INIT-*) layers. Consumption is gated by movements.datetime (already the value date, since Work Orders write the user-chosen date). Read-only. Filters deleted_at/reversed_at on linked movements and on layer_consumptions. Sort validated via CASE whitelist. Reverts to migration 050 (recording-time semantics) if re-applied.';

-- Preserve the lockdown posture from 049/050.
REVOKE ALL     ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text) TO authenticated, service_role;

COMMIT;
