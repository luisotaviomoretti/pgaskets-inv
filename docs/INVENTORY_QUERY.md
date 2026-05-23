# Inventory Query — As-of-Date Stock Reconstruction

Read-only feature that reconstructs per-SKU stock, average cost, and FIFO
layer composition as of any past calendar day, deterministically, over the
append-only `movements` + `fifo_layers` + `layer_consumptions` history.

## What the user sees

A new "Inventory Query" tab in the main wireframe with:

- A date picker (defaults to today in **America/Toronto**), a free-text
  filter on SKU code/description, and sort + page-size controls.
- A paginated table: SKU · Description · Type · On hand · Avg cost ·
  Total value · # active layers. Click a row to drill down.
- A drill-down dialog showing reconstructed **FIFO layers** active on the
  selected date and the **day's movements** for that SKU, plus totals.
- "Export page" and "Export all (current filter)" buttons (xlsx).

## Semantics

| Aspect | Decision |
|---|---|
| **Cutoff** | End of day `D` in `America/Toronto` (exclusive upper bound = start of `D+1`). |
| **Soft-deletes / reversals** | Always excluded (`deleted_at IS NULL AND reversed_at IS NULL`), regardless of when the deletion/reversal happened. The view is "the real stock today, projected back to D" — not "the system's view on D". |
| **Orphan FIFO layers** | Layers with `created_by_movement_id IS NULL` (the opening-balance `INIT-*` family loaded by `stock_load.sql`) are treated as originating at `layer.created_at`. Without this, ~72% of layers and ~$235k of stock would be invisible to the snapshot — see migration 050. |
| **ADJUSTMENT movements** | These bypass FIFO consumption tracking (no `layer_consumptions` row). Snapshot quantities will diverge from `skus.on_hand` for SKUs with historical ADJUSTMENTs. The drill-down flags these with a warning banner via `totals.has_adjustments`. |
| **Pagination** | Offset/limit, server-side. Total row count returned via `COUNT(*) OVER ()` so the UI can render a pager without a second roundtrip. |
| **Sort whitelist** | `sku_code_asc/desc`, `on_hand_asc/desc`, `total_value_asc/desc`. Anything else falls back to insertion order with the `sku_id` tiebreaker. |

## Architecture

- **`supabase/migrations/049_inventory_query_snapshot_rpc.sql`** — creates `get_inventory_snapshot_as_of(...)`.
- **`supabase/migrations/050_inventory_query_snapshot_rpc_orphan_layers.sql`** — patches the snapshot RPC to handle `INIT-*` orphan layers.
- **`supabase/migrations/051_inventory_query_detail_rpc.sql`** — creates `get_sku_detail_as_of(...)` for the drill-down.
- **`src/features/inventory/services/supabase/inventoryQuery.service.ts`** — thin TS wrapper around the two RPCs, with row mapping helpers.
- **`src/features/inventory/services/inventory.adapter.ts`** — appended `inventoryQueryOperations` namespace (purely additive).
- **`src/features/inventory/pages/InventoryQuery.tsx`** — the page (lazy-loaded).
- **`src/features/inventory/pages/Wireframe.tsx`** — registers the tab (4 minimal insertions; pattern identical to existing tabs).

Both RPCs are `LANGUAGE sql/plpgsql STABLE SECURITY DEFINER SET search_path = public`,
with `EXECUTE` granted only to `authenticated` and `service_role`. Same
profile as every other read RPC in the project.

## Reconstruction math

For SKU `s`, target date `D`, timezone `tz`:

```
cutoff_ts = start_of_day(D + 1) AT TIME ZONE tz   -- exclusive

active_layers(s)        = layers L for SKU s where
                          COALESCE(L.created_by_movement.datetime,
                                   L.created_at)  <  cutoff_ts
                          AND (L.created_by_movement_id IS NULL
                               OR L.created_by_movement is not soft-deleted
                                  and not reversed)

consumed_to_date(L)     = SUM(layer_consumptions.quantity_consumed)
                          WHERE lc.deleted_at IS NULL
                            AND its movement is live
                            AND its movement.datetime < cutoff_ts

qty_remaining_as_of(L)  = GREATEST(L.original_quantity
                                    - consumed_to_date(L), 0)

on_hand(s)              = SUM over alive layers of qty_remaining_as_of
total_value(s)          = SUM(qty_remaining_as_of * unit_cost)
avg_cost(s)             = total_value / on_hand     (0 if on_hand = 0)
```

## Verification

### Parity test (run via Supabase MCP `execute_sql`)

```sql
WITH snap AS (
  SELECT * FROM get_inventory_snapshot_as_of(
    (now() AT TIME ZONE 'America/Toronto')::date,
    'America/Toronto', null, 100000, 0, 'sku_code_asc')
)
SELECT s.id,
       s.on_hand AS live_on_hand,  snap.on_hand AS calc_on_hand,
       (snap.on_hand - s.on_hand)  AS qty_diff
FROM   skus s JOIN snap ON snap.sku_id = s.id
WHERE  s.active = true
  AND  abs(coalesce(s.on_hand,0) - coalesce(snap.on_hand,0)) > 0.001;
```

**Expected**: ~5 rows out of ~147 active SKUs, all explainable by historical
ADJUSTMENT movements. Cost divergences are expected as well because
`skus.average_cost` is a denormalized "last cost" field, not a continuously
recomputed FIFO-weighted average.

If a substantially larger divergence appears, investigate before extending
the feature — it likely indicates new write-path bypass of FIFO tracking,
not an RPC defect.

### Performance budget

Measured on the production dataset (147 active SKUs, 366 movements, 166
layers, ~120 of which are orphans):

| Call | Time | Buffers |
|---|---|---|
| `get_inventory_snapshot_as_of` page 1, default sort | ~7–8 ms | shared hit=1801 |
| `get_inventory_snapshot_as_of` page 1, on_hand_desc | ~7–8 ms | shared hit=1801 |
| `get_sku_detail_as_of` single SKU | ~9 ms | shared hit=1868 |

Indices used (all pre-existing):
- `idx_movements_sku_datetime`, `idx_movements_active`, `idx_movements_deleted`
- `idx_fifo_layers_sku_date`, `idx_fifo_layers_created_by_mov`
- `idx_layer_consumptions_layer`, `idx_layer_consumptions_active`

No new indexes were added.

## Rollback (safe, in this order)

1. `git revert` the Wireframe.tsx change — hides the UI immediately.
2. `DROP FUNCTION public.get_sku_detail_as_of(text, date, text);`
3. `DROP FUNCTION public.get_inventory_snapshot_as_of(date, text, text, integer, integer, text);`
4. Delete `src/features/inventory/pages/InventoryQuery.tsx`, `…/services/supabase/inventoryQuery.service.ts`, and revert the appended lines in `…/services/supabase/index.ts` and `…/services/inventory.adapter.ts`.

Each step is independent. No write-path code, schema, or data was touched —
the impact of removing the feature is zero.
