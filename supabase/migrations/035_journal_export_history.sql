-- Migration: Create journal_export_history table for tracking exported movements
-- Purpose: Enable multi-device sync and persistent tracking of journal exports
-- Created: 2025-08-25

-- Create the journal_export_history table
CREATE TABLE IF NOT EXISTS journal_export_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    movement_id TEXT NOT NULL,
    exported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    journal_number TEXT,
    device_info JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT unique_user_movement UNIQUE (user_id, movement_id)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_journal_export_history_user_id 
    ON journal_export_history (user_id);

CREATE INDEX IF NOT EXISTS idx_journal_export_history_movement_id 
    ON journal_export_history (movement_id);

CREATE INDEX IF NOT EXISTS idx_journal_export_history_exported_at 
    ON journal_export_history (exported_at DESC);

CREATE INDEX IF NOT EXISTS idx_journal_export_history_created_at 
    ON journal_export_history (created_at DESC);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_journal_export_history_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_journal_export_history_updated_at
    BEFORE UPDATE ON journal_export_history
    FOR EACH ROW
    EXECUTE FUNCTION update_journal_export_history_updated_at();

-- Enable Row Level Security (RLS)
ALTER TABLE journal_export_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own export history
CREATE POLICY "Users can view their own journal export history"
    ON journal_export_history
    FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own journal export history"
    ON journal_export_history
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own journal export history"
    ON journal_export_history
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own journal export history"
    ON journal_export_history
    FOR DELETE
    USING (user_id = auth.uid());

-- Grant necessary permissions to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_export_history TO authenticated;
-- Note: No sequence needed since we're using UUID with gen_random_uuid()

-- Add helpful comments
COMMENT ON TABLE journal_export_history IS 'Tracks which movements have been exported to journal entries by each user';
COMMENT ON COLUMN journal_export_history.user_id IS 'User who performed the export';
COMMENT ON COLUMN journal_export_history.movement_id IS 'ID of the movement that was exported';
COMMENT ON COLUMN journal_export_history.exported_at IS 'When the movement was exported';
COMMENT ON COLUMN journal_export_history.journal_number IS 'Journal number used in the export (e.g., J-20250825-001)';
COMMENT ON COLUMN journal_export_history.device_info IS 'Optional device/browser information for debugging';