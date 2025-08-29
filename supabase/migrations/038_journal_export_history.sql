-- ============================================================================
-- Journal Export History Migration
-- Creates tables and functions for tracking journal export history
-- ============================================================================

-- Create export_status enum
CREATE TYPE export_status AS ENUM (
    'exported',
    'synced', 
    'failed',
    'pending'
);

-- Create sync_status enum
CREATE TYPE sync_status AS ENUM (
    'synced',
    'pending',
    'failed',
    'not_required'
);

-- ============================================================================
-- JOURNAL EXPORT HISTORY TABLE
-- ============================================================================

CREATE TABLE journal_export_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_number VARCHAR(20) NOT NULL UNIQUE,
    export_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Movement summary
    movements_count INTEGER NOT NULL DEFAULT 0,
    movement_breakdown JSONB NOT NULL DEFAULT '{}',
    
    -- Financial summary
    total_value DECIMAL(15,2) NOT NULL DEFAULT 0,
    financial_breakdown JSONB NOT NULL DEFAULT '{}',
    
    -- Status tracking
    export_status export_status NOT NULL DEFAULT 'exported',
    sync_status sync_status NOT NULL DEFAULT 'pending',
    
    -- File metadata
    filename VARCHAR(255) NOT NULL,
    file_size BIGINT,
    checksum VARCHAR(64),
    exported_by VARCHAR(255) NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    CONSTRAINT valid_journal_number CHECK (journal_number ~ '^JNL-\d{8}-\d{3}$'),
    CONSTRAINT positive_movements_count CHECK (movements_count >= 0),
    CONSTRAINT positive_total_value CHECK (total_value >= 0),
    CONSTRAINT valid_filename CHECK (length(trim(filename)) > 0),
    CONSTRAINT valid_exported_by CHECK (length(trim(exported_by)) > 0)
);

-- Indexes for performance
CREATE INDEX idx_journal_export_history_date ON journal_export_history (export_date DESC);
CREATE INDEX idx_journal_export_history_status ON journal_export_history (export_status);
CREATE INDEX idx_journal_export_history_sync_status ON journal_export_history (sync_status);
CREATE INDEX idx_journal_export_history_exported_by ON journal_export_history (exported_by);
CREATE INDEX idx_journal_export_history_active ON journal_export_history (export_date DESC) WHERE deleted_at IS NULL;

-- ============================================================================
-- JOURNAL EXPORT MOVEMENTS TABLE (Detailed tracking)
-- ============================================================================

CREATE TABLE journal_export_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    export_id UUID NOT NULL REFERENCES journal_export_history(id) ON DELETE CASCADE,
    movement_id UUID NOT NULL, -- References movements.id but no FK for flexibility
    
    -- Snapshot of movement data at export time
    movement_type VARCHAR(20) NOT NULL,
    quantity INTEGER NOT NULL,
    value DECIMAL(15,2) NOT NULL,
    sku_code VARCHAR(50) NOT NULL,
    reference VARCHAR(255),
    movement_date TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Export-specific fields
    journal_entry_reference VARCHAR(255),
    accounting_debit_account VARCHAR(100),
    accounting_credit_account VARCHAR(100),
    
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for export movements
CREATE INDEX idx_journal_export_movements_export ON journal_export_movements (export_id);
CREATE INDEX idx_journal_export_movements_original ON journal_export_movements (movement_id);
CREATE INDEX idx_journal_export_movements_type ON journal_export_movements (movement_type);
CREATE INDEX idx_journal_export_movements_sku ON journal_export_movements (sku_code);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to create export history record
CREATE OR REPLACE FUNCTION create_export_history(
    p_journal_number VARCHAR(20),
    p_movements_data JSONB[],
    p_filename VARCHAR(255),
    p_exported_by VARCHAR(255),
    p_total_value DECIMAL(15,2) DEFAULT 0
) RETURNS UUID AS $$
DECLARE
    v_export_id UUID;
    v_movements_count INTEGER;
    v_movement_breakdown JSONB := '{}';
    v_financial_breakdown JSONB := '{}';
    v_movement JSONB;
    v_movement_type VARCHAR(20);
    v_movement_value DECIMAL(15,2);
