-- 054_inventory_query_aggregate_timeline_rpc.sql
-- Aggregate inventory timeline up to p_target_date in the requested
-- timezone. Emits one row per calendar day with ANY movement activity
-- across ALL active SKUs in the window.
--
-- Per day D:
--   * movements_by_type — array of {type, count, qty_abs} aggregating
--     that day's movements grouped by movement_type (qty_abs is the sum
--     of |quantity| — gross magnitude, since aggregating signed values
--     across heterogeneous units is meaningless).
--   * sku_count — distinct SKUs with movement activity that day.
--   * movement_count — total movement rows that day.
--   * closing_value_usd — SUM(qty_remaining * unit_cost) across ALL FIFO
--     layers (every SKU) at end-of-day(D). The dollar figure is the only
--     unit-safe aggregate; quantity sums across SKUs with different units
--     would be misleading.
--   * delta_value — closing_value_usd minus the previous emitted day's
--     value (0 for the first emitted day).
--   * active_layer_count — distinct layers with qty_remaining_as_of > 0
--     at end-of-day(D).
--
-- Same safety profile as 049/050/051/053: STABLE, SECURITY DEFINER, no
-- writes, no DDL on existing objects. Orphan-layer handling consistent
-- with the rest of the inventory query stack.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_inventory_timeline_as_of(
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
    SELECT p_tz       AS tz,
           p_target_date AS target_date,
           v_lower_date  AS lower_date
  ),
  -- Active movements in the window across ALL SKUs.
  window_movements AS (
    SELECT m.id,
           m.type,
           m.quantity,
           (m.datetime AT TIME ZONE (SELECT tz FROM params))::date AS biz_date,
           m.sku_id
    FROM   movements m, params
    WHERE  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  (m.datetime AT TIME ZONE (SELECT tz FROM params))::date <= (SELECT target_date FROM params)
      AND  ((SELECT lower_date FROM params) IS NULL
            OR (m.datetime AT TIME ZONE (SELECT tz FROM params))::date > (SELECT lower_date FROM params))
  ),
  activity_days AS (
    SELECT DISTINCT biz_date FROM window_movements
  ),
  by_type AS (
    SELECT biz_date,
           type::text AS type,
           COUNT(*)::integer AS cnt,
           SUM(ABS(quantity))::numeric AS qty_abs
    FROM   window_movements
    GROUP  BY biz_date, type
  ),
  day_overview AS (
    SELECT biz_date,
           COUNT(*)::integer                  AS movement_count,
           COUNT(DISTINCT sku_id)::integer    AS sku_count
    FROM   window_movements
    GROUP  BY biz_date
  ),
  -- FIFO state across ALL layers, for every activity day. We materialize
  -- (biz_date × layer) once and compute consumed via a correlated subquery
  -- against layer_consumptions — Postgres will reuse the partial index
  -- idx_layer_consumptions_active here.
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
    WHERE  (l.created_by_movement_id IS NULL
            OR (m_create.deleted_at IS NULL AND m_create.reversed_at IS NULL))
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
           SUM(GREATEST(original_quantity - consumed, 0) * unit_cost)::numeric AS closing_value_usd,
           COUNT(*) FILTER (WHERE GREATEST(original_quantity - consumed, 0) > 0)::integer AS active_layer_count
    FROM   fifo_alive
    GROUP  BY biz_date
  ),
  per_day AS (
    SELECT ad.biz_date,
           COALESCE(fc.closing_value_usd, 0)::numeric  AS closing_value_usd,
           COALESCE(fc.active_layer_count, 0)::integer AS active_layer_count,
           COALESCE(dov.movement_count, 0)::integer    AS movement_count,
           COALESCE(dov.sku_count, 0)::integer         AS sku_count
    FROM   activity_days ad
    LEFT   JOIN fifo_closing fc  ON fc.biz_date  = ad.biz_date
    LEFT   JOIN day_overview dov ON dov.biz_date = ad.biz_date
  ),
  with_deltas AS (
    SELECT pd.*,
           LAG(closing_value_usd) OVER (ORDER BY biz_date) AS prev_value
    FROM   per_day pd
  ),
  by_type_arr AS (
    SELECT biz_date,
           jsonb_agg(jsonb_build_object(
             'type',    type,
             'count',   cnt,
             'qty_abs', qty_abs
           ) ORDER BY type) AS movements_by_type
    FROM   by_type
    GROUP  BY biz_date
  ),
  rows AS (
    SELECT wd.biz_date,
           COALESCE(bta.movements_by_type, '[]'::jsonb) AS movements_by_type,
           wd.movement_count,
           wd.sku_count,
           wd.closing_value_usd,
           wd.active_layer_count,
           (wd.closing_value_usd - COALESCE(wd.prev_value, wd.closing_value_usd))::numeric AS delta_value
    FROM   with_deltas wd
    LEFT   JOIN by_type_arr bta ON bta.biz_date = wd.biz_date
    ORDER  BY wd.biz_date DESC
  )
  SELECT jsonb_build_object(
    'target_date', p_target_date,
    'tz',          p_tz,
    'lower_date',  v_lower_date,
    'days',        COALESCE(jsonb_agg(jsonb_build_object(
                     'date',                biz_date,
                     'movements_by_type',   movements_by_type,
                     'movement_count',      movement_count,
                     'sku_count',           sku_count,
                     'closing_value_usd',   closing_value_usd,
                     'active_layer_count',  active_layer_count,
                     'delta_value',         delta_value
                   )), '[]'::jsonb)
  )
  INTO v_result
  FROM rows;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_inventory_timeline_as_of(date, integer, text) IS
  'Aggregate daily inventory timeline across ALL active SKUs up to p_target_date (end-of-day in tz). One entry per day with movement activity. closing_value_usd is the dollar value of all FIFO layers alive at end-of-day. Quantity is intentionally not aggregated across heterogeneous units. Orphan-layer handling consistent with migrations 050/053.';

REVOKE ALL     ON FUNCTION public.get_inventory_timeline_as_of(date, integer, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_inventory_timeline_as_of(date, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inventory_timeline_as_of(date, integer, text) TO authenticated, service_role;

COMMIT;
