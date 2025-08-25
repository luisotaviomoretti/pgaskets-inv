-- Migration: Update Stored Procedures for Soft Delete
-- This migration updates all stored procedures to respect soft delete
-- Created: 2025-08-20

-- 1) Update get_production_group_deletion_info to filter active movements
CREATE OR REPLACE FUNCTION get_production_group_deletion_info(
  p_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_produce boolean;
  v_is_any_reversed boolean;
  v_movements jsonb := '[]';
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM movements m 
    WHERE m.reference = p_reference 
      AND m.type = 'PRODUCE'
      AND m.deleted_at IS NULL  -- Only active movements
  ) INTO v_has_produce;

  SELECT EXISTS(
    SELECT 1 FROM movements m 
    WHERE m.reference = p_reference 
      AND m.reversed_at IS NOT NULL
      AND m.deleted_at IS NULL  -- Only active movements
  ) INTO v_is_any_reversed;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', m.id,
      'type', m.type,
      'sku_id', m.sku_id,
      'quantity', m.quantity,
      'total_value', m.total_value,
      'datetime', m.datetime,
      'reversed_at', m.reversed_at,
      'deleted_at', m.deleted_at
    ) ORDER BY m.datetime DESC
  ), '[]'::jsonb)
  INTO v_movements
  FROM movements m
  WHERE m.reference = p_reference
    AND m.deleted_at IS NULL;  -- Only active movements

  RETURN jsonb_build_object(
    'reference', p_reference,
    'has_produce', v_has_produce,
    'any_reversed', v_is_any_reversed,
    'can_delete', v_has_produce AND NOT v_is_any_reversed,
    'movements', v_movements
  );
END;
$$;

-- 2) Update get_movement_deletion_info to include soft delete status
CREATE OR REPLACE FUNCTION get_movement_deletion_info(
  p_movement_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement movements%ROWTYPE;
  v_consumptions jsonb := '[]';
  v_consumption_info jsonb;
  v_result jsonb;
BEGIN
  -- Get movement
  SELECT * INTO v_movement FROM movements WHERE id = p_movement_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Movement not found');
  END IF;
  
  -- Get consumption details if any (only for active movements)
  IF v_movement.deleted_at IS NULL THEN
    SELECT jsonb_agg(
      jsonb_build_object(
        'layer_id', lc.layer_id,
        'quantity_consumed', lc.quantity_consumed,
        'unit_cost', lc.unit_cost,
        'total_cost', lc.total_cost,
        'layer_remaining', fl.remaining_quantity,
        'layer_original', fl.original_quantity
      )
    ) INTO v_consumptions
    FROM layer_consumptions lc
    JOIN fifo_layers fl ON fl.id = lc.layer_id
    WHERE lc.movement_id = p_movement_id;
  END IF;
  
  -- Build result
  v_result := jsonb_build_object(
    'movement_id', v_movement.id,
    'type', v_movement.type,
    'sku_id', v_movement.sku_id,
    'quantity', v_movement.quantity,
    'unit_cost', v_movement.unit_cost,
    'total_value', v_movement.total_value,
    'reference', v_movement.reference,
    'datetime', v_movement.datetime,
    'is_deleted', v_movement.deleted_at IS NOT NULL,
    'deleted_at', v_movement.deleted_at,
    'deleted_by', v_movement.deleted_by,
    'deletion_reason', v_movement.deletion_reason,
    'can_delete', v_movement.type IN ('RECEIVE', 'PRODUCE') 
                  AND v_movement.reversed_at IS NULL 
                  AND v_movement.deleted_at IS NULL,
    'is_reversed', v_movement.reversed_at IS NOT NULL,
    'consumptions', COALESCE(v_consumptions, '[]'::jsonb)
  );
  
  RETURN v_result;
END;
$$;

-- 3) Create function to get movements with soft delete filtering
CREATE OR REPLACE FUNCTION get_movements_filtered(
  p_sku_id TEXT DEFAULT NULL,
  p_type TEXT DEFAULT NULL,
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL,
  p_include_deleted BOOLEAN DEFAULT FALSE,
  p_limit INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id INTEGER,
  datetime TIMESTAMPTZ,
  type movement_type,
  sku_id TEXT,
  product_name TEXT,
  quantity DECIMAL(10,3),
  unit_cost DECIMAL(10,4),
  total_value DECIMAL(12,4),
  reference TEXT,
  work_order_id TEXT,
  notes TEXT,
  sku_description TEXT,
  sku_unit TEXT,
  vendor_name TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  deletion_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id,
    m.datetime,
    m.type,
    m.sku_id,
    m.product_name,
    m.quantity,
    m.unit_cost,
    m.total_value,
    m.reference,
    m.work_order_id,
    m.notes,
    s.description as sku_description,
    s.unit as sku_unit,
    v.name as vendor_name,
    m.deleted_at,
    m.deleted_by,
    m.deletion_reason
  FROM movements m
  LEFT JOIN skus s ON m.sku_id = s.id
  LEFT JOIN vendors v ON m.vendor_id = v.id
  WHERE 
    (p_sku_id IS NULL OR m.sku_id = p_sku_id)
    AND (p_type IS NULL OR m.type::text = p_type)
    AND (p_date_from IS NULL OR m.datetime >= p_date_from)
    AND (p_date_to IS NULL OR m.datetime <= p_date_to)
    AND (p_include_deleted OR m.deleted_at IS NULL)  -- Filter deleted unless requested
  ORDER BY m.datetime DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- 4) Create function to get movement statistics (respecting soft delete)