BEGIN
    -- Calculate movement statistics
    v_movements_count := array_length(p_movements_data, 1);
    
    -- Build breakdown data
    FOR i IN 1..v_movements_count LOOP
        v_movement := p_movements_data[i];
        v_movement_type := v_movement->>'type';
        v_movement_value := COALESCE((v_movement->>'value')::DECIMAL(15,2), 0);
        
        -- Count movements by type
        v_movement_breakdown := jsonb_set(
            v_movement_breakdown,
            ARRAY[v_movement_type],
            to_jsonb(COALESCE((v_movement_breakdown->>v_movement_type)::INTEGER, 0) + 1)
        );
        
        -- Sum values by type
        v_financial_breakdown := jsonb_set(
            v_financial_breakdown,
            ARRAY[v_movement_type],
            to_jsonb(COALESCE((v_financial_breakdown->>v_movement_type)::DECIMAL(15,2), 0) + ABS(v_movement_value))
        );
    END LOOP;
    
    -- Insert export history record
    INSERT INTO journal_export_history (
        journal_number,
        movements_count,
        movement_breakdown,
        total_value,
        financial_breakdown,
        filename,
        exported_by
    ) VALUES (
        p_journal_number,
        v_movements_count,
        v_movement_breakdown,
        p_total_value,
        v_financial_breakdown,
        p_filename,
        p_exported_by
    ) RETURNING id INTO v_export_id;
    
    RETURN v_export_id;
END;
$$ LANGUAGE plpgsql;

