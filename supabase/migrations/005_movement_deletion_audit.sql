-- Migration: Movement Deletion Audit Trail
-- This migration creates an audit table to track all movement deletions for compliance and debugging

-- Audit table for tracking movement deletions
CREATE TABLE IF NOT EXISTS movement_deletion_audit (
    id SERIAL PRIMARY KEY,
    
    -- Original movement information (captured before deletion)
    original_movement_id INTEGER NOT NULL,
    original_movement_type movement_type NOT NULL,
    original_sku_id TEXT,
    original_product_name TEXT,
    original_quantity DECIMAL(10,3) NOT NULL,
    original_unit_cost DECIMAL(10,4),
    original_total_value DECIMAL(12,4) NOT NULL,
    original_reference TEXT NOT NULL,
    original_datetime TIMESTAMPTZ NOT NULL,
    original_work_order_id TEXT,
    original_notes TEXT,
    original_vendor_id TEXT,
    
    -- Deletion metadata
    deletion_type TEXT NOT NULL CHECK (deletion_type IN ('REVERSE', 'DELETE')),
    deletion_reason TEXT,
    deleted_by TEXT NOT NULL DEFAULT 'system',
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- FIFO restoration details (JSON for flexibility)
    restored_layers JSONB,
    
    -- Additional context
    session_info JSONB,
    user_agent TEXT,
    ip_address INET,
    
    -- Indexes for performance
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_original_movement_id ON movement_deletion_audit(original_movement_id);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deleted_at ON movement_deletion_audit(deleted_at);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deleted_by ON movement_deletion_audit(deleted_by);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_original_sku_id ON movement_deletion_audit(original_sku_id);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deletion_type ON movement_deletion_audit(deletion_type);

-- Row Level Security
ALTER TABLE movement_deletion_audit ENABLE ROW LEVEL SECURITY;

-- Policy: Allow authenticated users to read audit records
DROP POLICY IF EXISTS "Allow authenticated users to read audit records" ON movement_deletion_audit;
CREATE POLICY "Allow authenticated users to read audit records" ON movement_deletion_audit
    FOR SELECT USING (auth.role() = 'authenticated');

-- Policy: Allow system to insert audit records
DROP POLICY IF EXISTS "Allow system to insert audit records" ON movement_deletion_audit;
CREATE POLICY "Allow system to insert audit records" ON movement_deletion_audit
    FOR INSERT WITH CHECK (true);

-- Function to log movement deletion to audit table
CREATE OR REPLACE FUNCTION public.log_movement_deletion(
    p_movement public.movements,
    p_deletion_type TEXT,
    p_deletion_reason TEXT DEFAULT NULL,
    p_deleted_by TEXT DEFAULT 'system',
    p_restored_layers JSONB DEFAULT NULL,
    p_session_info JSONB DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_audit_id INTEGER;
BEGIN
    INSERT INTO movement_deletion_audit (
        original_movement_id,
        original_movement_type,
        original_sku_id,
        original_product_name,
        original_quantity,
        original_unit_cost,
        original_total_value,
        original_reference,
        original_datetime,
        original_work_order_id,
        original_notes,
        original_vendor_id,
        deletion_type,
        deletion_reason,
        deleted_by,
        restored_layers,
        session_info
    ) VALUES (
        p_movement.id,
        p_movement.type,
        p_movement.sku_id,
        p_movement.product_name,
        p_movement.quantity,
        p_movement.unit_cost,
        p_movement.total_value,
        p_movement.reference,
        p_movement.datetime,
        p_movement.work_order_id,
        p_movement.notes,
        p_movement.vendor_id,
        p_deletion_type,
        p_deletion_reason,
        p_deleted_by,
        p_restored_layers,
        p_session_info
    ) RETURNING id INTO v_audit_id;
    
    RETURN v_audit_id;
END;
$$;

-- Function to get deletion audit history
DROP FUNCTION IF EXISTS public.get_movement_deletion_history(integer, integer, text, text, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION get_movement_deletion_history(
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0,
    p_sku_id TEXT DEFAULT NULL,
    p_deleted_by TEXT DEFAULT NULL,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    audit_id INTEGER,
    original_movement_id INTEGER,
    movement_type movement_type,
    sku_id TEXT,
    product_name TEXT,
    quantity DECIMAL(10,3),
    unit_cost DECIMAL(10,4),
    total_value DECIMAL(12,4),
    reference TEXT,
    movement_datetime TIMESTAMPTZ,
    deletion_type TEXT,
    deletion_reason TEXT,
    deleted_by TEXT,
    deleted_at TIMESTAMPTZ,
    restored_layers JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        mda.id,
        mda.original_movement_id,
        mda.original_movement_type,
        mda.original_sku_id,
        mda.original_product_name,
        mda.original_quantity,
        mda.original_unit_cost,
        mda.original_total_value,
        mda.original_reference,
        mda.original_datetime,
        mda.deletion_type,
        mda.deletion_reason,
        mda.deleted_by,
        mda.deleted_at,
        mda.restored_layers
    FROM movement_deletion_audit mda
    WHERE 
        (p_sku_id IS NULL OR mda.original_sku_id = p_sku_id)
        AND (p_deleted_by IS NULL OR mda.deleted_by = p_deleted_by)
        AND (p_date_from IS NULL OR mda.deleted_at >= p_date_from)
        AND (p_date_to IS NULL OR mda.deleted_at <= p_date_to)
    ORDER BY mda.deleted_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Function to get deletion statistics
DROP FUNCTION IF EXISTS public.get_deletion_statistics(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION get_deletion_statistics(
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_stats JSONB;
BEGIN
    SELECT jsonb_build_object(
        'total_deletions', COUNT(*),
        'deletions_by_type', jsonb_object_agg(deletion_type, type_count),
        'deletions_by_movement_type', jsonb_object_agg(original_movement_type, movement_type_count),
        'deletions_by_user', jsonb_object_agg(deleted_by, user_count),
        'date_range', jsonb_build_object(
            'from', COALESCE(p_date_from, MIN(deleted_at)),
            'to', COALESCE(p_date_to, MAX(deleted_at))
        )
    ) INTO v_stats
    FROM (
        SELECT 
            deletion_type,
            original_movement_type,
            deleted_by,
            deleted_at,
            COUNT(*) OVER (PARTITION BY deletion_type) as type_count,
            COUNT(*) OVER (PARTITION BY original_movement_type) as movement_type_count,
            COUNT(*) OVER (PARTITION BY deleted_by) as user_count
        FROM movement_deletion_audit
        WHERE 
            (p_date_from IS NULL OR deleted_at >= p_date_from)
            AND (p_date_to IS NULL OR deleted_at <= p_date_to)
    ) stats;
    
    RETURN COALESCE(v_stats, '{}'::jsonb);
END;
$$;
