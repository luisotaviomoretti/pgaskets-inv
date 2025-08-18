-- pgasketsinv-final Complete Database Setup
-- Execute this entire script in Supabase SQL Editor
-- Created: 2025-08-17

-- =====================================================
-- PART 1: INITIAL SCHEMA (001_initial_schema.sql)
-- =====================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create custom types
CREATE TYPE material_type AS ENUM ('RAW', 'SELLABLE');
CREATE TYPE movement_type AS ENUM ('RECEIVE', 'ISSUE', 'WASTE', 'PRODUCE', 'ADJUSTMENT', 'TRANSFER');
CREATE TYPE damage_scope AS ENUM ('NONE', 'PARTIAL', 'FULL');
CREATE TYPE layer_status AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'QUARANTINE');
CREATE TYPE work_order_mode AS ENUM ('AUTO', 'MANUAL');

-- =====================================================
-- CORE TABLES
-- =====================================================

-- SKUs (Stock Keeping Units)
CREATE TABLE skus (
    id TEXT PRIMARY KEY CHECK (id ~ '^[A-Z0-9-]+$'),
    description TEXT NOT NULL,
    type material_type NOT NULL,
    product_category TEXT NOT NULL,
    unit TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    min_stock DECIMAL(10,3) DEFAULT 0,
    max_stock DECIMAL(10,3),
    on_hand DECIMAL(10,3) DEFAULT 0,
    reserved DECIMAL(10,3) DEFAULT 0,
    average_cost DECIMAL(10,4),
    last_cost DECIMAL(10,4),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'system',
    updated_by TEXT DEFAULT 'system',
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT positive_stock CHECK (on_hand >= 0),
    CONSTRAINT positive_reserved CHECK (reserved >= 0),
    CONSTRAINT valid_min_max CHECK (max_stock IS NULL OR max_stock >= min_stock)
);

-- Vendors
CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    legal_name TEXT,
    tax_id TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    country TEXT DEFAULT 'USA',
    email TEXT,
    phone TEXT,
    bank_info JSONB DEFAULT '{}'::jsonb,
    payment_terms JSONB DEFAULT '{}'::jsonb,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- FIFO Layers (inventory cost layers)
CREATE TABLE fifo_layers (
    id TEXT PRIMARY KEY,
    sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
    receiving_date DATE NOT NULL,
    expiry_date DATE,
    original_quantity DECIMAL(10,3) NOT NULL CHECK (original_quantity > 0),
    remaining_quantity DECIMAL(10,3) NOT NULL CHECK (remaining_quantity >= 0),
    unit_cost DECIMAL(10,4) NOT NULL CHECK (unit_cost > 0),
    vendor_id TEXT REFERENCES vendors(id),
    packing_slip_no TEXT,
    lot_number TEXT,
    location TEXT,
    status layer_status DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_movement_at TIMESTAMPTZ,
    
    CONSTRAINT remaining_le_original CHECK (remaining_quantity <= original_quantity)
);

-- Movements (all inventory transactions)
CREATE TABLE movements (
    id SERIAL PRIMARY KEY,
    datetime TIMESTAMPTZ NOT NULL,
    type movement_type NOT NULL,
    sku_id TEXT REFERENCES skus(id),
    product_name TEXT, -- For PRODUCE movements
    quantity DECIMAL(10,3) NOT NULL,
    unit_cost DECIMAL(10,4),
    total_value DECIMAL(12,4) NOT NULL,
    reference TEXT NOT NULL,
    work_order_id TEXT,
    notes TEXT,
    user_id TEXT DEFAULT 'system',
    reversed_at TIMESTAMPTZ,
    reversed_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT sku_or_product CHECK (
        (sku_id IS NOT NULL AND product_name IS NULL) OR 
        (sku_id IS NULL AND product_name IS NOT NULL)
    )
);

-- Work Orders
CREATE TABLE work_orders (
    id TEXT PRIMARY KEY,
    output_name TEXT NOT NULL,
    output_quantity DECIMAL(10,3) NOT NULL CHECK (output_quantity > 0),
    output_unit TEXT,
    mode work_order_mode NOT NULL,
    client_name TEXT,
    invoice_no TEXT,
    status TEXT DEFAULT 'COMPLETED',
    total_cost DECIMAL(12,4),
    labor_hours DECIMAL(8,2),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_by TEXT DEFAULT 'system'
);

