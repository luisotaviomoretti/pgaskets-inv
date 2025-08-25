-- test_integrity_fixes.sql
-- Test script to validate Work Order integrity fixes

BEGIN;

-- =====================================================
-- TEST 1: Validate WO-1756124257 before repair
-- =====================================================

SELECT 
  'Before repair - WO movements' as test_name,
  id, type, sku_id, quantity, unit_cost, total_value
FROM movements 
WHERE work_order_id = 'WO-1756124257'
ORDER BY created_at, type;

SELECT 
  'Before repair - Layer consumptions' as test_name,
  lc.movement_id, lc.layer_id, lc.quantity_consumed, lc.unit_cost, lc.total_cost
FROM layer_consumptions lc
JOIN movements m ON m.id = lc.movement_id
WHERE m.work_order_id = 'WO-1756124257'
ORDER BY lc.movement_id;

-- =====================================================
-- TEST 2: Calculate expected values
-- =====================================================

WITH expected_costs AS (
  SELECT 
    m.work_order_id,
    m.id as movement_id,
    m.type,
    m.sku_id,
    COALESCE(SUM(lc.total_cost), 0) as expected_cost
  FROM movements m
  LEFT JOIN layer_consumptions lc ON lc.movement_id = m.id
  WHERE m.work_order_id = 'WO-1756124257'
    AND m.type IN ('ISSUE', 'WASTE')
  GROUP BY m.work_order_id, m.id, m.type, m.sku_id
)
SELECT 
  'Expected values calculation' as test_name,
  movement_id,
  type,
  sku_id,
  expected_cost,
  'Should sum to PRODUCE total_value' as note
FROM expected_costs
UNION ALL
SELECT 
  'Expected PRODUCE total',
  NULL,
  'PRODUCE',
  NULL,
  SUM(expected_cost),
  'This should match PRODUCE movement total_value'
FROM expected_costs;

-- =====================================================
-- TEST 3: Apply the repair function
-- =====================================================

SELECT 'Applying repair function...' as test_name;
SELECT public.repair_work_order_costs('WO-1756124257');

-- =====================================================
-- TEST 4: Validate after repair
-- =====================================================

SELECT 
  'After repair - WO movements' as test_name,
  id, type, sku_id, quantity, unit_cost, total_value
FROM movements 
WHERE work_order_id = 'WO-1756124257'
ORDER BY created_at, type;

-- =====================================================
-- TEST 5: Validation integrity check
-- =====================================================

WITH validation_check AS (
  SELECT 
    m.work_order_id,
    SUM(CASE WHEN m.type IN ('ISSUE', 'WASTE') THEN ABS(m.total_value) ELSE 0 END) as total_issue_cost,
    SUM(CASE WHEN m.type = 'PRODUCE' THEN m.total_value ELSE 0 END) as total_produce_value
  FROM movements m
  WHERE m.work_order_id = 'WO-1756124257'
  GROUP BY m.work_order_id
)
SELECT 
  'Final validation' as test_name,
  work_order_id,
  total_issue_cost,
  total_produce_value,
  ABS(total_issue_cost - total_produce_value) as discrepancy,
  CASE 
    WHEN ABS(total_issue_cost - total_produce_value) < 0.01 THEN 'PASS'
    ELSE 'FAIL'
  END as result
FROM validation_check;

-- =====================================================
-- TEST 6: Test new Work Order creation with fixed function
-- =====================================================

SELECT 'Creating test Work Order with fixed function...' as test_name;

-- This should now work correctly and produce accurate costs
SELECT public.create_work_order_transaction(
  'Test Product After Fix',
  100,  -- quantity
  'unit',
  'AUTO',
  NULL, -- client
  'TEST-AFTER-FIX', -- invoice
  'Testing Work Order after integrity fixes',
  '[
    {"sku_id": "SKU-001", "quantity": 500, "type": "ISSUE"},
    {"sku_id": "SKU-002", "quantity": 200, "type": "ISSUE"}
  ]'::jsonb
);

-- Get the latest work order to validate it
WITH latest_wo AS (
  SELECT id
  FROM work_orders 
  WHERE reference = 'TEST-AFTER-FIX'
  ORDER BY created_at DESC 
  LIMIT 1
)
SELECT 
  'New Work Order movements' as test_name,
  m.id, m.type, m.sku_id, m.quantity, m.unit_cost, m.total_value
FROM movements m
JOIN latest_wo lw ON lw.id = m.work_order_id
ORDER BY m.created_at, m.type;

-- =====================================================
-- TEST 7: Layer consistency check
-- =====================================================

SELECT 
  'FIFO Layer integrity check' as test_name,
  fl.sku_id,
  fl.id as layer_id,
  fl.original_quantity,
  fl.remaining_quantity,
  fl.original_quantity - fl.remaining_quantity as consumed_calc,
  COALESCE(lc_sum.total_consumed, 0) as actual_consumed,
  ABS((fl.original_quantity - fl.remaining_quantity) - COALESCE(lc_sum.total_consumed, 0)) as discrepancy
FROM fifo_layers fl
LEFT JOIN (
  SELECT 
    layer_id,
    SUM(quantity_consumed) as total_consumed
  FROM layer_consumptions
  WHERE deleted_at IS NULL
  GROUP BY layer_id
) lc_sum ON lc_sum.layer_id = fl.id
WHERE fl.sku_id IN ('SKU-001', 'SKU-002')
ORDER BY fl.sku_id, fl.receiving_date;

ROLLBACK; -- Don't commit test data

SELECT 'All tests completed. Review results above.' as final_message;