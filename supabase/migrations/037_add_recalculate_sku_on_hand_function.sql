-- Add recalculate_sku_on_hand function for FIFO layer adjustments
-- This function recalculates the on_hand quantity for a SKU based on active FIFO layers
-- Used after layer adjustments to maintain inventory consistency
-- Created: 2025-08-29

BEGIN;

-- Create function to recalculate SKU on_hand from active FIFO layers
CREATE OR REPLACE FUNCTION public.recalculate_sku_on_hand(p_sku_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_total_quantity DECIMAL(10,3) := 0;
BEGIN
    -- Calculate total remaining quantity from all active FIFO layers
    SELECT COALESCE(SUM(remaining_quantity), 0)
    INTO v_total_quantity
    FROM public.fifo_layers
    WHERE sku_id = p_sku_id 
    AND status = 'ACTIVE'
    AND remaining_quantity > 0;
    
    -- Update SKU on_hand with calculated total
    UPDATE public.skus
    SET on_hand = v_total_quantity,
        updated_at = NOW()
    WHERE id = p_sku_id;
    
    -- Log the recalculation for audit purposes
    RAISE NOTICE 'Recalculated on_hand for SKU % = %', p_sku_id, v_total_quantity;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.recalculate_sku_on_hand(TEXT) TO authenticated;

-- Create helper function for transaction management if not exists
CREATE OR REPLACE FUNCTION public.begin_transaction()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- PostgreSQL automatically handles transactions in functions
    -- This is a placeholder for explicit transaction control if needed
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_transaction()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- PostgreSQL automatically commits at function end
    -- This is a placeholder for explicit transaction control if needed
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_transaction()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Raise an exception to trigger rollback
    RAISE EXCEPTION 'Transaction rollback requested';
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.begin_transaction() TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_transaction() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_transaction() TO authenticated;

COMMIT;

-- Verification queries (run manually to test)
-- SELECT public.recalculate_sku_on_hand('TEST-SKU-001');
-- SELECT id, on_hand FROM public.skus WHERE id = 'TEST-SKU-001';