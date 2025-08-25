-- Comprehensive FIFO Validation Bug Investigation
-- This script diagnoses the critical validation issue

BEGIN;

-- Test 1: Check specific layers mentioned in bug report
SELECT 
    'Layer Data Analysis' as investigation,
    id,
    sku_id,
    original_quantity,
    remaining_quantity,
    (original_quantity - remaining_quantity) as consumed_so_far,
    status,
    created_at
FROM fifo_layers 
WHERE id IN ('SKU-001-L1755733570', 'SKU-002-L1755775429')
ORDER BY sku_id;

-- Test 2: Check layer_consumptions for these layers
SELECT 
    'Historical Consumptions' as investigation,
    lc.layer_id,
    COUNT(*) as consumption_records,
    SUM(lc.quantity_consumed) as total_consumed_from_records,
    fl.original_quantity,
    fl.remaining_quantity,
    (fl.original_quantity - fl.remaining_quantity) as consumed_by_remaining_calc
FROM layer_consumptions lc
JOIN fifo_layers fl ON fl.id = lc.layer_id
WHERE lc.layer_id IN ('SKU-001-L1755733570', 'SKU-002-L1755775429')
GROUP BY lc.layer_id, fl.original_quantity, fl.remaining_quantity
ORDER BY lc.layer_id;

-- Test 3: Validate the buggy validation logic
-- This simulates what validate_layer_consumption() does
WITH test_consumption AS (
    -- Simulate consuming 4000 from SKU-001 and 3000 from SKU-002
    SELECT 'SKU-001-L1755733570' as layer_id, 4000 as new_consumption
    UNION ALL
    SELECT 'SKU-002-L1755775429' as layer_id, 3000 as new_consumption
)
SELECT 
    'Validation Logic Test' as investigation,
    tc.layer_id,
    tc.new_consumption,
    fl.original_quantity,
    fl.remaining_quantity,
    COALESCE(SUM(lc.quantity_consumed), 0) as historical_consumption,
    (COALESCE(SUM(lc.quantity_consumed), 0) + tc.new_consumption) as total_would_be_consumed,
    fl.original_quantity as max_allowed,
    -- This is the BUGGY logic:
    CASE 
        WHEN (COALESCE(SUM(lc.quantity_consumed), 0) + tc.new_consumption) > fl.original_quantity 
        THEN 'BLOCKED BY BUGGY LOGIC'
        ELSE 'WOULD PASS'
    END as buggy_validation_result,
    -- This is the CORRECT logic:
    CASE 
        WHEN tc.new_consumption > fl.remaining_quantity
        THEN 'SHOULD BE BLOCKED - INSUFFICIENT REMAINING'
        ELSE 'SHOULD PASS - SUFFICIENT REMAINING'
    END as correct_validation_result
FROM test_consumption tc
LEFT JOIN fifo_layers fl ON fl.id = tc.layer_id
LEFT JOIN layer_consumptions lc ON lc.layer_id = tc.layer_id
GROUP BY tc.layer_id, tc.new_consumption, fl.original_quantity, fl.remaining_quantity;

-- Test 4: Check for data inconsistencies
SELECT 
    'Data Consistency Check' as investigation,
    fl.id,
    fl.sku_id,
    fl.original_quantity,
    fl.remaining_quantity,
    COALESCE(SUM(lc.quantity_consumed), 0) as sum_of_consumptions,
    (fl.original_quantity - COALESCE(SUM(lc.quantity_consumed), 0)) as calculated_remaining,
    (fl.remaining_quantity - (fl.original_quantity - COALESCE(SUM(lc.quantity_consumed), 0))) as discrepancy,
    CASE 
        WHEN fl.remaining_quantity = (fl.original_quantity - COALESCE(SUM(lc.quantity_consumed), 0))
        THEN 'CONSISTENT'
        ELSE 'INCONSISTENT'
    END as consistency_status
FROM fifo_layers fl
LEFT JOIN layer_consumptions lc ON lc.layer_id = fl.id
WHERE fl.sku_id IN ('SKU-001', 'SKU-002') 
   OR fl.id IN ('SKU-001-L1755733570', 'SKU-002-L1755775429')
GROUP BY fl.id, fl.sku_id, fl.original_quantity, fl.remaining_quantity
ORDER BY fl.sku_id, fl.id;

-- Test 5: Check available quantities
SELECT 
    'Available Quantities' as investigation,
    fl.sku_id,
    COUNT(*) as layer_count,
    SUM(fl.original_quantity) as total_original,
    SUM(fl.remaining_quantity) as total_available,
    SUM(fl.original_quantity - fl.remaining_quantity) as total_consumed
FROM fifo_layers fl
WHERE fl.sku_id IN ('SKU-001', 'SKU-002')
  AND fl.status = 'ACTIVE'
GROUP BY fl.sku_id
ORDER BY fl.sku_id;

-- Test 6: Run the consistency validation function
SELECT * FROM validate_fifo_consistency() 
WHERE sku_id IN ('SKU-001', 'SKU-002')
ORDER BY sku_id;

ROLLBACK; -- Don't modify anything, just investigate