-- Function to update export status
CREATE OR REPLACE FUNCTION update_export_status(
    p_export_id UUID,
    p_export_status export_status DEFAULT NULL,
    p_sync_status sync_status DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE journal_export_history 
    SET 
        export_status = COALESCE(p_export_status, export_status),
        sync_status = COALESCE(p_sync_status, sync_status),
        updated_at = NOW(),
        synced_at = CASE 
            WHEN p_sync_status = 'synced' THEN NOW()
            ELSE synced_at
        END
    WHERE id = p_export_id AND deleted_at IS NULL;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function to get export history with filters
CREATE OR REPLACE FUNCTION get_export_history(
    p_date_from TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_date_to TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_export_status export_status DEFAULT NULL,
    p_sync_status sync_status DEFAULT NULL,
    p_min_value DECIMAL(15,2) DEFAULT NULL,
    p_max_value DECIMAL(15,2) DEFAULT NULL,
    p_search_term VARCHAR(255) DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
    id UUID,
    journal_number VARCHAR(20),
    export_date TIMESTAMP WITH TIME ZONE,
    movements_count INTEGER,
    movement_breakdown JSONB,
    total_value DECIMAL(15,2),
    financial_breakdown JSONB,
    export_status export_status,
    sync_status sync_status,
    filename VARCHAR(255),
    file_size BIGINT,
    checksum VARCHAR(64),
    exported_by VARCHAR(255),
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        jeh.id,
        jeh.journal_number,
        jeh.export_date,
        jeh.movements_count,
        jeh.movement_breakdown,
        jeh.total_value,
        jeh.financial_breakdown,
        jeh.export_status,
        jeh.sync_status,
        jeh.filename,
        jeh.file_size,
        jeh.checksum,
        jeh.exported_by,
        jeh.synced_at,
        jeh.created_at,
        jeh.updated_at
    FROM journal_export_history jeh
    WHERE jeh.deleted_at IS NULL
        AND (p_date_from IS NULL OR jeh.export_date >= p_date_from)
        AND (p_date_to IS NULL OR jeh.export_date <= p_date_to)
        AND (p_export_status IS NULL OR jeh.export_status = p_export_status)
        AND (p_sync_status IS NULL OR jeh.sync_status = p_sync_status)
        AND (p_min_value IS NULL OR jeh.total_value >= p_min_value)
        AND (p_max_value IS NULL OR jeh.total_value <= p_max_value)
        AND (p_search_term IS NULL OR 
             jeh.journal_number ILIKE '%' || p_search_term || '%' OR
             jeh.filename ILIKE '%' || p_search_term || '%' OR
             jeh.exported_by ILIKE '%' || p_search_term || '%')
    ORDER BY jeh.export_date DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;

-- Function to get export metrics
CREATE OR REPLACE FUNCTION get_export_metrics(
    p_date_from TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_date_to TIMESTAMP WITH TIME ZONE DEFAULT NULL
) RETURNS TABLE (
    total_exports BIGINT,
    total_value DECIMAL(15,2),
    last_export_date TIMESTAMP WITH TIME ZONE,
    synced_count BIGINT,
    pending_count BIGINT,
    failed_count BIGINT,
    movement_breakdown JSONB
) AS $$
DECLARE
    v_movement_breakdown JSONB := '{}';
    v_breakdown_record RECORD;
BEGIN
    -- Get basic metrics
    SELECT 
        COUNT(*),
        COALESCE(SUM(jeh.total_value), 0),
        MAX(jeh.export_date),
        COUNT(*) FILTER (WHERE jeh.sync_status = 'synced'),
        COUNT(*) FILTER (WHERE jeh.sync_status = 'pending'),
        COUNT(*) FILTER (WHERE jeh.sync_status = 'failed')
    INTO 
        total_exports,
        total_value,
        last_export_date,
        synced_count,
        pending_count,
        failed_count
    FROM journal_export_history jeh
    WHERE jeh.deleted_at IS NULL
        AND (p_date_from IS NULL OR jeh.export_date >= p_date_from)
        AND (p_date_to IS NULL OR jeh.export_date <= p_date_to);
    
    -- Calculate movement breakdown totals
    FOR v_breakdown_record IN
        SELECT 
            key as movement_type,
            SUM(value::INTEGER) as total_count
        FROM journal_export_history jeh,
             jsonb_each(jeh.movement_breakdown)
        WHERE jeh.deleted_at IS NULL
            AND (p_date_from IS NULL OR jeh.export_date >= p_date_from)
            AND (p_date_to IS NULL OR jeh.export_date <= p_date_to)
        GROUP BY key
    LOOP
        v_movement_breakdown := jsonb_set(
            v_movement_breakdown,
            ARRAY[v_breakdown_record.movement_type],
            to_jsonb(v_breakdown_record.total_count)
        );
    END LOOP;
    
    movement_breakdown := v_movement_breakdown;
    
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ROW LEVEL SECURITY (Disabled for now, will be configured later)
-- ============================================================================

-- Enable RLS on tables (commented out for development)
-- ALTER TABLE journal_export_history ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE journal_export_movements ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_journal_export_history_updated_at
    BEFORE UPDATE ON journal_export_history
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- SAMPLE DATA (Development only)
-- ============================================================================

-- Insert sample export history for testing
-- (Only if in development environment)
DO $$
BEGIN
    IF current_setting('app.environment', true) = 'development' THEN
        INSERT INTO journal_export_history (
            journal_number,
            movements_count,
            movement_breakdown,
            total_value,
            financial_breakdown,
            filename,
            exported_by
        ) VALUES 
        (
            'JNL-20240101-001',
            25,
            '{"RECEIVE": 15, "ISSUE": 8, "ADJUSTMENT": 2}',
            12500.50,
            '{"RECEIVE": 8500.00, "ISSUE": 3200.50, "ADJUSTMENT": 800.00}',
            'journal_JNL-20240101-001.xlsx',
            'admin@pgaskets.com'
        ),
        (
            'JNL-20240102-001',
            18,
            '{"RECEIVE": 12, "ISSUE": 6}',
            9750.25,
            '{"RECEIVE": 7200.00, "ISSUE": 2550.25}',
            'journal_JNL-20240102-001.xlsx',
            'admin@pgaskets.com'
        );
    END IF;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE journal_export_history IS 'Tracks all journal export operations with metadata and status';
COMMENT ON TABLE journal_export_movements IS 'Detailed snapshot of movements included in each export';

COMMENT ON COLUMN journal_export_history.journal_number IS 'Unique journal number in format JNL-YYYYMMDD-NNN';
COMMENT ON COLUMN journal_export_history.movement_breakdown IS 'Count of movements by type (RECEIVE, ISSUE, etc.)';
COMMENT ON COLUMN journal_export_history.financial_breakdown IS 'Total value by movement type';
COMMENT ON COLUMN journal_export_history.export_status IS 'Current export status (exported, synced, failed, pending)';
COMMENT ON COLUMN journal_export_history.sync_status IS 'Sync status with external systems';

COMMENT ON FUNCTION create_export_history IS 'Creates new export history record with movement statistics';
COMMENT ON FUNCTION update_export_status IS 'Updates export and sync status for tracking';
COMMENT ON FUNCTION get_export_history IS 'Retrieves export history with flexible filtering';
COMMENT ON FUNCTION get_export_metrics IS 'Calculates export metrics and statistics';