-- 052_inventory_query_daily_timeline_rpc.sql
-- Per-SKU daily timeline up to and including p_target_date in the requested
-- timezone. Emits one row per *calendar day with movement activity* for the
-- SKU in the window. For each such day:
--
--   * movements_by_type — array of {type, count, qty} aggregating that day's
--     movements grouped by movement_type.
--   * gross_in / gross_out — sums of positive / negative movement quantities
--     on that day.
--   * net_delta — gross_in + gross_out (signed sum of the day's movements).
--   * closing_qty — cumulative SUM(quantity) over all active movements with
--     m.datetime < end_of_day(D) in TZ. This is the on-hand at end of D.
--   * closing_value — SUM(qty_remaining_at_eod * unit_cost) over the SKU's
--     FIFO layers, reconstructed via the same logic used in the snapshot
--     RPC (with orphan-layer support — see migration 050).
--   * avg_cost — closing_value / closing_qty (0 when closing_qty <= 0).
--   * delta_qty / delta_value — change vs. the previous emitted day in the
--     timeline (forward delta).
--
-- Read-only. STABLE, SECURITY DEFINER, no DDL on existing objects, no
-- writes. Same grant pattern as 049/050/051.
--
-- Parameters:
--   p_sku_id      required.
--   p_target_date inclusive upper bound (end-of-day in tz).
--   p_days_back   if NOT NULL, restrict to (p_target_date - p_days_back, p_target_date].
--                 If NULL, include every day with activity up to p_target_date.
--   p_tz          default 'America/Toronto'.

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
    v_lower_date := NULL;  -- unbounded below
  END IF;

  WITH params AS (
    SELECT p_sku_id   AS sku,
           p_tz       AS tz,
           p_target_date AS target_date,
           v_lower_date  AS lower_date
  ),
  -- All active movements for the SKU up to and including target_date.
  sku_movements AS (
    SELECT m.id,
           m.datetime,
           m.type,
           m.quantity,
           -- Calendar day in the requested TZ, used to bucket each
           -- movement into a "business day".
           (m.datetime AT TIME ZONE (SELECT tz FROM params))::date AS biz_date
    FROM   movements m, params
    WHERE  m.sku_id      = (SELECT sku FROM params)
      AND  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  (m.datetime AT TIME ZONE (SELECT tz FROM params))::date <= (SELECT target_date FROM params)
      AND  ((SELECT lower_date FROM params) IS NULL
            OR (m.datetime AT TIME ZONE (SELECT tz FROM params))::date > (SELECT lower_date FROM params))
  ),
  -- Distinct days where movements actually happened.
  activity_days AS (
    SELECT DISTINCT biz_date FROM sku_movements
  ),
  -- Per-(day, type) aggregation of the day's movements.
  by_type AS (
    SELECT biz_date,
           type::text AS type,
           COUNT(*)::integer AS cnt,
           SUM(quantity)::numeric AS qty
    FROM   sku_movements
    GROUP  BY biz_date, type
  ),
  -- Day totals (signed delta + gross in/out).
  day_totals AS (
    SELECT biz_date,
           SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END)::numeric AS gross_in,
           SUM(CASE WHEN quantity < 0 THEN quantity ELSE 0 END)::numeric AS gross_out,
           SUM(quantity)::numeric                                          AS net_delta
    FROM   sku_movements
    GROUP  BY biz_date
  ),
  -- All movements for the SKU up to AND INCLUDING the target_date — used
  -- to compute closing_qty by cumulative sum filtered up to each biz_date.
  -- This is independent of the lower_date filter (we need history before
  -- the window starts to get the right closing balance on day 0 of the window).
  all_sku_movements AS (
    SELECT (m.datetime AT TIME ZONE (SELECT tz FROM params))::date AS biz_date,
           m.quantity
    FROM   movements m, params
    WHERE  m.sku_id      = (SELECT sku FROM params)
      AND  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  (m.datetime AT TIME ZONE (SELECT tz FROM params))::date <= (SELECT target_date FROM params)
  ),
  -- For each activity day D, compute closing_qty = sum of all quantity
  -- where biz_date <= D.
  closing_qty AS (
    SELECT ad.biz_date,
           COALESCE((
             SELECT SUM(quantity)
             FROM   all_sku_movements
             WHERE  biz_date <= ad.biz_date
           ), 0)::numeric AS qty
    FROM   activity_days ad
  ),
  -- For each activity day D, compute closing_value from FIFO layers, with
  -- the same orphan-layer handling as the snapshot RPC. Layers count if
  -- their origin (movement.datetime, or layer.created_at if orphan) is
  -- before end-of-day(D) in TZ. Consumption: layer_consumptions whose
  -- movement is live and dated before end-of-day(D).
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
           SUM(GREATEST(original_quantity - consumed, 0))::numeric                           AS qty_layers,
           SUM(GREATEST(original_quantity - consumed, 0) * unit_cost)::numeric               AS value_layers
    FROM   fifo_alive
    GROUP  BY biz_date
  ),
  -- Per-day rollup combining everything.
  per_day AS (
    SELECT cq.biz_date,
           cq.qty                                AS closing_qty,
           COALESCE(fc.value_layers, 0)::numeric AS closing_value,
           CASE WHEN COALESCE(fc.value_layers, 0) > 0 AND COALESCE(fc.qty_layers, 0) > 0
                THEN COALESCE(fc.value_layers, 0) / COALESCE(fc.qty_layers, 0)
                ELSE 0 END::numeric                AS avg_cost,
           dt.gross_in,
           dt.gross_out,
           dt.net_delta
    FROM   closing_qty cq
    LEFT   JOIN fifo_closing fc ON fc.biz_date = cq.biz_date
    LEFT   JOIN day_totals  dt ON dt.biz_date = cq.biz_date
  ),
  -- Sequenced for delta-vs-previous calculation.
  with_deltas AS (
    SELECT pd.*,
           LAG(closing_qty)   OVER (ORDER BY biz_date) AS prev_qty,
           LAG(closing_value) OVER (ORDER BY biz_date) AS prev_value
    FROM   per_day pd
  ),
  -- Aggregate movements_by_type into a JSONB array per day.
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
           (wd.closing_qty   - COALESCE(wd.prev_qty,   0))::numeric AS delta_qty,
           (wd.closing_value - COALESCE(wd.prev_value, 0))::numeric AS delta_value
    FROM   with_deltas wd
    LEFT   JOIN by_type_arr bta ON bta.biz_date = wd.biz_date
    ORDER  BY wd.biz_date DESC  -- newest first for UX
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
  'Per-SKU daily activity timeline up to p_target_date (end-of-day in tz). Emits one entry per calendar day with movement activity. closing_qty is cumulative-sum-based; closing_value/avg_cost are FIFO-reconstructed (with orphan-layer support, mirroring 050). delta_qty/delta_value are diffs vs. previous emitted day.';

REVOKE ALL     ON FUNCTION public.get_sku_daily_timeline_as_of(text, date, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_sku_daily_timeline_as_of(text, date, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_sku_daily_timeline_as_of(text, date, integer, text) TO authenticated, service_role;

COMMIT;
