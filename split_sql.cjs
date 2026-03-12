const fs = require('fs');

// Read full SQL files
const skuSQL = fs.readFileSync('_01_skus.sql', 'utf8');
const layerSQL = fs.readFileSync('_02_layers.sql', 'utf8');

// Extract header and values for SKUs
const skuLines = skuSQL.split('\n');
const skuHeader = skuLines[0]; // INSERT INTO ...
const skuValuesLine = skuLines[1]; // VALUES
const skuFooter = skuLines[skuLines.length - 1]; // ON CONFLICT...

// Get individual value rows (lines 2 to second-to-last)
const skuValues = skuLines.slice(2, -1).map(line => line.replace(/,$/, '').trim());

// Split into batches of 50
const BATCH = 50;
const skuBatches = [];
for (let i = 0; i < skuValues.length; i += BATCH) {
  const batch = skuValues.slice(i, i + BATCH);
  const sql = `${skuHeader}\nVALUES\n  ${batch.join(',\n  ')}\n${skuFooter}`;
  skuBatches.push(sql);
  fs.writeFileSync(`_01_skus_batch${Math.floor(i/BATCH)+1}.sql`, sql);
}
console.log(`SKUs: ${skuValues.length} rows -> ${skuBatches.length} batches`);

// Same for layers
const layerLines = layerSQL.split('\n');
const layerHeader = layerLines[0];
const layerFooter = layerLines[layerLines.length - 1];
const layerValues = layerLines.slice(2, -1).map(line => line.replace(/,$/, '').trim());

const layerBatches = [];
for (let i = 0; i < layerValues.length; i += BATCH) {
  const batch = layerValues.slice(i, i + BATCH);
  const sql = `${layerHeader}\nVALUES\n  ${batch.join(',\n  ')}\n${layerFooter}`;
  layerBatches.push(sql);
  fs.writeFileSync(`_02_layers_batch${Math.floor(i/BATCH)+1}.sql`, sql);
}
console.log(`Layers: ${layerValues.length} rows -> ${layerBatches.length} batches`);
