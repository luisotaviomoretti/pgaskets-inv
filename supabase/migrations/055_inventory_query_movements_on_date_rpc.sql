-- 055_inventory_query_movements_on_date_rpc.sql
-- Day-level movements drill-down: returns every active movement that fell
-- on a given calendar day in the requested timezone, grouped by SKU.
--
-- Used by the Inventory Query UI when the user clicks a row in the
-- "Daily Inventory Timeline" to see exactly what changed that day.
--
-- Filters applied (same posture as the rest of the inventory-query stack):
--   * deleted_at IS NULL  (soft-delete cascade from migration 029)
--   * reversed_at IS NULL (reversal flag set on the original row)
--
-- Returns JSONB:
--   {
--     date, tz,
--     totals: { movement_count, sku_count, gross_in_count, gross_out_count },
--     groups: [
--       { sku_id, sku_description, product_type, unit,
--         net_qty, total_value,
--         movements: [
--           { movement_id, datetime, type, quantity, unit_cost,
--             total_value, reference, work_order_id, notes,
--             vendor_id, vendor_name }
--         ]
--       }, ...
--     ]
--   }
--
-- STABLE, SECURITY DEFINER, no writes, no DDL. Same grant pattern as
-- 049/050/051/053/054.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_movements_on_date(
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
  v_ts_start timestamptz;
  v_ts_end   timestamptz;
  v_result   jsonb;
BEGIN
  v_ts_start := (p_target_date::timestamp        AT TIME ZONE p_tz);
  v_ts_end   := ((p_target_date + 1)::timestamp  AT TIME ZONE p_tz);

  WITH day_movements AS (
    SELECT m.id,
           m.datetime,
           m.type,
           m.sku_id,
           m.product_name,
           m.quantity,
           m.unit_cost,
           m.total_value,
           m.reference,
           m.work_order_id,
           m.notes,
           s.description AS sku_description,
           s.type::text  AS product_type,
           s.unit
    FROM   movements m
    LEFT   JOIN skus s ON s.id = m.sku_id
    WHERE  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  m.datetime   >= v_ts_start
      AND  m.datetime    < v_ts_end
  ),
  -- Best-effort vendor lookup: a movement does not directly reference a
  -- vendor, but RECEIVE movements create a fifo_layer that does. So for
  -- RECEIVE-type movements we look up the layer via created_by_movement_id.
  movements_with_vendor AS (
    SELECT dm.*,
           l.vendor_id,
           l.packing_slip_no,
           v.name AS vendor_name
    FROM   day_movements dm
    LEFT   JOIN fifo_layers l ON l.created_by_movement_id = dm.id
    LEFT   JOIN vendors v ON v.id = l.vendor_id
  ),
  per_sku_movements AS (
    SELECT mv.sku_id,
           mv.sku_description,
           mv.product_type,
           mv.unit,
           jsonb_agg(
             jsonb_build_object(
               'movement_id',     mv.id,
               'datetime',        mv.datetime,
               'type',            mv.type::text,
               'quantity',        mv.quantity,
               'unit_cost',       mv.unit_cost,
               'total_value',     mv.total_value,
               'reference',       mv.reference,
               'work_order_id',   mv.work_order_id,
               'notes',           mv.notes,
               'product_name',    mv.product_name,
               'vendor_id',       mv.vendor_id,
               'vendor_name',     mv.vendor_name,
               'packing_slip_no', mv.packing_slip_no
             )
             ORDER BY mv.datetime ASC, mv.id ASC
           ) AS movements,
           SUM(mv.quantity)::numeric    AS net_qty,
           SUM(mv.total_value)::numeric AS total_value,
           COUNT(*)::integer            AS movement_count
    FROM   movements_with_vendor mv
    GROUP  BY mv.sku_id, mv.sku_description, mv.product_type, mv.unit
  ),
  groups_arr AS (
    SELECT jsonb_agg(
             jsonb_build_object(
               'sku_id',          COALESCE(sku_id, ''),
               'sku_description', COALESCE(sku_description, ''),
               'product_type',    COALESCE(product_type, ''),
               'unit',            COALESCE(unit, ''),
               'movement_count',  movement_count,
               'net_qty',         net_qty,
               'total_value',     total_value,
               'movements',       movements
             )
             ORDER BY ABS(total_value) DESC NULLS LAST, sku_id ASC
           ) AS groups
    FROM   per_sku_movements
  ),
  overall AS (
    SELECT COUNT(*)::integer                          AS movement_count,
           COUNT(DISTINCT sku_id)::integer            AS sku_count,
           SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END)::integer AS gross_in_count,
           SUM(CASE WHEN quantity < 0 THEN 1 ELSE 0 END)::integer AS gross_out_count,
           SUM(CASE WHEN quantity > 0 THEN total_value ELSE 0 END)::numeric AS gross_in_value,
           SUM(CASE WHEN quantity < 0 THEN total_value ELSE 0 END)::numeric AS gross_out_value
    FROM   day_movements
  )
  SELECT jsonb_build_object(
           'date',   p_target_date,
           'tz',     p_tz,
           'totals', jsonb_build_object(
             'movement_count',   COALESCE(o.movement_count, 0),
             'sku_count',        COALESCE(o.sku_count, 0),
             'gross_in_count',   COALESCE(o.gross_in_count, 0),
             'gross_out_count',  COALESCE(o.gross_out_count, 0),
             'gross_in_value',   COALESCE(o.gross_in_value, 0),
             'gross_out_value',  COALESCE(o.gross_out_value, 0)
           ),
           'groups', COALESCE(g.groups, '[]'::jsonb)
         )
  INTO   v_result
  FROM   overall o
  CROSS  JOIN groups_arr g;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_movements_on_date(date, text) IS
  'All active movements on a given calendar day (TZ-aware), grouped by SKU, with vendor info resolved via fifo_layers.created_by_movement_id for RECEIVE movements. Excludes soft-deleted and reversed rows.';

REVOKE ALL     ON FUNCTION public.get_movements_on_date(date, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_movements_on_date(date, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_movements_on_date(date, text) TO authenticated, service_role;

COMMIT;
