-- 061_inventory_query_movements_on_date_value_date.sql
-- Reanchor get_movements_on_date (day drill-down) from recording time to
-- VALUE date, consistent with 056-059.
--
-- Change vs. 055:
--   Each movement is assigned to a day by its VALUE date:
--     RECEIVE -> linked layer (created_by_movement_id) receiving_date
--     others  -> (datetime AT TIME ZONE tz)::date
--   and the function returns movements where that value date = p_target_date
--   (was: datetime within [start_of_day, start_of_day+1) in tz).
--
-- So clicking a day in the Daily Inventory Timeline shows a RECEIVE on its
-- value date (matching where the snapshot/timeline now place its stock),
-- not on the day it was data-entered. ISSUE/WASTE/PRODUCE are unaffected
-- (their datetime is already the value date, written by the Work Order RPC).
--
-- UNCHANGED: deleted_at/reversed_at filters, vendor resolution, grouping,
-- ordering, totals, signature/return/security/grants.
--
-- Safety: read-only, idempotent, no writes. Reverts by re-applying 055.

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
  v_result jsonb;
BEGIN
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
           s.unit,
           -- vendor/packing pulled from the RECEIVE's own layer
           rl.vendor_id,
           rl.packing_slip_no,
           v.name AS vendor_name
    FROM   movements m
    LEFT   JOIN skus s ON s.id = m.sku_id
    LEFT   JOIN fifo_layers rl ON rl.created_by_movement_id = m.id
    LEFT   JOIN vendors v ON v.id = rl.vendor_id
    WHERE  m.deleted_at  IS NULL
      AND  m.reversed_at IS NULL
      AND  CASE
             WHEN m.type = 'RECEIVE' THEN rl.receiving_date
             ELSE (m.datetime AT TIME ZONE p_tz)::date
           END = p_target_date
  ),
  per_sku_movements AS (
    SELECT dm.sku_id,
           dm.sku_description,
           dm.product_type,
           dm.unit,
           jsonb_agg(
             jsonb_build_object(
               'movement_id',     dm.id,
               'datetime',        dm.datetime,
               'type',            dm.type::text,
               'quantity',        dm.quantity,
               'unit_cost',       dm.unit_cost,
               'total_value',     dm.total_value,
               'reference',       dm.reference,
               'work_order_id',   dm.work_order_id,
               'notes',           dm.notes,
               'product_name',    dm.product_name,
               'vendor_id',       dm.vendor_id,
               'vendor_name',     dm.vendor_name,
               'packing_slip_no', dm.packing_slip_no
             )
             ORDER BY dm.datetime ASC, dm.id ASC
           ) AS movements,
           SUM(dm.quantity)::numeric    AS net_qty,
           SUM(dm.total_value)::numeric AS total_value,
           COUNT(*)::integer            AS movement_count
    FROM   day_movements dm
    GROUP  BY dm.sku_id, dm.sku_description, dm.product_type, dm.unit
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
  'All active movements whose VALUE date equals the given calendar day (RECEIVE by linked layer receiving_date; other types by datetime-in-tz), grouped by SKU, with vendor resolved via fifo_layers.created_by_movement_id. Excludes soft-deleted and reversed rows. Reverts to migration 055 if re-applied.';

REVOKE ALL     ON FUNCTION public.get_movements_on_date(date, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_movements_on_date(date, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_movements_on_date(date, text) TO authenticated, service_role;

COMMIT;
