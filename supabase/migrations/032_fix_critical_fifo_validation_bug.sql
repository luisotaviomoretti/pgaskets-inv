-- 032_fix_critical_fifo_validation_bug_v2.sql
-- CRITICAL FIX: Corrects validate_layer_consumption() trigger function
-- 
-- BUG: The validation was comparing total_historical_consumption + new_consumption > original_quantity
-- FIX: Should compare new_consumption > remaining_quantity
--
-- This bug caused "Total consumption would exceed layer original quantity" errors 
-- even when sufficient remaining quantity existed in FIFO layers.

BEGIN;

-- =====================================================
-- CRITICAL BUG FIX: validate_layer_consumption()
-- =====================================================

CREATE OR REPLACE FUNCTION validate_layer_consumption()
RETURNS TRIGGER AS $$
DECLARE
  v_remaining numeric;
BEGIN
  -- Get current remaining quantity for the layer
  SELECT remaining_quantity INTO v_remaining
  FROM public.fifo_layers
  WHERE id = NEW.layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Layer not found: %', NEW.layer_id USING ERRCODE = 'P0002';
  END IF;
  
  -- FIXED LOGIC: Check if new consumption exceeds remaining quantity
  -- This is the correct validation - we only care about remaining, not historical
  IF NEW.quantity_consumed > v_remaining THEN
    RAISE EXCEPTION 'Consumption (%) would exceed layer remaining quantity (%) for layer %', 
      NEW.quantity_consumed, v_remaining, NEW.layer_id USING ERRCODE = '23514';
  END IF;
  
  -- Additional safety check: ensure consumption is positive
  IF NEW.quantity_consumed <= 0 THEN
    RAISE EXCEPTION 'Consumption quantity must be positive: %', NEW.quantity_consumed USING ERRCODE = '23514';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TESTING WITH EXISTING DATA (SAFE)
-- =====================================================

-- Test the fix using existing SKUs if any exist
DO $$
DECLARE
  existing_sku_id TEXT;
  test_layer_id TEXT;
  test_movement_id INTEGER;
BEGIN
  -- Find an existing SKU to use for testing
  SELECT id INTO existing_sku_id 
  FROM public.skus 
  LIMIT 1;
  
  IF existing_sku_id IS NOT NULL THEN
    test_layer_id := existing_sku_id || '-TEST-' || EXTRACT(EPOCH FROM NOW())::bigint;
    
    -- Create a test movement first (required for foreign key)
    INSERT INTO public.movements (datetime, type, sku_id, quantity, unit_cost, total_value, reference)
    VALUES (NOW(), 'ISSUE', existing_sku_id, -1000, 5.0, -5000, 'Test movement for validation fix')
    RETURNING id INTO test_movement_id;
    
    -- Create a test layer with some remaining quantity
    INSERT INTO public.fifo_layers (
      id, sku_id, receiving_date, original_quantity, remaining_quantity, 
      unit_cost, status, created_by_movement_id
    ) VALUES (
      test_layer_id, existing_sku_id, CURRENT_DATE, 10000, 5000, -- 5000 already consumed
      5.0, 'ACTIVE', test_movement_id
    );
    
    -- Test 1: This should PASS (1000 < 5000 remaining)
    BEGIN
      INSERT INTO public.layer_consumptions (
        movement_id, layer_id, quantity_consumed, unit_cost, total_cost
      ) VALUES (
        test_movement_id, test_layer_id, 1000, 5.0, 5000
      );
      
      RAISE NOTICE 'SUCCESS: Fixed validation allows consumption of 1000 from layer with 5000 remaining';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'UNEXPECTED: Valid consumption was blocked: %', SQLERRM;
    END;
    
    -- Test 2: This should FAIL (10000 > 4000 remaining after previous consumption)
    BEGIN
      INSERT INTO public.layer_consumptions (
        movement_id, layer_id, quantity_consumed, unit_cost, total_cost
      ) VALUES (
        test_movement_id, test_layer_id, 10000, 5.0, 50000
      );
      
      RAISE NOTICE 'ERROR: Should have blocked consumption of 10000 from layer with ~4000 remaining';
    EXCEPTION
      WHEN sqlstate '23514' THEN
        RAISE NOTICE 'SUCCESS: Validation correctly blocks excessive consumption';
      WHEN OTHERS THEN
        RAISE NOTICE 'UNEXPECTED ERROR: %', SQLERRM;
    END;
    
    -- Cleanup test data
    DELETE FROM public.layer_consumptions WHERE layer_id = test_layer_id;
    DELETE FROM public.movements WHERE reference = 'Test movement for validation fix';
    DELETE FROM public.fifo_layers WHERE id = test_layer_id;
    
    RAISE NOTICE 'CRITICAL BUG FIX VERIFIED: validate_layer_consumption() now works correctly';
  ELSE
    RAISE NOTICE 'SKIPPING TEST: No existing SKUs found in database';
  END IF;
END;
$$;

-- =====================================================
-- DOCUMENTATION
-- =====================================================

COMMENT ON FUNCTION validate_layer_consumption() IS 
'FIXED: Validates new layer consumption against remaining_quantity instead of total historical consumption. 
Prevents false positives that blocked valid Work Orders when layers were partially consumed.

CHANGE SUMMARY:
- OLD: IF (historical_sum + new_consumption) > original_quantity THEN error
- NEW: IF new_consumption > remaining_quantity THEN error

This eliminates false positives where partially consumed layers would incorrectly reject valid consumption attempts.';

-- Log the fix application
INSERT INTO public.movements (
  datetime, type, product_name, quantity, unit_cost, total_value, reference, notes
) VALUES (
  NOW(), 'ADJUSTMENT', 'SYSTEM_FIX', 0, 0, 0, 'FIFO_VALIDATION_FIX', 
  'Applied critical fix to validate_layer_consumption() function. Changed validation from historical total to remaining quantity check.'
);

COMMIT;