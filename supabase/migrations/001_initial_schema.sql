-- pgasketsinv-final Database Schema
-- Initial migration for FIFO inventory management system
-- Created: 2025-08-17

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
-- TODO: Implement proper role-based access control

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
-- COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON TABLE skus IS 'Stock Keeping Units - master data for all inventory items';
COMMENT ON TABLE vendors IS 'Vendor/supplier master data with contact information';
COMMENT ON TABLE fifo_layers IS 'FIFO cost layers for inventory valuation';
COMMENT ON TABLE movements IS 'All inventory movements (RECEIVE, ISSUE, WASTE, PRODUCE)';
COMMENT ON TABLE work_orders IS 'Production work orders with multi-SKU consumption';
COMMENT ON TABLE layer_consumptions IS 'Tracks which FIFO layers were consumed in each movement';
COMMENT ON TABLE receiving_batches IS 'Groups related receiving movements by packing slip';

COMMENT ON VIEW inventory_summary IS 'Current inventory status with aggregated cost and stock levels';
COMMENT ON VIEW movement_history IS 'Formatted movement history for frontend consumption';
