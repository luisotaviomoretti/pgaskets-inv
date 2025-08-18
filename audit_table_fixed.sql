-- Migration: Movement Deletion Audit Trail (FIXED VERSION)
-- This creates an audit table to track all movement deletions

-- First, let's create the audit table without dependencies
CREATE TABLE IF NOT EXISTS movement_deletion_audit (
    id SERIAL PRIMARY KEY,
    
    -- Original movement information (captured before deletion)
    original_movement_id INTEGER NOT NULL,
    original_movement_type TEXT NOT NULL,
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
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add constraint for movement type if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movement_deletion_audit_movement_type_check') THEN
        ALTER TABLE movement_deletion_audit 
        ADD CONSTRAINT movement_deletion_audit_movement_type_check 
        CHECK (original_movement_type IN ('RECEIVE', 'ISSUE', 'WASTE', 'PRODUCE'));
    END IF;
END $$;

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_original_movement_id ON movement_deletion_audit(original_movement_id);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deleted_at ON movement_deletion_audit(deleted_at);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deleted_by ON movement_deletion_audit(deleted_by);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_original_sku_id ON movement_deletion_audit(original_sku_id);
CREATE INDEX IF NOT EXISTS idx_movement_deletion_audit_deletion_type ON movement_deletion_audit(deletion_type);

-- Row Level Security
ALTER TABLE movement_deletion_audit ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow authenticated users to read audit records" ON movement_deletion_audit;
DROP POLICY IF EXISTS "Allow system to insert audit records" ON movement_deletion_audit;

-- Policy: Allow authenticated users to read audit records
CREATE POLICY "Allow authenticated users to read audit records" ON movement_deletion_audit
    FOR SELECT USING (auth.role() = 'authenticated');

-- Policy: Allow system to insert audit records
CREATE POLICY "Allow system to insert audit records" ON movement_deletion_audit
    FOR INSERT WITH CHECK (true);

-- Function to log movement deletion to audit table (FIXED VERSION)
CREATE OR REPLACE FUNCTION log_movement_deletion(
    p_movement_id INTEGER,
    p_movement_type TEXT,
    p_sku_id TEXT,
    p_product_name TEXT,
    p_quantity DECIMAL(10,3),
    p_unit_cost DECIMAL(10,4),
    p_total_value DECIMAL(12,4),
    p_reference TEXT,
    p_datetime TIMESTAMPTZ,
    p_work_order_id TEXT,
    p_notes TEXT,
    p_vendor_id TEXT,
    p_deletion_type TEXT,
    p_deletion_reason TEXT DEFAULT NULL,
    p_deleted_by TEXT DEFAULT 'system',
    p_restored_layers JSONB DEFAULT NULL,
    p_session_info JSONB DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
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
        p_movement_id,
        p_movement_type,
        p_sku_id,
        p_product_name,
        p_quantity,
        p_unit_cost,
        p_total_value,
        p_reference,
        p_datetime,
        p_work_order_id,
        p_notes,
        p_vendor_id,
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
    movement_type TEXT,
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
    WITH stats_data AS (
        SELECT 
            deletion_type,
            original_movement_type,
            deleted_by,
            deleted_at
        FROM movement_deletion_audit
        WHERE 
            (p_date_from IS NULL OR deleted_at >= p_date_from)
            AND (p_date_to IS NULL OR deleted_at <= p_date_to)
    )
    SELECT jsonb_build_object(
        'total_deletions', COUNT(*),
        'deletions_by_type', COALESCE(
            (SELECT jsonb_object_agg(deletion_type, cnt) 
             FROM (SELECT deletion_type, COUNT(*) as cnt FROM stats_data GROUP BY deletion_type) t1), 
            '{}'::jsonb
        ),
        'deletions_by_movement_type', COALESCE(
            (SELECT jsonb_object_agg(original_movement_type, cnt) 
             FROM (SELECT original_movement_type, COUNT(*) as cnt FROM stats_data GROUP BY original_movement_type) t2), 
            '{}'::jsonb
        ),
        'deletions_by_user', COALESCE(
            (SELECT jsonb_object_agg(deleted_by, cnt) 
             FROM (SELECT deleted_by, COUNT(*) as cnt FROM stats_data GROUP BY deleted_by) t3), 
            '{}'::jsonb
        ),
        'date_range', jsonb_build_object(
            'from', COALESCE(p_date_from, (SELECT MIN(deleted_at) FROM stats_data)),
            'to', COALESCE(p_date_to, (SELECT MAX(deleted_at) FROM stats_data))
        )
    ) INTO v_stats
    FROM stats_data;
    
    RETURN COALESCE(v_stats, jsonb_build_object('total_deletions', 0));
END;
$$;
