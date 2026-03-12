const XLSX = require('xlsx');
const fs = require('fs');

const wb = XLSX.readFile('stock_adjustment.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws);

// Fix duplicate: rename second occurrence of R25 F-5031 1/2 X 54
let seenSku = new Set();
const fixed = data.map(r => {
  let sku = r['SKU Code'];
  if (sku === 'R25 F-5031 1/2 X 54' && seenSku.has(sku)) {
    sku = 'R25 F-3091 1/2 X 54';
  }
  seenSku.add(r['SKU Code']);
  return { ...r, 'SKU Code': sku };
});

function esc(s) {
  return (s || '').replace(/'/g, "''");
}

// === STEP 1: SKU inserts ===
const skuValues = fixed.map(r => {
  const id = esc(r['SKU Code']);
  const desc = esc(r.Description);
  const cat = esc((r.Category || '').trim());
  const unit = r.Unit || 'unit';
  const qty = r['PHYSICAL COUNT'] || 0;
  const min = r.Minimum || 0;
  const cost = parseFloat(r['Avg. Cost (FIFO)']) || 0;
  return `  ('${id}', '${desc}', 'RAW', '${cat}', '${unit}', true, ${min}, NULL, ${qty}, 0, ${cost}, ${cost}, now(), now(), 'system', 'system', '{}')`;
});

const skuSQL = `INSERT INTO skus (id, description, type, product_category, unit, active, min_stock, max_stock, on_hand, reserved, average_cost, last_cost, created_at, updated_at, created_by, updated_by, metadata)
VALUES
${skuValues.join(',\n')}
ON CONFLICT (id) DO NOTHING;`;

fs.writeFileSync('_01_skus.sql', skuSQL);
console.log(`SKUs SQL: ${fixed.length} rows -> _01_skus.sql`);

// === STEP 2: FIFO layer inserts ===
// Only for SKUs with qty > 0 AND cost > 0
const layerRows = fixed.filter(r => {
  const qty = r['PHYSICAL COUNT'] || 0;
  const cost = parseFloat(r['Avg. Cost (FIFO)']) || 0;
  return qty > 0 && cost > 0;
});

const layerValues = layerRows.map(r => {
  const skuId = esc(r['SKU Code'].trim().toUpperCase());
  const qty = r['PHYSICAL COUNT'];
  const cost = parseFloat(r['Avg. Cost (FIFO)']);
  // Layer ID = "INIT-" + SKU Code (trimmed+uppercased to match DB trigger)
  const layerId = esc('INIT-' + r['SKU Code'].trim().toUpperCase());
  return `  ('${layerId}', '${skuId}', '2026-03-12', NULL, ${qty}, ${qty}, ${cost}, NULL, 'STOCK-ADJ', NULL, NULL, 'ACTIVE', now(), NULL, NULL, now())`;
});

const layerSQL = `INSERT INTO fifo_layers (id, sku_id, receiving_date, expiry_date, original_quantity, remaining_quantity, unit_cost, vendor_id, packing_slip_no, lot_number, location, status, created_at, last_movement_at, created_by_movement_id, updated_at)
VALUES
${layerValues.join(',\n')}
ON CONFLICT (id) DO NOTHING;`;

fs.writeFileSync('_02_layers.sql', layerSQL);
console.log(`FIFO Layers SQL: ${layerRows.length} rows -> _02_layers.sql`);

// Summary
const noLayer = fixed.filter(r => {
  const qty = r['PHYSICAL COUNT'] || 0;
  const cost = parseFloat(r['Avg. Cost (FIFO)']) || 0;
  return qty <= 0 || cost <= 0;
});
console.log(`\nSKUs without layer (${noLayer.length}):`);
noLayer.forEach(r => {
  console.log(`  ${r['SKU Code']} -> qty=${r['PHYSICAL COUNT']||0}, cost=${r['Avg. Cost (FIFO)']||'N/A'}`);
});