CREATE OR REPLACE FUNCTION get_movement_statistics(
  p_date_from TIMESTAMPTZ DEFAULT NULL,
  p_date_to TIMESTAMPTZ DEFAULT NULL,
  p_include_deleted BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_stats JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_movements', COUNT(*),
    'movements_by_type', jsonb_object_agg(type, type_count),
    'total_value_by_type', jsonb_object_agg(type, total_value),
    'active_movements', COUNT(*) FILTER (WHERE deleted_at IS NULL),
    'deleted_movements', COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
    'date_range', jsonb_build_object(
      'from', COALESCE(p_date_from, MIN(datetime)),
      'to', COALESCE(p_date_to, MAX(datetime))
    )
  ) INTO v_stats
  FROM (
    SELECT 
      type,
      datetime,
      deleted_at,
      COUNT(*) OVER (PARTITION BY type) as type_count,
      SUM(total_value) OVER (PARTITION BY type) as total_value
    FROM movements
    WHERE 
      (p_date_from IS NULL OR datetime >= p_date_from)
      AND (p_date_to IS NULL OR datetime <= p_date_to)
      AND (p_include_deleted OR deleted_at IS NULL)
  ) stats;
  
  RETURN COALESCE(v_stats, '{}'::jsonb);
END;
$$;

-- 5) Update delete_production_group to use soft delete
CREATE OR REPLACE FUNCTION soft_delete_production_group(
  p_reference text,
  p_deletion_reason text DEFAULT NULL,
  p_deleted_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_info jsonb;
  v_mov record;
  v_deleted_count int := 0;
  v_results jsonb := '[]';
  v_delete_result jsonb;
BEGIN
  -- Validate group (only active movements)
  SELECT get_production_group_deletion_info(p_reference) INTO v_info;
  IF NOT (v_info->>'can_delete')::boolean THEN
    RAISE EXCEPTION 'Production group with reference % cannot be deleted. Info: %', p_reference, v_info;
  END IF;

  -- Soft delete all movements in the production group
  FOR v_mov IN
    SELECT * FROM movements 
    WHERE reference = p_reference 
      AND deleted_at IS NULL  -- Only active movements
    ORDER BY CASE WHEN type = 'PRODUCE' THEN 1 ELSE 0 END, datetime DESC
  LOOP
    -- Soft delete the movement
    SELECT soft_delete_movement(v_mov.id, p_deletion_reason, p_deleted_by) INTO v_delete_result;
    
    v_results := v_results || v_delete_result;
    v_deleted_count := v_deleted_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'reference', p_reference,
    'deleted_count', v_deleted_count,
    'deleted_movements', v_results
  );
END;
$$;

-- 6) Create function to bulk restore movements by reference
CREATE OR REPLACE FUNCTION restore_production_group(
  p_reference text,
  p_restored_by text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_mov record;
  v_restored_count int := 0;
  v_results jsonb := '[]';
  v_restore_result jsonb;
BEGIN
  -- Restore all deleted movements in the production group
  FOR v_mov IN
    SELECT * FROM movements 
    WHERE reference = p_reference 
      AND deleted_at IS NOT NULL  -- Only deleted movements
    ORDER BY datetime ASC  -- Restore in chronological order
  LOOP
    -- Restore the movement
    SELECT restore_movement(v_mov.id, p_restored_by) INTO v_restore_result;
    
    v_results := v_results || v_restore_result;
    v_restored_count := v_restored_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'reference', p_reference,
    'restored_count', v_restored_count,
    'restored_movements', v_results
  );
END;
$$;

-- 7) Grant permissions on new functions
GRANT EXECUTE ON FUNCTION get_movements_filtered TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_movement_statistics TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION soft_delete_production_group TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION restore_production_group TO authenticated, service_role;

-- 8) Add helpful indexes for soft delete queries
CREATE INDEX IF NOT EXISTS idx_movements_reference_active 
ON movements(reference) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_movements_type_active 
ON movements(type) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_movements_sku_active 
ON movements(sku_id) WHERE deleted_at IS NULL;

-- 9) Create materialized view for movement analytics (optional)
CREATE MATERIALIZED VIEW IF NOT EXISTS movement_analytics AS
SELECT 
  DATE_TRUNC('day', datetime) as movement_date,
  type,
  COUNT(*) as movement_count,
  SUM(quantity) as total_quantity,
  SUM(total_value) as total_value,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted_count
FROM movements
WHERE deleted_at IS NULL  -- Only active movements
GROUP BY DATE_TRUNC('day', datetime), type
ORDER BY movement_date DESC, type;

CREATE INDEX IF NOT EXISTS idx_movement_analytics_date_type 
ON movement_analytics(movement_date, type);

GRANT SELECT ON movement_analytics TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW movement_analytics IS 'Daily movement statistics (refreshed periodically)';