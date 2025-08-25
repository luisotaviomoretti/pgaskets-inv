-- Migration: Fix FIFO Layers Updated At Column
-- This migration fixes the column name reference in the cascade functions
-- Created: 2025-08-20

-- 1) Fix the recalculate_single_fifo_layer function to use correct column name
CREATE OR REPLACE FUNCTION recalculate_single_fifo_layer(p_layer_id text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_original_quantity numeric;
  v_total_consumed numeric;
  v_new_remaining numeric;
  v_new_status layer_status;
BEGIN
  -- Get original quantity
  SELECT original_quantity INTO v_original_quantity
  FROM fifo_layers 
  WHERE id = p_layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FIFO layer not found: %', p_layer_id;
  END IF;
  
  -- Calculate total consumed from ACTIVE consumptions only
  SELECT COALESCE(SUM(quantity_consumed), 0) INTO v_total_consumed
  FROM layer_consumptions 
  WHERE layer_id = p_layer_id AND deleted_at IS NULL;
  
  -- Calculate new remaining quantity
  v_new_remaining := v_original_quantity - v_total_consumed;
  
  -- Ensure remaining is not negative
  v_new_remaining := GREATEST(v_new_remaining, 0);
  
  -- Determine new status
  IF v_new_remaining = 0 THEN
    v_new_status := 'EXHAUSTED';
  ELSIF v_new_remaining > 0 THEN
    v_new_status := 'ACTIVE';
  END IF;
  
  -- Update the layer (using last_movement_at instead of updated_at)
  UPDATE fifo_layers 
  SET 
    remaining_quantity = v_new_remaining,
    status = v_new_status,
    last_movement_at = NOW()
  WHERE id = p_layer_id;
  
  RETURN v_new_remaining;
END;
$$;

-- 2) Add updated_at column to fifo_layers for future consistency (optional)
ALTER TABLE fifo_layers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3) Create trigger to auto-update the updated_at column when fifo_layers changes
CREATE OR REPLACE FUNCTION update_fifo_layers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_fifo_layers_updated_at
  BEFORE UPDATE ON fifo_layers
  FOR EACH ROW
  EXECUTE FUNCTION update_fifo_layers_updated_at();

-- 4) Update the recalculate function to use updated_at now that it exists
CREATE OR REPLACE FUNCTION recalculate_single_fifo_layer(p_layer_id text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_original_quantity numeric;
  v_total_consumed numeric;
  v_new_remaining numeric;
  v_new_status layer_status;
BEGIN
  -- Get original quantity
  SELECT original_quantity INTO v_original_quantity
  FROM fifo_layers 
  WHERE id = p_layer_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FIFO layer not found: %', p_layer_id;
  END IF;
  
  -- Calculate total consumed from ACTIVE consumptions only
  SELECT COALESCE(SUM(quantity_consumed), 0) INTO v_total_consumed
  FROM layer_consumptions 
  WHERE layer_id = p_layer_id AND deleted_at IS NULL;
  
  -- Calculate new remaining quantity
  v_new_remaining := v_original_quantity - v_total_consumed;
  
  -- Ensure remaining is not negative
  v_new_remaining := GREATEST(v_new_remaining, 0);
  
  -- Determine new status
  IF v_new_remaining = 0 THEN
    v_new_status := 'EXHAUSTED';
  ELSIF v_new_remaining > 0 THEN
    v_new_status := 'ACTIVE';
  END IF;
  
  -- Update the layer (now using updated_at)
  UPDATE fifo_layers 
  SET 
    remaining_quantity = v_new_remaining,
    status = v_new_status,
    last_movement_at = NOW(),
    updated_at = NOW()
  WHERE id = p_layer_id;
  
  RETURN v_new_remaining;
END;
$$;

-- 5) Initialize updated_at for existing records
UPDATE fifo_layers SET updated_at = COALESCE(last_movement_at, created_at, NOW()) WHERE updated_at IS NULL;

-- 6) Add comment
COMMENT ON COLUMN fifo_layers.updated_at IS 'Timestamp when the layer record was last updated';