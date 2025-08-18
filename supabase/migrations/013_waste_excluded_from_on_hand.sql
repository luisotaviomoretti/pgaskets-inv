-- 013_waste_excluded_from_on_hand.sql
-- Purpose: Ensure WASTE does not reduce on_hand nor FIFO layers.
-- Changes:
-- - Update create_work_order_transaction: skip FIFO consumption for WASTE
-- - Update validate_fifo_consistency(): exclude WASTE from qty_out

BEGIN;

-- 1) Update transactional WO RPC: only ISSUE consumes FIFO; WASTE is logged only
CREATE OR REPLACE FUNCTION public.create_work_order_transaction(
  p_output_name text,
  p_output_quantity numeric,
  p_output_unit text DEFAULT 'unit',
  p_mode work_order_mode DEFAULT 'AUTO',
  p_client_name text DEFAULT NULL,
  p_invoice_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_materials jsonb DEFAULT '[]'::jsonb -- [{"sku_id":"SKU-001","quantity":10,"type":"ISSUE"|"WASTE"}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id text;
  v_produce_movement_id integer;
  v_consume_movement_id integer;
  v_material record;
  v_total_cost numeric := 0;
  v_consumption_result jsonb;
  v_results jsonb[] := '{}';
  v_movement_type movement_type;
  v_avg_cost numeric := 0;
  v_issue_qty_sum numeric := 0; -- total ISSUE quantity (sum of raw materials)
  v_waste_qty_sum numeric := 0; -- total WASTE quantity
  v_issue_unit_cost numeric := null; -- derived from ISSUE only
  r record; -- for pre-validation FOR r IN ... LOOP
BEGIN
  IF p_output_quantity <= 0 THEN
    RAISE EXCEPTION 'Output quantity must be positive: %', p_output_quantity USING ERRCODE = '23514';
  END IF;

  v_work_order_id := 'WO-' || EXTRACT(EPOCH FROM NOW())::bigint;

  INSERT INTO public.work_orders (
    id, output_name, output_quantity, output_unit, mode,
    client_name, invoice_no, notes, status, created_at
  ) VALUES (
    v_work_order_id, p_output_name, p_output_quantity, p_output_unit, p_mode,
    p_client_name, p_invoice_no, p_notes, 'COMPLETED', NOW()
  );

  -- Pre-validate stock per SKU (ISSUE only) before any inserts
  FOR r IN
    SELECT sku_id, SUM(quantity) AS qty_needed
    FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
    WHERE COALESCE(NULLIF(TRIM(UPPER(type)), ''), 'ISSUE') = 'ISSUE'
    GROUP BY sku_id
  LOOP
    IF public.get_available_from_layers(r.sku_id) < r.qty_needed THEN
      RAISE EXCEPTION 'Insufficient stock (layers) for SKU %. Available: %, Needed: %',
        r.sku_id,
        public.get_available_from_layers(r.sku_id),
        r.qty_needed
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Process each material consumption
  FOR v_material IN
    SELECT * FROM jsonb_to_recordset(p_materials) AS x(sku_id text, quantity numeric, type text)
  LOOP
    v_movement_type := COALESCE(NULLIF(TRIM(UPPER(v_material.type)), ''), 'ISSUE')::movement_type;

    INSERT INTO public.movements (
      datetime, type, sku_id, quantity, unit_cost, total_value,
      reference, work_order_id, notes
    ) VALUES (
      NOW(), v_movement_type, v_material.sku_id, -v_material.quantity, 0, 0,
      v_work_order_id, v_work_order_id,
      CASE WHEN v_movement_type = 'WASTE' THEN 'Waste (non-deducting)' ELSE 'Material consumption' END
    ) RETURNING id INTO v_consume_movement_id;

    IF v_movement_type = 'ISSUE' THEN
      -- Only ISSUE reduces FIFO layers and contributes cost
      SELECT public.execute_fifo_consumption_validated(
        v_material.sku_id, v_material.quantity, v_consume_movement_id
      ) INTO v_consumption_result;

      UPDATE public.movements
      SET total_value = -(v_consumption_result->>'total_cost')::numeric
      WHERE id = v_consume_movement_id;

      v_total_cost := v_total_cost + (v_consumption_result->>'total_cost')::numeric;
      v_issue_qty_sum := v_issue_qty_sum + v_material.quantity;

      v_results := v_results || jsonb_build_object(
        'sku_id', v_material.sku_id,
        'quantity', v_material.quantity,
        'type', v_movement_type,
        'movement_id', v_consume_movement_id,
        'consumption', v_consumption_result
      );
    ELSE
      -- WASTE does not consume FIFO nor affect on_hand; however, assign value = qty * current avg cost
      -- Preferred unit cost comes from ISSUE average (issue_cost / issue_qty). If not available (edge), fallback to layers avg.
      IF v_issue_unit_cost IS NULL THEN
        IF COALESCE(v_issue_qty_sum,0) > 0 THEN
          v_issue_unit_cost := v_total_cost / v_issue_qty_sum;
        ELSE
          SELECT 
            COALESCE(
              SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity * fl.unit_cost END)
                / NULLIF(SUM(CASE WHEN fl.remaining_quantity > 0 THEN fl.remaining_quantity END), 0),
              0
            )
          INTO v_issue_unit_cost
          FROM public.fifo_layers fl
          WHERE fl.sku_id = v_material.sku_id;
        END IF;
      END IF;

      UPDATE public.movements m
      SET 
        unit_cost = v_issue_unit_cost,
        total_value = - (v_issue_unit_cost * v_material.quantity)
      WHERE m.id = v_consume_movement_id;

      v_results := v_results || jsonb_build_object(
        'sku_id', v_material.sku_id,
        'quantity', v_material.quantity,
        'type', v_movement_type,
        'movement_id', v_consume_movement_id,
        'avg_cost_applied', v_issue_unit_cost
      );
      v_waste_qty_sum := v_waste_qty_sum + v_material.quantity;
    END IF;
  END LOOP;

  INSERT INTO public.movements (
    datetime, type, product_name, quantity, unit_cost, total_value,
    reference, work_order_id, notes
  ) VALUES (
    NOW(), 'PRODUCE', p_output_name, p_output_quantity,
    -- PRODUCE is valued with the same unit cost used for ISSUE (so that ISSUE = PRODUCE + WASTE)
    CASE 
      WHEN v_issue_unit_cost IS NOT NULL THEN v_issue_unit_cost
      WHEN COALESCE(v_issue_qty_sum,0) > 0 THEN v_total_cost / v_issue_qty_sum
      ELSE 0
    END,
    -- total_value for PRODUCE excludes WASTE portion
    (CASE 
      WHEN v_issue_unit_cost IS NOT NULL THEN v_issue_unit_cost
      WHEN COALESCE(v_issue_qty_sum,0) > 0 THEN v_total_cost / v_issue_qty_sum
      ELSE 0
    END) * p_output_quantity,
    v_work_order_id, v_work_order_id, 'Production output'
  ) RETURNING id INTO v_produce_movement_id;

  UPDATE public.work_orders
  SET total_cost = v_total_cost, completed_at = NOW()
  WHERE id = v_work_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', v_work_order_id,
    'produce_movement_id', v_produce_movement_id,
    'total_cost', v_total_cost,
    'material_consumptions', v_results
  );