-- Layer Consumptions (tracks which layers were consumed in movements)
CREATE TABLE layer_consumptions (
    id SERIAL PRIMARY KEY,
    movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    layer_id TEXT NOT NULL REFERENCES fifo_layers(id) ON DELETE CASCADE,
    quantity_consumed DECIMAL(10,3) NOT NULL CHECK (quantity_consumed > 0),
    unit_cost DECIMAL(10,4) NOT NULL CHECK (unit_cost > 0),
    total_cost DECIMAL(12,4) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT consistent_total CHECK (total_cost = quantity_consumed * unit_cost)
);

-- Receiving Batches (groups related receiving movements)
CREATE TABLE receiving_batches (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL REFERENCES vendors(id),
    packing_slip_no TEXT NOT NULL,
    receiving_date DATE NOT NULL,
    is_damaged BOOLEAN DEFAULT false,
    damage_scope damage_scope DEFAULT 'NONE',
    damage_description TEXT,
    notes TEXT,
    total_value DECIMAL(12,4),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'system'
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- SKU indexes
CREATE INDEX idx_skus_type ON skus(type);
CREATE INDEX idx_skus_active ON skus(active);
CREATE INDEX idx_skus_category ON skus(product_category);

-- Vendor indexes for autocomplete
CREATE INDEX idx_vendors_name_trgm ON vendors USING gin(name gin_trgm_ops);
CREATE INDEX idx_vendors_active ON vendors(active);

-- FIFO layer indexes (critical for performance)
CREATE INDEX idx_fifo_layers_sku_date ON fifo_layers(sku_id, receiving_date);
CREATE INDEX idx_fifo_layers_status ON fifo_layers(status);
CREATE INDEX idx_fifo_layers_remaining ON fifo_layers(remaining_quantity) WHERE remaining_quantity > 0;

-- Movement indexes for filtering and reporting
CREATE INDEX idx_movements_type_datetime ON movements(type, datetime DESC);
CREATE INDEX idx_movements_sku_datetime ON movements(sku_id, datetime DESC);
CREATE INDEX idx_movements_reference ON movements(reference);
CREATE INDEX idx_movements_work_order ON movements(work_order_id);
CREATE INDEX idx_movements_datetime ON movements(datetime DESC);

-- Layer consumption indexes
CREATE INDEX idx_layer_consumptions_movement ON layer_consumptions(movement_id);
CREATE INDEX idx_layer_consumptions_layer ON layer_consumptions(layer_id);

-- Work order indexes
CREATE INDEX idx_work_orders_created ON work_orders(created_at DESC);

-- =====================================================
-- VIEWS FOR AGGREGATIONS
-- =====================================================

-- Current inventory summary with status
CREATE VIEW inventory_summary AS
SELECT 
    s.id,
    s.description,
    s.type,
    s.product_category,
    s.unit,
    s.on_hand,
    s.reserved,
    s.min_stock,
    s.max_stock,
    s.active,
    CASE 
        WHEN s.on_hand <= s.min_stock THEN 'BELOW_MIN'
        WHEN s.max_stock IS NOT NULL AND s.on_hand >= s.max_stock THEN 'OVERSTOCK'
        ELSE 'OK'
    END as status,
    COALESCE(
        SUM(fl.remaining_quantity * fl.unit_cost) / NULLIF(SUM(fl.remaining_quantity), 0), 
        s.average_cost,
        0
    ) as current_avg_cost,
    COUNT(fl.id) FILTER (WHERE fl.status = 'ACTIVE') as active_layers,
    SUM(fl.remaining_quantity) FILTER (WHERE fl.status = 'ACTIVE') as total_in_layers
FROM skus s
LEFT JOIN fifo_layers fl ON s.id = fl.sku_id AND fl.status = 'ACTIVE'
GROUP BY s.id, s.description, s.type, s.product_category, s.unit, 
         s.on_hand, s.reserved, s.min_stock, s.max_stock, s.active, s.average_cost;

-- Movement history view (for frontend consumption)
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
    s.description as sku_description
FROM movements m
LEFT JOIN skus s ON m.sku_id = s.id
ORDER BY m.datetime DESC;

-- =====================================================
-- TRIGGERS FOR AUTOMATION
-- =====================================================

-- Update SKU on_hand when movements are inserted
CREATE OR REPLACE FUNCTION update_sku_on_hand()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.sku_id IS NOT NULL THEN
        UPDATE skus 
        SET 
            on_hand = on_hand + NEW.quantity,
            updated_at = NOW()
        WHERE id = NEW.sku_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_sku_on_hand
    AFTER INSERT ON movements
    FOR EACH ROW
    EXECUTE FUNCTION update_sku_on_hand();

-- Update layer status when remaining_quantity reaches 0
CREATE OR REPLACE FUNCTION update_layer_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.remaining_quantity = 0 AND OLD.remaining_quantity > 0 THEN
        NEW.status = 'EXHAUSTED';
        NEW.last_movement_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_layer_status
    BEFORE UPDATE ON fifo_layers
    FOR EACH ROW
    EXECUTE FUNCTION update_layer_status();

-- Update timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_skus_updated_at
    BEFORE UPDATE ON skus
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_vendors_updated_at
    BEFORE UPDATE ON vendors
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE fifo_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE layer_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_batches ENABLE ROW LEVEL SECURITY;

-- Basic policies (allow all for authenticated users for now)
CREATE POLICY "Enable all for authenticated users" ON skus
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON vendors
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON fifo_layers
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON movements
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON work_orders
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON layer_consumptions
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Enable all for authenticated users" ON receiving_batches
    FOR ALL USING (auth.role() = 'authenticated');

-- =====================================================
-- PART 2: SEED DATA (002_seed_data.sql)
-- =====================================================

-- VENDORS
INSERT INTO vendors (id, name, address, city, state, zip_code, email, phone, active) VALUES
('VND-001', 'Acme Supplies Co.', '123 Industrial Rd', 'Dallas', 'TX', '75201', 'orders@acmesupplies.com', '+1-214-555-0100', true),
('VND-002', 'Industrial Materials Inc.', '90-1200 1st Ave', 'Seattle', 'WA', '98101', 'sales@indmaterials.com', '+1-206-555-0200', true),
('VND-003', 'Gasket & Seals Partners', '55 Supply Way', 'Phoenix', 'AZ', '85001', 'info@gasketseals.com', '+1-602-555-0300', true),
('VND-004', 'Premium Cork Solutions', '789 Cork Street', 'Portland', 'OR', '97201', 'orders@premiumcork.com', '+1-503-555-0400', true),
('VND-005', 'Adhesive Technologies Ltd', '456 Bond Ave', 'Chicago', 'IL', '60601', 'sales@adhesivetech.com', '+1-312-555-0500', true);

-- SKUs
INSERT INTO skus (id, description, type, product_category, unit, min_stock, max_stock, on_hand, average_cost, last_cost, active) VALUES
-- RAW Materials
('SKU-001', 'GAX-12 Cork Rubber Sheet', 'RAW', 'Cork/Rubber', 'sheet', 100, 500, 180, 5.30, 5.40, true),
('SKU-002', 'GAX-16 Cork Rubber Sheet', 'RAW', 'Cork/Rubber', 'sheet', 150, 600, 250, 5.45, 5.50, true),
('SKU-003', 'ADH-100 Industrial Adhesive', 'RAW', 'Adhesives', 'gallon', 50, 200, 75, 24.50, 25.00, true),
('SKU-004', 'FELT-200 Fiber Felt Roll', 'RAW', 'Felt', 'roll', 80, 300, 120, 18.75, 19.00, true),
('SKU-005', 'FOAM-300 Polyurethane Foam', 'RAW', 'Fibre Foam', 'sheet', 200, 800, 350, 12.25, 12.50, true),
('SKU-006', 'FILM-400 Protective Film', 'RAW', 'Film and Foil', 'roll', 60, 240, 90, 8.90, 9.10, true),

-- SELLABLE Products
('P-001', 'Custom Gasket P-001', 'SELLABLE', 'Fibre Foam', 'unit', 50, 200, 85, 45.75, 46.00, true),
('P-002', 'Industrial Seal P-002', 'SELLABLE', 'Cork/Rubber', 'unit', 75, 300, 120, 32.50, 33.00, true),
('P-003', 'Heavy Duty Gasket P-003', 'SELLABLE', 'Polyurethane Ether', 'unit', 40, 160, 65, 78.25, 79.00, true),
('P-004', 'Precision Seal P-004', 'SELLABLE', 'Felt', 'unit', 30, 120, 45, 56.80, 57.50, true),
('P-005', 'Multi-Layer Gasket P-005', 'SELLABLE', 'Film and Foil', 'unit', 25, 100, 35, 89.90, 91.00, true);

-- FIFO LAYERS
-- SKU-001 layers (GAX-12 Cork Rubber)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-001-L1', 'SKU-001', '2025-07-01', 100, 80, 5.20, 'VND-004', 'PS-2025-001', 'ACTIVE'),
('SKU-001-L2', 'SKU-001', '2025-07-15', 80, 80, 5.40, 'VND-004', 'PS-2025-015', 'ACTIVE'),
('SKU-001-L3', 'SKU-001', '2025-08-01', 50, 20, 5.50, 'VND-004', 'PS-2025-032', 'ACTIVE');

-- SKU-002 layers (GAX-16 Cork Rubber)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-002-L1', 'SKU-002', '2025-07-10', 150, 100, 5.30, 'VND-004', 'PS-2025-008', 'ACTIVE'),
('SKU-002-L2', 'SKU-002', '2025-08-05', 100, 100, 5.50, 'VND-004', 'PS-2025-038', 'ACTIVE'),
('SKU-002-L3', 'SKU-002', '2025-08-12', 75, 50, 5.60, 'VND-004', 'PS-2025-045', 'ACTIVE');

-- SKU-003 layers (ADH-100 Adhesive)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-003-L1', 'SKU-003', '2025-07-20', 50, 25, 24.00, 'VND-005', 'PS-2025-020', 'ACTIVE'),
('SKU-003-L2', 'SKU-003', '2025-08-08', 40, 40, 25.00, 'VND-005', 'PS-2025-041', 'ACTIVE'),
('SKU-003-L3', 'SKU-003', '2025-08-14', 20, 10, 25.50, 'VND-005', 'PS-2025-047', 'ACTIVE');

-- SKU-004 layers (FELT-200 Fiber Felt)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-004-L1', 'SKU-004', '2025-07-05', 80, 60, 18.50, 'VND-002', 'PS-2025-005', 'ACTIVE'),
('SKU-004-L2', 'SKU-004', '2025-08-02', 60, 60, 19.00, 'VND-002', 'PS-2025-034', 'ACTIVE');

-- SKU-005 layers (FOAM-300 Polyurethane)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-005-L1', 'SKU-005', '2025-07-12', 200, 150, 12.00, 'VND-001', 'PS-2025-012', 'ACTIVE'),
('SKU-005-L2', 'SKU-005', '2025-08-06', 200, 200, 12.50, 'VND-001', 'PS-2025-039', 'ACTIVE');

-- SKU-006 layers (FILM-400 Protective Film)
INSERT INTO fifo_layers (id, sku_id, receiving_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, status) VALUES
('SKU-006-L1', 'SKU-006', '2025-07-25', 60, 40, 8.80, 'VND-003', 'PS-2025-025', 'ACTIVE'),
('SKU-006-L2', 'SKU-006', '2025-08-10', 50, 50, 9.10, 'VND-003', 'PS-2025-043', 'ACTIVE');

-- SAMPLE MOVEMENTS (Historical)
-- Sample receiving movements
INSERT INTO movements (datetime, type, sku_id, quantity, unit_cost, total_value, reference, notes) VALUES
('2025-07-01 09:00:00', 'RECEIVE', 'SKU-001', 100, 5.20, 520.00, 'PS-2025-001', 'Initial stock receipt'),
('2025-07-10 10:30:00', 'RECEIVE', 'SKU-002', 150, 5.30, 795.00, 'PS-2025-008', 'Bulk order from Premium Cork'),
('2025-07-15 14:15:00', 'RECEIVE', 'SKU-001', 80, 5.40, 432.00, 'PS-2025-015', 'Restock order'),
('2025-07-20 11:45:00', 'RECEIVE', 'SKU-003', 50, 24.00, 1200.00, 'PS-2025-020', 'Adhesive supply');

-- Sample production movements
INSERT INTO movements (datetime, type, product_name, quantity, total_value, reference, work_order_id, notes) VALUES
('2025-08-10 16:30:00', 'PRODUCE', 'Custom Gasket Batch A', 25, 1147.50, 'WO-20250810-A001', 'WO-20250810-A001', 'Production run for ACME Corp'),
('2025-08-12 09:15:00', 'PRODUCE', 'Industrial Seal Set B', 15, 487.50, 'WO-20250812-B001', 'WO-20250812-B001', 'Rush order completion');

-- Sample issue movements (raw material consumption)
INSERT INTO movements (datetime, type, sku_id, quantity, unit_cost, total_value, reference, work_order_id) VALUES
('2025-08-10 16:00:00', 'ISSUE', 'SKU-001', -20, 5.20, -104.00, 'WO-20250810-A001', 'WO-20250810-A001'),
('2025-08-10 16:05:00', 'ISSUE', 'SKU-003', -5, 24.00, -120.00, 'WO-20250810-A001', 'WO-20250810-A001'),
('2025-08-12 09:00:00', 'ISSUE', 'SKU-002', -15, 5.30, -79.50, 'WO-20250812-B001', 'WO-20250812-B001');

-- Sample waste movements
INSERT INTO movements (datetime, type, sku_id, quantity, unit_cost, total_value, reference, work_order_id, notes) VALUES
('2025-08-10 16:25:00', 'WASTE', 'SKU-001', -2, 5.20, -10.40, 'WO-20250810-A001', 'WO-20250810-A001', 'Material defect during cutting'),
('2025-08-12 09:10:00', 'WASTE', 'SKU-002', -1, 5.30, -5.30, 'WO-20250812-B001', 'WO-20250812-B001', 'Edge trimming waste');

-- SAMPLE WORK ORDERS
INSERT INTO work_orders (id, output_name, output_quantity, output_unit, mode, client_name, total_cost, labor_hours, created_at, completed_at) VALUES
('WO-20250810-A001', 'Custom Gasket Batch A', 25, 'unit', 'AUTO', 'ACME Corporation', 1147.50, 4.5, '2025-08-10 15:00:00', '2025-08-10 17:00:00'),
('WO-20250812-B001', 'Industrial Seal Set B', 15, 'unit', 'MANUAL', 'Industrial Partners LLC', 487.50, 2.0, '2025-08-12 08:00:00', '2025-08-12 10:00:00');

-- SAMPLE LAYER CONSUMPTIONS
-- Link movements to layer consumptions (for FIFO tracking)
INSERT INTO layer_consumptions (movement_id, layer_id, quantity_consumed, unit_cost, total_cost)
VALUES
-- WO-20250810-A001 SKU-001 consumption (use the ISSUE movement only)
((SELECT id FROM movements 
  WHERE reference = 'WO-20250810-A001' AND sku_id = 'SKU-001' AND type = 'ISSUE'
  ORDER BY datetime ASC
  LIMIT 1
), 'SKU-001-L1', 20, 5.20, 104.00),
-- WO-20250810-A001 SKU-003 consumption (use the ISSUE movement only)
((SELECT id FROM movements 
  WHERE reference = 'WO-20250810-A001' AND sku_id = 'SKU-003' AND type = 'ISSUE'
  ORDER BY datetime ASC
  LIMIT 1
), 'SKU-003-L1', 5, 24.00, 120.00),
-- WO-20250812-B001 SKU-002 consumption (use the ISSUE movement only)
((SELECT id FROM movements 
  WHERE reference = 'WO-20250812-B001' AND sku_id = 'SKU-002' AND type = 'ISSUE'
  ORDER BY datetime ASC
  LIMIT 1
), 'SKU-002-L1', 15, 5.30, 79.50);

-- SAMPLE RECEIVING BATCHES
INSERT INTO receiving_batches (id, vendor_id, packing_slip_no, receiving_date, is_damaged, damage_scope, total_value) VALUES
('RB-2025-001', 'VND-004', 'PS-2025-001', '2025-07-01', false, 'NONE', 520.00),
('RB-2025-008', 'VND-004', 'PS-2025-008', '2025-07-10', false, 'NONE', 795.00),
('RB-2025-015', 'VND-004', 'PS-2025-015', '2025-07-15', false, 'NONE', 432.00),
('RB-2025-020', 'VND-005', 'PS-2025-020', '2025-07-20', false, 'NONE', 1200.00);

-- UPDATE COMPUTED FIELDS
-- Update SKU on_hand to match layer totals (trigger will handle future updates)
UPDATE skus SET on_hand = (
    SELECT COALESCE(SUM(remaining_quantity), 0)
    FROM fifo_layers 
    WHERE sku_id = skus.id AND status = 'ACTIVE'
);

-- =====================================================
-- PART 3: TRANSACTION FUNCTIONS (003_transaction_functions.sql)
-- =====================================================

-- Begin transaction function
CREATE OR REPLACE FUNCTION begin_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Commit transaction function
CREATE OR REPLACE FUNCTION commit_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Rollback transaction function
CREATE OR REPLACE FUNCTION rollback_transaction()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is a placeholder since Supabase handles transactions automatically
  -- We'll use this for consistency in our service layer
  RETURN;
END;
$$;

-- Function to get inventory summary with calculated fields
CREATE OR REPLACE FUNCTION get_inventory_summary()
RETURNS TABLE (
  id text,
  description text,
  type text,
  product_category text,
  unit text,
  active boolean,
  min_stock numeric,
  on_hand numeric,
  reserved numeric,
  max_stock numeric,
  status text,
  current_avg_cost numeric,
  active_layers bigint,
  total_in_layers numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM inventory_summary;
END;
$$;

-- =====================================================
-- SETUP COMPLETE
-- =====================================================

-- Verify setup with basic queries
SELECT 'Setup completed successfully!' as message;
SELECT COUNT(*) as vendor_count FROM vendors;
SELECT COUNT(*) as sku_count FROM skus;
SELECT COUNT(*) as layer_count FROM fifo_layers;
SELECT COUNT(*) as movement_count FROM movements;
