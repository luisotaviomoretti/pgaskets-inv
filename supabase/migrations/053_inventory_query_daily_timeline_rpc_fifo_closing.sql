-- 053_inventory_query_daily_timeline_rpc_fifo_closing.sql
-- Patch get_sku_daily_timeline_as_of so closing_qty comes from the
-- reconstructed FIFO state (consistent with the snapshot RPC, including
-- opening-balance INIT-* orphan layers) instead of a movements-only
-- cumulative sum.
--
-- Why: in production, ~72% of FIFO layers are opening-balance INIT-*
-- layers with no corresponding RECEIVE movement (see migration 050). A
-- cumulative sum of movements alone misses that stock, producing
-- nonsensical negative closing_qty values. Using the FIFO reconstruction
-- (which already handles orphan layers) keeps the timeline aligned with
-- the snapshot and detail RPCs.
--
-- Everything else is unchanged: same signature, same safety attributes,
-- same return shape.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_sku_daily_timeline_as_of(
  p_sku_id      text,
  p_target_date date,
  p_days_back   integer default null,
  p_tz          text    default 'America/Toronto'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower_date date;
  v_result     jsonb;
BEGIN
  IF p_days_back IS NOT NULL AND p_days_back >= 0 THEN
    v_lower_date := p_target_date - p_days_back;
  ELSE
    v_lower_date := NULL;
  END IF;

  WITH params AS (
    SELECT p_sku_id   AS sku,
           p_tz       AS tz,
           p_target_date AS target_date,
           v_lower_date  AS lower_date
  ),
  -- Active movements for the SKU within the window.
  sku_movements AS (
    SELECT m.id,
           m.datetime,
           m.type,
           m.quantity,
           (m.datetime AT TIME ZONE (SELECT tz FROM params))::date AS biz_date
    FROM   movements m, params
    WHERE  m.sku_id      = (SELECT sku FROM params)
      AND  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  (m.datetime AT TIME ZONE (SELECT tz FROM params))::date <= (SELECT target_date FROM params)
      AND  ((SELECT lower_date FROM params) IS NULL
            OR (m.datetime AT TIME ZONE (SELECT tz FROM params))::date > (SELECT lower_date FROM params))
  ),
  activity_days AS (
    SELECT DISTINCT biz_date FROM sku_movements
  ),
  by_type AS (
    SELECT biz_date,
           type::text AS type,
           COUNT(*)::integer AS cnt,
           SUM(quantity)::numeric AS qty
    FROM   sku_movements
    GROUP  BY biz_date, type
  ),
  day_totals AS (
    SELECT biz_date,
           SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END)::numeric AS gross_in,
           SUM(CASE WHEN quantity < 0 THEN quantity ELSE 0 END)::numeric AS gross_out,
           SUM(quantity)::numeric                                          AS net_delta
    FROM   sku_movements
    GROUP  BY biz_date
  ),
  -- For each activity day D, reconstruct FIFO state at end-of-day(D) in TZ.
  -- This includes orphan layers (created_by_movement_id IS NULL), so the
  -- closing qty/value match the snapshot RPC exactly.
  fifo_state AS (
    SELECT ad.biz_date,
           l.id AS layer_id,
           l.unit_cost,
           l.original_quantity,
           ( ((ad.biz_date + 1)::timestamp) AT TIME ZONE (SELECT tz FROM params) ) AS ts_end_of_day,
           COALESCE(m_create.datetime, l.created_at) AS origin_ts
    FROM   activity_days ad
    CROSS  JOIN fifo_layers l
    LEFT   JOIN movements m_create ON m_create.id = l.created_by_movement_id
    WHERE  l.sku_id = (SELECT sku FROM params)
      AND  (
            l.created_by_movement_id IS NULL
            OR (m_create.deleted_at IS NULL AND m_create.reversed_at IS NULL)
           )
  ),
  fifo_alive AS (
    SELECT fs.biz_date,
           fs.layer_id,
           fs.unit_cost,
           fs.original_quantity,
           COALESCE((
             SELECT SUM(lc.quantity_consumed)
             FROM   layer_consumptions lc
             JOIN   movements mc ON mc.id = lc.movement_id
             WHERE  lc.layer_id   = fs.layer_id
               AND  lc.deleted_at IS NULL
               AND  mc.deleted_at IS NULL
               AND  mc.reversed_at IS NULL
               AND  mc.datetime   < fs.ts_end_of_day
           ), 0)::numeric AS consumed
    FROM   fifo_state fs
    WHERE  fs.origin_ts < fs.ts_end_of_day
  ),
  fifo_closing AS (
    SELECT biz_date,
           SUM(GREATEST(original_quantity - consumed, 0))::numeric                AS closing_qty,
           SUM(GREATEST(original_quantity - consumed, 0) * unit_cost)::numeric    AS closing_value
    FROM   fifo_alive
    GROUP  BY biz_date
  ),
  per_day AS (
    SELECT ad.biz_date,
           COALESCE(fc.closing_qty,   0)::numeric AS closing_qty,
           COALESCE(fc.closing_value, 0)::numeric AS closing_value,
           CASE WHEN COALESCE(fc.closing_qty, 0) > 0
                THEN COALESCE(fc.closing_value, 0) / COALESCE(fc.closing_qty, 0)
                ELSE 0 END::numeric                AS avg_cost,
           COALESCE(dt.gross_in, 0)::numeric       AS gross_in,
           COALESCE(dt.gross_out, 0)::numeric      AS gross_out,
           COALESCE(dt.net_delta, 0)::numeric      AS net_delta
    FROM   activity_days ad
    LEFT   JOIN fifo_closing fc ON fc.biz_date = ad.biz_date
    LEFT   JOIN day_totals  dt ON dt.biz_date = ad.biz_date
  ),
  with_deltas AS (
    SELECT pd.*,
           LAG(closing_qty)   OVER (ORDER BY biz_date) AS prev_qty,
           LAG(closing_value) OVER (ORDER BY biz_date) AS prev_value
    FROM   per_day pd
  ),
  by_type_arr AS (
    SELECT biz_date,
           jsonb_agg(jsonb_build_object(
             'type', type,
             'count', cnt,
             'qty',   qty
           ) ORDER BY type) AS movements_by_type
    FROM   by_type
    GROUP  BY biz_date
  ),
  rows AS (
    SELECT wd.biz_date,
           COALESCE(bta.movements_by_type, '[]'::jsonb) AS movements_by_type,
           wd.gross_in,
           wd.gross_out,
           wd.net_delta,
           wd.closing_qty,
           wd.closing_value,
           wd.avg_cost,
           (wd.closing_qty   - COALESCE(wd.prev_qty,   wd.closing_qty))::numeric   AS delta_qty,
           (wd.closing_value - COALESCE(wd.prev_value, wd.closing_value))::numeric AS delta_value
    FROM   with_deltas wd
    LEFT   JOIN by_type_arr bta ON bta.biz_date = wd.biz_date
    ORDER  BY wd.biz_date DESC
  )
  SELECT jsonb_build_object(
           'sku_id',      p_sku_id,
           'target_date', p_target_date,
           'tz',          p_tz,
           'lower_date',  v_lower_date,
           'days',        COALESCE(jsonb_agg(jsonb_build_object(
                            'date',              biz_date,
                            'movements_by_type', movements_by_type,
                            'gross_in',          gross_in,
                            'gross_out',         gross_out,
                            'net_delta',         net_delta,
                            'closing_qty',       closing_qty,
                            'closing_value',     closing_value,
                            'avg_cost',          avg_cost,
                            'delta_qty',         delta_qty,
                            'delta_value',       delta_value
                          )), '[]'::jsonb)
         )
  INTO  v_result
  FROM  rows;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_sku_daily_timeline_as_of(text, date, integer, text) IS
  'Per-SKU daily activity timeline up to p_target_date (end-of-day in tz). Emits one entry per calendar day with movement activity. closing_qty / closing_value / avg_cost are reconstructed from FIFO layers (orphan layers included, mirroring migration 050) so the timeline stays consistent with the snapshot RPC. delta_* are diffs vs. the previous emitted day (0 for the earliest day in the window).';