END;
$$;

-- 2) Update consistency check to exclude WASTE from outflows
-- Drop existing function first to allow return type/shape changes
DROP FUNCTION IF EXISTS public.validate_fifo_consistency();

CREATE OR REPLACE FUNCTION public.validate_fifo_consistency()
RETURNS TABLE(
  sku_id text,
  on_hand_vs_layers numeric,
  fifo_invariant numeric,
  movements_vs_onhand numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH mov AS (
    SELECT
      m.sku_id,
      SUM(CASE WHEN m.type = 'RECEIVE' THEN m.quantity ELSE 0 END) AS qty_in,
      SUM(CASE WHEN m.type IN ('ISSUE','TRANSFER','ADJUSTMENT') THEN ABS(m.quantity) ELSE 0 END) AS qty_out
    FROM public.movements m
    WHERE m.sku_id IS NOT NULL
    GROUP BY m.sku_id
  ),
  lay AS (
    SELECT
      fl.sku_id,
      SUM(fl.original_quantity) AS layers_original,
      SUM(fl.remaining_quantity) AS layers_remaining
    FROM public.fifo_layers fl
    GROUP BY fl.sku_id
  ),
  cons AS (
    SELECT
      fl.sku_id,
      SUM(lc.quantity_consumed) AS consumed_total
    FROM public.layer_consumptions lc
    JOIN public.fifo_layers fl ON fl.id = lc.layer_id
    GROUP BY fl.sku_id
  )
  SELECT
    s.id,
    (COALESCE(l.layers_remaining,0) - s.on_hand) AS on_hand_vs_layers,
    (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) AS fifo_invariant,
    ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - s.on_hand) AS movements_vs_onhand,
    CASE
      WHEN (COALESCE(l.layers_remaining,0) - s.on_hand) = 0
       AND (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) = 0
       AND ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - s.on_hand) = 0
      THEN 'CONSISTENT'
      ELSE 'INCONSISTENT'
    END AS status
  FROM public.skus s
  LEFT JOIN lay l ON l.sku_id = s.id
  LEFT JOIN cons c ON c.sku_id = s.id
  LEFT JOIN mov m ON m.sku_id = s.id
  ORDER BY s.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_work_order_transaction(text, numeric, text, work_order_mode, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fifo_consistency() TO anon, authenticated;

COMMIT;
