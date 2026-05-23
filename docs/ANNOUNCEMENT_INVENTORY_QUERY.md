# 📦 New Feature: Inventory Query — See Your Stock on Any Past Date

**Subject:** New Inventory Query tab — historical stock, FIFO drill‑down, and daily activity timeline

Hi team,

I'm happy to share that a new tab — **Inventory Query** — is now live in
the PGaskets Inventory system. It lets you "time‑travel" through the
inventory: pick any past date and see exactly what we had on hand, what
it was worth, which FIFO layers were alive, and what changed that day.

Everything is **read‑only** — the feature only *reads* data; it can't
delete, edit, or create anything. So it's safe to click around freely.

---

## 🔑 How to Access

1. Open the app: <https://pgaskets-inv.vercel.app/>
2. Log in with your usual credentials.
3. In the top navigation, click the new **Inventory Query** tab
   (clock icon, to the right of *Movements*).

If you don't see the tab, do a hard refresh (Ctrl + Shift + R / Cmd + Shift + R)
to clear the cached version.

---

## 👀 What You Can See

### 1. As‑of‑Date Snapshot (the main table)

Pick any date in the **"As of"** field (defaults to today, Toronto time).
The table refreshes to show, for every active SKU:

- **On hand** — the quantity that was in stock at the end of that day.
- **Avg cost** — FIFO‑weighted average cost on that date.
- **Total value** — on hand × avg cost.
- **# active layers** — how many FIFO layers were alive that day.

You can:

- **Filter** by SKU code or description (debounced search).
- **Sort** by SKU code, on hand, or total value (asc/desc).
- **Paginate** at 25 / 50 / 100 / 250 rows per page.
- **Export** the current page or all filtered rows to Excel.

### 2. SKU Drill‑Down (click any row)

Clicking a SKU opens a dialog with everything you need to audit that
SKU on that date:

- **KPI strip** — on hand, avg cost, total value, # layers.
- **FIFO layers active that day**, in FIFO order, with receiving date,
  vendor, packing slip, lot number, unit cost, original/remaining qty,
  and value.
- **Daily Timeline (per SKU)** — one row per day with movement
  activity, showing badges by movement type, gross in / out, Δ net,
  closing quantity, average cost, closing value, and Δ vs. previous
  day.
- **Movements on the selected date** — the specific transactions for
  that SKU on that day.

A warning banner appears if the SKU has any historical **ADJUSTMENT**
movement — those bypass FIFO tracking, so the reconstructed quantity
may differ from `skus.on_hand`. We surface it so you know it's data
behavior, not a bug.

### 3. Daily Inventory Timeline (below the main table)

A system‑wide activity log, dia a dia, across **all SKUs**:

- **Window** selector: last 7 / 30 / 90 / 365 days or all time.
- **KPI strip** for the most recent activity day.
- One row per day with: movements grouped by type, total movement count,
  SKUs touched, active FIFO layers, end‑of‑day inventory value, and the
  Δ versus the previous day.

**Click any row** to open a **Day Breakdown** modal that shows every
single movement of that day, **grouped by SKU**, with vendor, work
order, packing slip, reference, and notes for each transaction.

### 4. Excel Exports

- **Snapshot table** — export current page or all filtered rows.
- **Daily Inventory Timeline** — exports two sheets: *Daily Summary*
  (one row per day with type breakdown) and *Movements Detail* (every
  individual movement in the selected window).
- **Day Breakdown modal** — exports just that day's movements.

---

## ✅ Why This Is Useful

- **Month‑end and year‑end closing.** See exactly what was on hand and
  what it was worth on any specific date — no more guessing or manual
  reconciliation.
- **QuickBooks reconciliation.** Match our system's end‑of‑day inventory
  value against accounting records, day by day.
- **Audit trail.** When a question comes up about a past date ("what
  did we have last Friday?"), you get the answer in two clicks.
- **Investigating discrepancies.** If a count doesn't match the system,
  the Daily Timeline + Day Breakdown lets you walk back through every
  RECEIVE, ISSUE, PRODUCE, WASTE, and ADJUSTMENT to find when and where
  things diverged.
- **Operational visibility.** See at a glance which days had heavy
  activity, which vendors dominated receivings, and how inventory value
  evolved over time.

---

## ⚠️ Things to Know

- All math is reconstructed deterministically from the underlying
  movement and FIFO‑layer history — there's no second copy of the data
  to keep in sync.
- Numbers are based on **end of day in America/Toronto timezone**.
- The feature **excludes** soft‑deleted and reversed movements (the
  same way the rest of the app does).
- For five SKUs in the current dataset there's a small residual qty
  divergence vs. the live `on_hand` because of historical ADJUSTMENT
  movements that didn't pass through FIFO. The drill‑down banner makes
  this explicit — it's not a defect of the new feature.

---

## 🐞 Found Something Off?

Please **try it out** and poke around — different dates, different
SKUs, different windows. **Any issue you spot during testing — wrong
numbers, slow loads, confusing labels, anything at all — please let me
know** and we'll address it right away. Quick feedback now means we
ship a polished tool.

You can reply directly to this email or ping me on our usual channel.

Thanks!
