-- 057_inventory_query_detail_value_date.sql
-- Reanchor get_sku_detail_as_of (drill-down) from recording time to VALUE
-- date, consistent with migration 056 (snapshot).
--
-- Two changes vs. migration 051:
--   1. Layer existence gate: l.receiving_date <= p_target_date (was
--      COALESCE(m_create.datetime, l.created_at) < end-of-day). Same reanchor
--      as the snapshot — works for both RECEIVE-linked and orphan layers.
--   2. "Movements on the target date" (day_movements) buckets each movement
--      by its VALUE date: for RECEIVE, the linked layer's receiving_date;
--      for all other types, (datetime AT TIME ZONE tz)::date — which is
--      already the value date (Work Orders write the user's chosen date).
--      This keeps the day's movement list consistent with where the snapshot
--      now shows the stock appearing.
--
-- UNCHANGED: consumption gating (mc.datetime < end-of-day), FIFO display
-- ordering (receiving_date, then origin_ts tiebreaker), has_adjustments
-- logic, signature, return shape, security attributes, and grants.
--
-- Safety: read-only, idempotent, no writes. Reverts by re-applying 051.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_sku_detail_as_of(
  p_sku_id      text,
  p_target_date date,
  p_tz          text default 'America/Toronto'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts_end         timestamptz;
  v_layers         jsonb;
  v_movements      jsonb;
  v_on_hand        numeric := 0;
  v_total_value    numeric := 0;
  v_average_cost   numeric := 0;
  v_layer_count    integer := 0;
  v_has_adjust     boolean := false;
BEGIN
  v_ts_end := ((p_target_date + 1)::timestamp AT TIME ZONE p_tz);

  -- Reconstructed FIFO layers existing as of the VALUE date, in FIFO order.
  WITH active_layers AS (
    SELECT l.id           AS layer_id,
           l.receiving_date,
           l.vendor_id,
           l.packing_slip_no,
           l.lot_number,
           l.unit_cost,
           l.original_quantity,
           COALESCE(m_create.datetime, l.created_at) AS layer_origin_ts
    FROM   fifo_layers l
    LEFT   JOIN movements m_create ON m_create.id = l.created_by_movement_id
    WHERE  l.sku_id = p_sku_id
      AND  l.receiving_date <= p_target_date
      AND  (
            l.created_by_movement_id IS NULL
            OR (m_create.deleted_at IS NULL AND m_create.reversed_at IS NULL)
           )
  ),
  consumed AS (
    SELECT lc.layer_id,
           SUM(lc.quantity_consumed) AS consumed
    FROM   layer_consumptions lc
    JOIN   movements mc ON mc.id = lc.movement_id
    WHERE  lc.deleted_at IS NULL
      AND  mc.deleted_at IS NULL
      AND  mc.reversed_at IS NULL
      AND  mc.datetime    < v_ts_end
      AND  mc.sku_id      = p_sku_id
    GROUP BY lc.layer_id
  ),
  state AS (
    SELECT al.*,
           GREATEST(al.original_quantity - COALESCE(c.consumed, 0), 0)::numeric AS qty_remaining
    FROM   active_layers al
    LEFT   JOIN consumed c ON c.layer_id = al.layer_id
  ),
  alive AS (
    SELECT s.layer_id,
           s.receiving_date,
           s.vendor_id,
           v.name AS vendor_name,
           s.packing_slip_no,
           s.lot_number,
           s.unit_cost,
           s.original_quantity,
           s.qty_remaining,
           s.layer_origin_ts
    FROM   state s
    LEFT   JOIN vendors v ON v.id = s.vendor_id
    WHERE  s.qty_remaining > 0
  ),
  ordered AS (
    SELECT *
    FROM   alive
    ORDER  BY receiving_date ASC, layer_origin_ts ASC
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'layer_id',            layer_id,
          'receiving_date',      receiving_date,
          'vendor_id',           vendor_id,
          'vendor_name',         vendor_name,
          'packing_slip_no',     packing_slip_no,
          'lot_number',          lot_number,
          'unit_cost',           unit_cost,
          'original_quantity',   original_quantity,
          'qty_remaining_as_of', qty_remaining,
          'value_as_of',         (qty_remaining * unit_cost)
        )
      ),
      '[]'::jsonb
    ),
    COALESCE(SUM(qty_remaining),                 0),
    COALESCE(SUM(qty_remaining * unit_cost),     0),
    COUNT(*)::integer
  INTO  v_layers, v_on_hand, v_total_value, v_layer_count
  FROM  ordered;

  IF v_on_hand > 0 THEN
    v_average_cost := v_total_value / v_on_hand;
  END IF;

  -- Movements whose VALUE date is the target date for this SKU (active only).
  -- For RECEIVE: bucket by the linked layer's receiving_date.
  -- For other types: bucket by (datetime AT TIME ZONE tz)::date.
  WITH day_mvs AS (
    SELECT m.id, m.datetime, m.type, m.quantity, m.unit_cost,
           m.total_value, m.reference, m.work_order_id, m.notes
    FROM   movements m
    LEFT   JOIN fifo_layers rl
           ON rl.created_by_movement_id = m.id AND m.type = 'RECEIVE'
    WHERE  m.sku_id      = p_sku_id
      AND  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  CASE
             WHEN m.type = 'RECEIVE' THEN rl.receiving_date
             ELSE (m.datetime AT TIME ZONE p_tz)::date
           END = p_target_date
    ORDER BY m.datetime ASC, m.id ASC
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'movement_id',   id,
          'datetime',      datetime,
          'type',          type::text,
          'quantity',      quantity,
          'unit_cost',     unit_cost,
          'total_value',   total_value,
          'reference',     reference,
          'work_order_id', work_order_id,
          'notes',         notes
        )
      ),
      '[]'::jsonb
    ),
    COALESCE(bool_or(type = 'ADJUSTMENT'), false)
  INTO  v_movements, v_has_adjust
  FROM  day_mvs;

  -- has_adjustments: any live ADJUSTMENT in this SKU's history up to the
  -- cutoff (divergence signal). Kept on datetime — ADJUSTMENT has no layer.
  v_has_adjust := v_has_adjust OR EXISTS (
    SELECT 1 FROM movements m
    WHERE m.sku_id      = p_sku_id
      AND m.type        = 'ADJUSTMENT'
      AND m.deleted_at  IS NULL
      AND m.reversed_at IS NULL
      AND m.datetime    < v_ts_end
  );

  RETURN jsonb_build_object(
    'sku_id',        p_sku_id,
    'target_date',   p_target_date,
    'tz',            p_tz,
    'layers',        v_layers,
    'day_movements', v_movements,
    'totals', jsonb_build_object(
      'on_hand',          v_on_hand,
      'average_cost',     v_average_cost,
      'total_value',      v_total_value,
      'layer_count',      v_layer_count,
      'has_adjustments',  v_has_adjust
    )
  );
END;
$$;

COMMENT ON FUNCTION public.get_sku_detail_as_of(text, date, text) IS
  'Drill-down for one SKU at end-of-day in the given timezone. FIFO layers are positioned by VALUE date (receiving_date <= target_date), mirroring the snapshot (migration 056). day_movements buckets RECEIVE by the linked layer''s receiving_date and other types by datetime (already the value date). Consumption gated by datetime. has_adjustments flags ADJUSTMENT-driven divergence. Reverts to migration 051 if re-applied.';

REVOKE ALL     ON FUNCTION public.get_sku_detail_as_of(text, date, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_sku_detail_as_of(text, date, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_sku_detail_as_of(text, date, text) TO authenticated, service_role;

COMMIT;
