-- Add DAMAGE type to movement_type enum
-- This migration adds support for DAMAGE movements alongside existing WASTE movements
-- DAMAGE: Items received but damaged/rejected (different from WASTE of existing inventory)
-- Created: 2025-08-29

BEGIN;

-- Add DAMAGE to the movement_type enum
ALTER TYPE movement_type ADD VALUE 'DAMAGE';

COMMIT;

-- Verification query (run manually to verify)
-- SELECT unnest(enum_range(NULL::movement_type)) AS movement_types;