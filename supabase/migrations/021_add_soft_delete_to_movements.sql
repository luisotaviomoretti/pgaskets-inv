-- Migration: Add Soft Delete to Movements Table
-- This migration adds soft delete functionality to movements table
-- Created: 2025-08-20

-- 1) Add soft delete columns to movements table
ALTER TABLE movements 
ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN deleted_by TEXT DEFAULT NULL,
ADD COLUMN deletion_reason TEXT DEFAULT NULL;

-- 2) Create index for active (non-deleted) movements
CREATE INDEX idx_movements_active ON movements(deleted_at) WHERE deleted_at IS NULL;

-- 3) Create index for deleted movements (for audit purposes)
CREATE INDEX idx_movements_deleted ON movements(deleted_at) WHERE deleted_at IS NOT NULL;

-- 4) Add comments for documentation
COMMENT ON COLUMN movements.deleted_at IS 'Timestamp when movement was soft deleted (NULL = active)';
COMMENT ON COLUMN movements.deleted_by IS 'User who performed the soft delete';
COMMENT ON COLUMN movements.deletion_reason IS 'Reason for soft delete (optional)';

-- 5) Update movement_history view to only show active movements
DROP VIEW IF EXISTS movement_history;
CREATE VIEW movement_history AS
SELECT 
    m.id,
    m.datetime,
    m.type,
    COALESCE(m.sku_id, m.product_name) as sku_or_name,
    m.quantity,
    m.total_value,
    m.reference,
    m.work_order_id,
    m.notes,
    s.unit,
    s.description as sku_description,
    m.deleted_at,
    m.deleted_by
FROM movements m
LEFT JOIN skus s ON m.sku_id = s.id
WHERE m.deleted_at IS NULL  -- Only show active movements
ORDER BY m.datetime DESC;

-- 6) Create view for deleted movements (audit purposes)
CREATE VIEW deleted_movement_history AS
SELECT 
    m.id,
    m.datetime,
    m.type,
    COALESCE(m.sku_id, m.product_name) as sku_or_name,
    m.quantity,
    m.total_value,
    m.reference,
    m.work_order_id,
    m.notes,
    s.unit,
    s.description as sku_description,
    m.deleted_at,
    m.deleted_by,
    m.deletion_reason
FROM movements m
LEFT JOIN skus s ON m.sku_id = s.id
WHERE m.deleted_at IS NOT NULL  -- Only show deleted movements
ORDER BY m.deleted_at DESC;

-- 7) Grant permissions on new views
GRANT SELECT ON movement_history TO anon, authenticated, service_role;
GRANT SELECT ON deleted_movement_history TO anon, authenticated, service_role;

-- 8) Update the SKU on_hand trigger to ignore deleted movements
CREATE OR REPLACE FUNCTION update_sku_on_hand()
RETURNS TRIGGER AS $$
BEGIN
    -- Only process if movement is not deleted
    IF NEW.sku_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
        UPDATE skus 
        SET 
            on_hand = on_hand + NEW.quantity,
            updated_at = NOW()
        WHERE id = NEW.sku_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 9) Add trigger to handle soft delete restoration
CREATE OR REPLACE FUNCTION handle_movement_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- If movement is being soft deleted
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        -- Reverse the on_hand impact
        IF NEW.sku_id IS NOT NULL THEN
            UPDATE skus 
            SET 
                on_hand = on_hand - NEW.quantity,
                updated_at = NOW()
            WHERE id = NEW.sku_id;
        END IF;
    END IF;
    
    -- If movement is being restored (undeleted)
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        -- Reapply the on_hand impact
        IF NEW.sku_id IS NOT NULL THEN
            UPDATE skus 
            SET 
                on_hand = on_hand + NEW.quantity,
                updated_at = NOW()
            WHERE id = NEW.sku_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_handle_movement_soft_delete
    BEFORE UPDATE ON movements
    FOR EACH ROW
    EXECUTE FUNCTION handle_movement_soft_delete();

-- 10) Create function to soft delete a movement
CREATE OR REPLACE FUNCTION soft_delete_movement(
    p_movement_id INTEGER,
    p_deletion_reason TEXT DEFAULT NULL,
    p_deleted_by TEXT DEFAULT 'system'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_movement movements%ROWTYPE;
    v_result JSONB;
BEGIN
    -- Get the movement
    SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Movement not found: %', p_movement_id;
    END IF;
    
    -- Check if already deleted
    IF v_movement.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Movement % is already deleted', p_movement_id;
    END IF;
    
    -- Soft delete the movement
    UPDATE movements 
    SET 
        deleted_at = NOW(),
        deleted_by = p_deleted_by,
        deletion_reason = p_deletion_reason,
        updated_at = NOW()
    WHERE id = p_movement_id;
    
    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'movement_id', p_movement_id,
        'movement_type', v_movement.type,
        'deleted_at', NOW(),
        'deleted_by', p_deleted_by,
        'deletion_reason', p_deletion_reason
    );
    
    RETURN v_result;
END;
$$;

-- 11) Create function to restore a soft deleted movement
CREATE OR REPLACE FUNCTION restore_movement(
    p_movement_id INTEGER,
    p_restored_by TEXT DEFAULT 'system'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_movement movements%ROWTYPE;
    v_result JSONB;
BEGIN
    -- Get the movement
    SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Movement not found: %', p_movement_id;
    END IF;
    
    -- Check if not deleted
    IF v_movement.deleted_at IS NULL THEN
        RAISE EXCEPTION 'Movement % is not deleted', p_movement_id;
    END IF;
    
    -- Restore the movement
    UPDATE movements 
    SET 
        deleted_at = NULL,
        deleted_by = NULL,
        deletion_reason = NULL,
        updated_at = NOW()
    WHERE id = p_movement_id;
    
    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'movement_id', p_movement_id,
        'movement_type', v_movement.type,
        'restored_at', NOW(),
        'restored_by', p_restored_by
    );
    
    RETURN v_result;
END;
$$;

-- 12) Create function to get movement status (active/deleted)
CREATE OR REPLACE FUNCTION get_movement_status(p_movement_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_movement movements%ROWTYPE;
    v_result JSONB;
BEGIN
    SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'Movement not found');
    END IF;
    
    v_result := jsonb_build_object(
        'movement_id', v_movement.id,
        'is_deleted', v_movement.deleted_at IS NOT NULL,
        'deleted_at', v_movement.deleted_at,
        'deleted_by', v_movement.deleted_by,
        'deletion_reason', v_movement.deletion_reason,
        'type', v_movement.type,
        'sku_id', v_movement.sku_id,
        'quantity', v_movement.quantity,
        'reference', v_movement.reference
    );
    
    RETURN v_result;
END;
$$;

-- 13) Add RLS policies for soft delete functionality
CREATE POLICY "Enable soft delete for authenticated users" ON movements
    FOR UPDATE USING (auth.role() = 'authenticated');

COMMENT ON TABLE movements IS 'All inventory movements with soft delete support (deleted_at IS NULL = active)';