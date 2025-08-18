-- 010_fifo_layer_based_validation.sql
-- Refactor validation to rely on fifo_layers instead of skus.on_hand
-- Add helper functions to compute/sync on_hand from layers

BEGIN;

-- =====================================================
-- 1. HELPER FUNCTIONS FOR LAYER-BASED AVAILABILITY
-- =====================================================

-- Return available quantity for a SKU based on fifo_layers remaining sum
CREATE OR REPLACE FUNCTION public.get_available_from_layers(p_sku_id text)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(fl.remaining_quantity), 0)
  FROM public.fifo_layers fl
  WHERE fl.sku_id = p_sku_id AND fl.status = 'ACTIVE' AND fl.remaining_quantity > 0;
$$;

-- Sync a single SKU's on_hand from layers (informational, not authoritative)
CREATE OR REPLACE FUNCTION public.sync_sku_on_hand_from_layers(p_sku_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_layers_remaining numeric;
BEGIN
  SELECT public.get_available_from_layers(p_sku_id) INTO v_layers_remaining;
  UPDATE public.skus
  SET on_hand = v_layers_remaining,
      updated_at = NOW()
  WHERE id = p_sku_id;
END;
$$;

-- Sync all SKUs on_hand from layers (utility)
CREATE OR REPLACE FUNCTION public.sync_all_skus_on_hand()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.skus LOOP
    PERFORM public.sync_sku_on_hand_from_layers(r.id);
  END LOOP;
END;
$$;

-- =====================================================
-- 2. UPDATE CONSUMPTION TO VALIDATE AGAINST LAYERS AND SYNC
-- =====================================================

CREATE OR REPLACE FUNCTION public.execute_fifo_consumption_validated(
  p_sku_id text,
  p_quantity_needed numeric,
  p_movement_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_layer record;
  v_remaining_needed numeric := p_quantity_needed;
  v_total_cost numeric := 0;
  v_consumptions jsonb[] := '{}';
  v_available_layers numeric;
BEGIN
  IF p_quantity_needed <= 0 THEN
    RAISE EXCEPTION 'Quantity needed must be positive: %', p_quantity_needed USING ERRCODE = '23514';
  END IF;

  -- Pre-validation: check available stock based on layers
  SELECT public.get_available_from_layers(p_sku_id) INTO v_available_layers;

  IF v_available_layers < p_quantity_needed THEN
    RAISE EXCEPTION 'Insufficient stock (layers) for SKU %. Available: %, Needed: %',
      p_sku_id, v_available_layers, p_quantity_needed USING ERRCODE = '23514';
  END IF;

  -- Process layers in FIFO order
  FOR v_layer IN
    SELECT id, remaining_quantity, unit_cost
    FROM public.fifo_layers
    WHERE sku_id = p_sku_id
      AND status = 'ACTIVE'
      AND remaining_quantity > 0
    ORDER BY receiving_date, created_at
  LOOP
    DECLARE
      v_consume_qty numeric;
      v_consume_cost numeric;
    BEGIN
      v_consume_qty := LEAST(v_remaining_needed, v_layer.remaining_quantity);
      v_consume_cost := v_consume_qty * v_layer.unit_cost;

      INSERT INTO public.layer_consumptions (
        movement_id, layer_id, quantity_consumed, unit_cost, total_cost
      ) VALUES (
        p_movement_id, v_layer.id, v_consume_qty, v_layer.unit_cost, v_consume_cost
      );

      PERFORM public.update_layer_quantity(v_layer.id, -v_consume_qty);

      v_total_cost := v_total_cost + v_consume_cost;
      v_consumptions := v_consumptions || jsonb_build_object(
        'layer_id', v_layer.id,
        'quantity', v_consume_qty,
        'cost', v_consume_cost
      );

      v_remaining_needed := v_remaining_needed - v_consume_qty;
      IF v_remaining_needed <= 0 THEN
        EXIT;
      END IF;
    END;
  END LOOP;

  IF v_remaining_needed > 0 THEN
    RAISE EXCEPTION 'Could not consume full quantity. Remaining: %', v_remaining_needed USING ERRCODE = '23514';
  END IF;

  -- Sync SKU on_hand from layers to avoid drift (informational)
  PERFORM public.sync_sku_on_hand_from_layers(p_sku_id);

  RETURN jsonb_build_object(
    'success', true,
    'total_consumed', p_quantity_needed,
    'total_cost', v_total_cost,
    'consumptions', v_consumptions
  );
END;
$$;

-- =====================================================
-- 3. UPDATE RECEIVING TO SYNC VIA LAYERS (REMOVE MANUAL on_hand UPDATE)
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_receiving_transaction(
  p_sku_id text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_receiving_date date DEFAULT CURRENT_DATE,
  p_vendor_id text DEFAULT NULL,
  p_packing_slip_no text DEFAULT NULL,
  p_reference text DEFAULT 'RECEIVE',
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement_id integer;
  v_layer_id text;
  v_total_value numeric;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive: %', p_quantity USING ERRCODE = '23514';
  END IF;
  IF p_unit_cost <= 0 THEN
    RAISE EXCEPTION 'Unit cost must be positive: %', p_unit_cost USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.skus WHERE id = p_sku_id) THEN
    RAISE EXCEPTION 'SKU not found: %', p_sku_id USING ERRCODE = 'P0002';
  END IF;

  v_total_value := p_quantity * p_unit_cost;

  INSERT INTO public.movements (
    datetime, type, sku_id, quantity, unit_cost, total_value, reference, notes
  ) VALUES (
    NOW(), 'RECEIVE', p_sku_id, p_quantity, p_unit_cost, v_total_value, p_reference, p_notes
  ) RETURNING id INTO v_movement_id;

  v_layer_id := p_sku_id || '-L' || EXTRACT(EPOCH FROM NOW())::bigint;

  INSERT INTO public.fifo_layers (
    id, sku_id, receiving_date, original_quantity, remaining_quantity,
    unit_cost, vendor_id, packing_slip_no, status, created_by_movement_id
  ) VALUES (
    v_layer_id, p_sku_id, p_receiving_date, p_quantity, p_quantity,
    p_unit_cost, p_vendor_id, p_packing_slip_no, 'ACTIVE', v_movement_id
  );

  -- Sync instead of manual arithmetic update
  PERFORM public.sync_sku_on_hand_from_layers(p_sku_id);

  RETURN jsonb_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'layer_id', v_layer_id,
    'quantity', p_quantity,
    'total_value', v_total_value
  );
END;
$$;

-- =====================================================
-- 4. VALIDATION REPORT BASED ON LAYERS (on_hand informational)
-- =====================================================

-- Drop old signature to allow return type change
DROP FUNCTION IF EXISTS public.validate_fifo_consistency();

CREATE OR REPLACE FUNCTION public.validate_fifo_consistency()
RETURNS TABLE(
  sku_id text,
  layers_remaining numeric,
  fifo_invariant numeric,
  movements_vs_layers numeric,
  on_hand_delta numeric,
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
      SUM(CASE WHEN m.type IN ('ISSUE','WASTE','TRANSFER','ADJUSTMENT') THEN ABS(m.quantity) ELSE 0 END) AS qty_out
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
    s.id AS sku_id,
    COALESCE(l.layers_remaining,0) AS layers_remaining,
    (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) AS fifo_invariant,
    ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - COALESCE(l.layers_remaining,0)) AS movements_vs_layers,
    (COALESCE(l.layers_remaining,0) - s.on_hand) AS on_hand_delta,
    CASE
      WHEN (COALESCE(l.layers_original,0) - (COALESCE(l.layers_remaining,0) + COALESCE(c.consumed_total,0))) = 0
       AND ((COALESCE(m.qty_in,0) - COALESCE(m.qty_out,0)) - COALESCE(l.layers_remaining,0)) = 0
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

-- =====================================================
-- 5. GRANTS
-- =====================================================

GRANT EXECUTE ON FUNCTION public.get_available_from_layers(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sku_on_hand_from_layers(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_all_skus_on_hand() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_fifo_consumption_validated(text, numeric, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_receiving_transaction(text, numeric, numeric, date, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fifo_consistency() TO anon, authenticated;

COMMIT;
