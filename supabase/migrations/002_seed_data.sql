-- Seed data for pgasketsinv-final
-- Initial test data for development and testing
-- Created: 2025-08-17

-- =====================================================
-- VENDORS
-- =====================================================

INSERT INTO vendors (id, name, address, city, state, zip_code, email, phone, active) VALUES
('VND-001', 'Acme Supplies Co.', '123 Industrial Rd', 'Dallas', 'TX', '75201', 'orders@acmesupplies.com', '+1-214-555-0100', true),
('VND-002', 'Industrial Materials Inc.', '90-1200 1st Ave', 'Seattle', 'WA', '98101', 'sales@indmaterials.com', '+1-206-555-0200', true),
('VND-003', 'Gasket & Seals Partners', '55 Supply Way', 'Phoenix', 'AZ', '85001', 'info@gasketseals.com', '+1-602-555-0300', true),
('VND-004', 'Premium Cork Solutions', '789 Cork Street', 'Portland', 'OR', '97201', 'orders@premiumcork.com', '+1-503-555-0400', true),
('VND-005', 'Adhesive Technologies Ltd', '456 Bond Ave', 'Chicago', 'IL', '60601', 'sales@adhesivetech.com', '+1-312-555-0500', true);

-- =====================================================
-- SKUs
-- =====================================================

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

-- =====================================================
-- FIFO LAYERS
-- =====================================================

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

-- =====================================================
-- SAMPLE MOVEMENTS (Historical)
-- =====================================================

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

-- =====================================================
-- SAMPLE WORK ORDERS
-- =====================================================

INSERT INTO work_orders (id, output_name, output_quantity, output_unit, mode, client_name, total_cost, labor_hours, created_at, completed_at) VALUES
('WO-20250810-A001', 'Custom Gasket Batch A', 25, 'unit', 'AUTO', 'ACME Corporation', 1147.50, 4.5, '2025-08-10 15:00:00', '2025-08-10 17:00:00'),
('WO-20250812-B001', 'Industrial Seal Set B', 15, 'unit', 'MANUAL', 'Industrial Partners LLC', 487.50, 2.0, '2025-08-12 08:00:00', '2025-08-12 10:00:00');

-- =====================================================
-- SAMPLE LAYER CONSUMPTIONS
-- =====================================================

-- Link movements to layer consumptions (for FIFO tracking)
INSERT INTO layer_consumptions (movement_id, layer_id, quantity_consumed, unit_cost, total_cost) VALUES
-- WO-20250810-A001 SKU-001 consumption (FIFO from oldest layer)
((SELECT id FROM movements WHERE reference = 'WO-20250810-A001' AND sku_id = 'SKU-001'), 'SKU-001-L1', 20, 5.20, 104.00),
-- WO-20250810-A001 SKU-003 consumption
((SELECT id FROM movements WHERE reference = 'WO-20250810-A001' AND sku_id = 'SKU-003'), 'SKU-003-L1', 5, 24.00, 120.00),
-- WO-20250812-B001 SKU-002 consumption
((SELECT id FROM movements WHERE reference = 'WO-20250812-B001' AND sku_id = 'SKU-002'), 'SKU-002-L1', 15, 5.30, 79.50);

-- =====================================================
-- SAMPLE RECEIVING BATCHES
-- =====================================================

INSERT INTO receiving_batches (id, vendor_id, packing_slip_no, receiving_date, is_damaged, damage_scope, total_value) VALUES
('RB-2025-001', 'VND-004', 'PS-2025-001', '2025-07-01', false, 'NONE', 520.00),
('RB-2025-008', 'VND-004', 'PS-2025-008', '2025-07-10', false, 'NONE', 795.00),
('RB-2025-015', 'VND-004', 'PS-2025-015', '2025-07-15', false, 'NONE', 432.00),
('RB-2025-020', 'VND-005', 'PS-2025-020', '2025-07-20', false, 'NONE', 1200.00);

-- =====================================================
-- UPDATE COMPUTED FIELDS
-- =====================================================

-- Update SKU on_hand to match layer totals (trigger will handle future updates)
UPDATE skus SET on_hand = (
    SELECT COALESCE(SUM(remaining_quantity), 0)
    FROM fifo_layers 
    WHERE sku_id = skus.id AND status = 'ACTIVE'
);

-- Update average costs based on current layers
UPDATE skus SET average_cost = (
    SELECT COALESCE(
        SUM(remaining_quantity * unit_cost) / NULLIF(SUM(remaining_quantity), 0),
        0
    )
    FROM fifo_layers 
    WHERE sku_id = skus.id AND status = 'ACTIVE'
);

-- =====================================================
-- VERIFICATION QUERIES (for testing)
-- =====================================================

-- These queries can be used to verify the seed data was inserted correctly

/*
-- Check inventory summary
SELECT * FROM inventory_summary ORDER BY id;

-- Check movement history
SELECT * FROM movement_history LIMIT 20;

-- Verify FIFO layer totals match SKU on_hand
SELECT 
    s.id,
    s.on_hand,
    COALESCE(SUM(fl.remaining_quantity), 0) as layer_total,
    s.on_hand - COALESCE(SUM(fl.remaining_quantity), 0) as difference
FROM skus s
LEFT JOIN fifo_layers fl ON s.id = fl.sku_id AND fl.status = 'ACTIVE'
GROUP BY s.id, s.on_hand
HAVING s.on_hand != COALESCE(SUM(fl.remaining_quantity), 0);

-- Check vendor autocomplete data
SELECT name, city, state FROM vendors WHERE active = true ORDER BY name;
*/
