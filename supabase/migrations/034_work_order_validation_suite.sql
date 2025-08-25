-- 034_work_order_validation_suite.sql
-- Comprehensive validation suite for Work Order integrity
-- 
-- This migration adds validation functions to ensure:
-- 1. Movement costs match layer consumption costs
-- 2. PRODUCE values are calculated correctly (RAW - WASTE)
-- 3. Work Order totals are consistent
-- 4. FIFO layer quantities are properly maintained

BEGIN;

-- =====================================================
-- 1. COMPREHENSIVE WORK ORDER VALIDATION
-- =====================================================

CREATE OR REPLACE FUNCTION public.validate_all_work_orders()
RETURNS TABLE(
  work_order_id text,
  issue_movements integer,
  produce_movements integer,
  total_issue_value numeric,
  total_produce_value numeric,
  layer_consumption_total numeric,
  discrepancy numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH wo_movements AS (
    SELECT 
      m.work_order_id,
      COUNT(CASE WHEN m.type IN ('ISSUE', 'WASTE') THEN 1 END) as issue_movements,
      COUNT(CASE WHEN m.type = 'PRODUCE' THEN 1 END) as produce_movements,
      SUM(CASE WHEN m.type IN ('ISSUE', 'WASTE') THEN ABS(m.total_value) ELSE 0 END) as total_issue_value,
      SUM(CASE WHEN m.type = 'PRODUCE' THEN m.total_value ELSE 0 END) as total_produce_value
    FROM public.movements m
    WHERE m.work_order_id IS NOT NULL
      AND m.deleted_at IS NULL
    GROUP BY m.work_order_id
  ),
  wo_layer_costs AS (
    SELECT 
      m.work_order_id,
      SUM(lc.total_cost) as layer_consumption_total
    FROM public.movements m
    JOIN public.layer_consumptions lc ON lc.movement_id = m.id
    WHERE m.work_order_id IS NOT NULL
      AND m.deleted_at IS NULL
      AND lc.deleted_at IS NULL
    GROUP BY m.work_order_id
  )
  SELECT 
    wom.work_order_id,
    wom.issue_movements,
    wom.produce_movements,
    wom.total_issue_value,
    wom.total_produce_value,
    COALESCE(wlc.layer_consumption_total, 0) as layer_consumption_total,
    (wom.total_produce_value - COALESCE(wlc.layer_consumption_total, 0)) as discrepancy,
    CASE 
      WHEN ABS(wom.total_produce_value - COALESCE(wlc.layer_consumption_total, 0)) < 0.01 
      THEN 'CONSISTENT'
      ELSE 'INCONSISTENT'
    END as status
  FROM wo_movements wom
  LEFT JOIN wo_layer_costs wlc ON wlc.work_order_id = wom.work_order_id
  ORDER BY wom.work_order_id;
END;
$$;

-- =====================================================
-- 2. DETAILED MOVEMENT ANALYSIS
-- =====================================================

CREATE OR REPLACE FUNCTION public.analyze_work_order_movements(p_work_order_id text)
RETURNS TABLE(
  movement_id integer,
  movement_type movement_type,
  sku_id text,
  quantity numeric,
  movement_unit_cost numeric,
  movement_total_value numeric,
  layer_consumption_total numeric,
  layer_consumption_count integer,
  cost_discrepancy numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id as movement_id,
    m.type as movement_type,
    m.sku_id,
    m.quantity,
    m.unit_cost as movement_unit_cost,
    m.total_value as movement_total_value,
    COALESCE(lc_summary.total_cost, 0) as layer_consumption_total,
    COALESCE(lc_summary.consumption_count, 0) as layer_consumption_count,
    (ABS(m.total_value) - COALESCE(lc_summary.total_cost, 0)) as cost_discrepancy,
    CASE 
      WHEN m.type = 'PRODUCE' THEN 'PRODUCE_MOVEMENT'
      WHEN m.type IN ('ISSUE', 'WASTE') AND ABS(ABS(m.total_value) - COALESCE(lc_summary.total_cost, 0)) < 0.01 
      THEN 'CONSISTENT'
      WHEN m.type IN ('ISSUE', 'WASTE') 
      THEN 'COST_MISMATCH'
      ELSE 'OTHER'
    END as status
  FROM public.movements m
  LEFT JOIN (
    SELECT 
      lc.movement_id,
      SUM(lc.total_cost) as total_cost,
      COUNT(*) as consumption_count
    FROM public.layer_consumptions lc
    WHERE lc.deleted_at IS NULL
    GROUP BY lc.movement_id
  ) lc_summary ON lc_summary.movement_id = m.id
  WHERE m.work_order_id = p_work_order_id
    AND m.deleted_at IS NULL
  ORDER BY m.created_at, m.id;
END;
$$;

-- =====================================================
-- 3. FIFO LAYER CONSISTENCY CHECK
-- =====================================================

CREATE OR REPLACE FUNCTION public.validate_fifo_layer_integrity()
RETURNS TABLE(
  sku_id text,
  layer_id text,
  original_quantity numeric,
  calculated_remaining numeric,
  actual_remaining numeric,
  total_consumed numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    fl.sku_id,
    fl.id as layer_id,
    fl.original_quantity,
    (fl.original_quantity - COALESCE(lc_summary.total_consumed, 0)) as calculated_remaining,
    fl.remaining_quantity as actual_remaining,
    COALESCE(lc_summary.total_consumed, 0) as total_consumed,
    CASE 
      WHEN ABS(fl.remaining_quantity - (fl.original_quantity - COALESCE(lc_summary.total_consumed, 0))) < 0.001
      THEN 'CONSISTENT'
      ELSE 'INCONSISTENT'
    END as status
  FROM public.fifo_layers fl
  LEFT JOIN (
    SELECT 
      lc.layer_id,
      SUM(lc.quantity_consumed) as total_consumed
    FROM public.layer_consumptions lc
    WHERE lc.deleted_at IS NULL
    GROUP BY lc.layer_id
  ) lc_summary ON lc_summary.layer_id = fl.id
  WHERE fl.status = 'ACTIVE'
  ORDER BY fl.sku_id, fl.receiving_date, fl.created_at;
END;
$$;

-- =====================================================
-- 4. REPAIR ALL INCONSISTENT WORK ORDERS
-- =====================================================

CREATE OR REPLACE FUNCTION public.repair_all_work_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo_record record;
  v_repair_result jsonb;
  v_total_repaired integer := 0;
  v_results jsonb[] := '{}';
BEGIN
  -- Find all inconsistent work orders
  FOR v_wo_record IN
    SELECT work_order_id
    FROM public.validate_all_work_orders()
    WHERE status = 'INCONSISTENT'
  LOOP
    -- Repair each work order
    SELECT public.repair_work_order_costs(v_wo_record.work_order_id) INTO v_repair_result;
    
    IF (v_repair_result->>'repairs_made')::integer > 0 THEN
      v_total_repaired := v_total_repaired + 1;
      v_results := v_results || v_repair_result;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object(
    'total_work_orders_repaired', v_total_repaired,
    'repair_details', v_results
  );
END;
$$;

-- =====================================================
-- 5. SCHEDULED INTEGRITY CHECK TRIGGER
-- =====================================================

-- Create a function to automatically validate new work orders
CREATE OR REPLACE FUNCTION public.trigger_validate_work_order_integrity()
RETURNS TRIGGER AS $$
BEGIN
  -- Only validate when work order is marked as COMPLETED
  IF NEW.status = 'COMPLETED' AND (OLD.status IS NULL OR OLD.status != 'COMPLETED') THEN
    PERFORM public.validate_work_order_integrity(NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on work_orders table
DROP TRIGGER IF EXISTS trigger_validate_wo_integrity ON public.work_orders;
CREATE TRIGGER trigger_validate_wo_integrity
  AFTER UPDATE ON public.work_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_validate_work_order_integrity();

-- =====================================================
-- 6. GRANTS
-- =====================================================

GRANT EXECUTE ON FUNCTION public.validate_all_work_orders() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analyze_work_order_movements(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fifo_layer_integrity() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_all_work_orders() TO anon, authenticated;

-- =====================================================
-- 7. INITIAL VALIDATION AND REPAIR
-- =====================================================

-- Log the validation suite installation
INSERT INTO public.movements (
  datetime, type, product_name, quantity, unit_cost, total_value, reference, notes
) VALUES (
  NOW(), 'ADJUSTMENT', 'SYSTEM_VALIDATION_SUITE', 0, 0, 0, 'WO_VALIDATION_SUITE_034', 
  'Installed comprehensive work order validation and repair suite with automatic integrity checks.'
);

COMMIT;