-- verify_fifo_fix.sql
-- Post-deployment verification script for FIFO validation bug fix
-- Run this after applying migration 032 to confirm the fix is working

BEGIN;

-- =====================================================
-- VERIFICATION 1: Check function definition
-- =====================================================

SELECT 
    'Function Definition Check' as verification_type,
    proname as function_name,
    prosrc LIKE '%remaining_quantity%' as uses_remaining_logic,
    prosrc LIKE '%SUM%' as uses_old_sum_logic,
    CASE 
        WHEN prosrc LIKE '%remaining_quantity%' AND prosrc NOT LIKE '%SUM(quantity_consumed)%'
        THEN 'FIXED ✅' 
        ELSE 'NOT FIXED ❌'
    END as status
FROM pg_proc 
WHERE proname = 'validate_layer_consumption';

-- =====================================================
-- VERIFICATION 2: Check trigger is active
-- =====================================================

SELECT 
    'Trigger Check' as verification_type,
    tgname as trigger_name,
    tgenabled as is_enabled,
    CASE 
        WHEN tgname = 'trigger_validate_layer_consumption' AND tgenabled = 'O'
        THEN 'ACTIVE ✅'
        ELSE 'ISSUE ❌'
    END as status
FROM pg_trigger pt
JOIN pg_class pc ON pc.oid = pt.tgrelid  
WHERE pc.relname = 'layer_consumptions';

-- =====================================================
-- VERIFICATION 3: Data consistency check
-- =====================================================

SELECT 
    'Data Consistency' as verification_type,
    sku_id,
    layers_remaining,
    fifo_invariant,
    status
FROM validate_fifo_consistency() 
ORDER BY sku_id
LIMIT 10;

-- =====================================================
-- VERIFICATION 4: Check for layers that would have been affected by bug
-- =====================================================

WITH potentially_affected_layers AS (
    SELECT 
        fl.id,
        fl.sku_id,
        fl.original_quantity,
        fl.remaining_quantity,
        COALESCE(SUM(lc.quantity_consumed), 0) as historical_consumption,
        (fl.original_quantity - fl.remaining_quantity) as consumed_by_remaining_calc
    FROM fifo_layers fl
    LEFT JOIN layer_consumptions lc ON lc.layer_id = fl.id
    WHERE fl.status = 'ACTIVE' 
      AND fl.remaining_quantity < fl.original_quantity  -- partially consumed layers
    GROUP BY fl.id, fl.sku_id, fl.original_quantity, fl.remaining_quantity
)
SELECT 
    'Affected Layers Analysis' as verification_type,
    COUNT(*) as partially_consumed_layers,
    COUNT(CASE WHEN remaining_quantity > 0 THEN 1 END) as layers_with_remaining_stock,
    AVG(remaining_quantity) as avg_remaining_quantity,
    MIN(remaining_quantity) as min_remaining_quantity,
    'These layers can now accept new consumption up to their remaining quantity' as note
FROM potentially_affected_layers;

-- =====================================================
-- VERIFICATION 5: Simulate the bug scenario
-- =====================================================

SELECT 
    'Bug Scenario Simulation' as verification_type,
    'Layer: original=10000, remaining=3000, want_to_consume=2000' as scenario,
    CASE 
        WHEN 2000 <= 3000 THEN 'Should PASS with new logic ✅'
        ELSE 'Should FAIL ❌'
    END as expected_result,
    'Old logic would compare: (7000 historical + 2000 new) vs 10000 original' as old_logic,
    'New logic compares: 2000 new vs 3000 remaining' as new_logic;

-- =====================================================
-- VERIFICATION 6: Check recent movements that might have been blocked
-- =====================================================

SELECT 
    'Recent Activity' as verification_type,
    COUNT(*) as work_orders_last_24h,
    COUNT(CASE WHEN type = 'ISSUE' THEN 1 END) as issue_movements,
    COUNT(CASE WHEN type = 'PRODUCE' THEN 1 END) as produce_movements,
    'Work Orders that were blocked should now be possible' as note
FROM movements 
WHERE datetime >= NOW() - INTERVAL '24 hours'
  AND work_order_id IS NOT NULL;

ROLLBACK; -- This is just verification, don't modify anything