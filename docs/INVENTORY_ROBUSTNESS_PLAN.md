# Inventory System Robustness Plan

## Context

The PGaskets inventory system is a React + TypeScript + Supabase application that has been in production use since Aug 2025. Over the past months, the operator (Danny Andrade) has reported recurring issues during Work Order creation:

1. **WOs entered in QB but missing in the System** — silent failures during submission. Confirmed today: triggered by `consistent_total CHECK` rejecting decimal arithmetic (e.g. 5.25 × $14.7810 = 977.956875). Migration 041 was applied today to fix this — but the fix only addresses one of many root causes.

2. **Duplicate WO IDs reported by the user** — confirmed in DB query: 8 distinct `invoice_no` values are each shared by 2-13 WOs in the same session. Cause: `defaultWOIdRef` is generated once per page load with `useRef` and reused for every WO created in the same session. Combined with the soft-check idempotency in `findExistingWorkOrderByReference()` matching on `(invoice_no, output_name, output_quantity)`, a repeated submission with identical name + qty in the same session silently returns the previously-created WO instead of creating a new one — and inventory is **not** double-consumed even though the user expected it to be.

3. **Reconciliation against QB shows ~$23k of period divergence** — driven mostly by missing receivings (Bill #168449 Poron NF) and a few missing WOs. Some divergence traces back to the bugs above.

The user has approved a coordinated milestone covering Work Order, Receiving, and Movement Deletion (the three flows that mutate FIFO state). Deploy goes directly to production (single instance). Execution will be done end-to-end by the agent after plan approval.

The intended outcome is: **a system where every successful UI submission is guaranteed to persist exactly once, every failure is loud and recoverable, and reconciliation against QB drifts only when QB drifts.**

---

## Scope

In scope (this milestone):
- Work Order creation (`WorkOrder.tsx` + `workorder.service.ts` + RPC `create_work_order_transaction`)
- Receiving (`Receiving.tsx` + `useReceive.ts` + `movement.service.ts`)
- Movement deletion / reversal (`movement-delete-validation.service.ts` + delete RPCs)
- Cross-cutting: client-side idempotency, error code system, telemetry, integration tests

Out of scope (deferred):
- Dashboard staleness (Wireframe.tsx KPIs) — observable but not corrupting data
- SKU optimistic locking — rare collision, not user-reported
- RLS hardening — current "all authenticated" policy fits single-tenant ops
- Sentry integration — telemetry stays console-sink for now (provider swap left as TODO in `telemetry.ts`)

---

## Architecture decisions

### Decision 1: Idempotency via client-generated nonce, not invoice_no reuse

The current soft-check uses `(invoice_no, output_name, output_quantity)` as the dedup key. This collides for every legitimate same-name same-qty submission in the same session. Fix: introduce a **per-submission `client_request_id` (UUID v4)** generated fresh on every Submit click. Server stores it in a new column `work_orders.client_request_id` with a `UNIQUE` constraint. The RPC checks for existing rows by `client_request_id` first; if found, returns it without re-executing. The frontend retains the same client_request_id across retries of the **same submission** (network failure → resubmit) but generates a new one for **new submissions** (form reset → new submit).

This separates two concerns:
- **Same submission retries** → safe (deduplicates correctly).
- **Different submissions, same business data** → both persist (no false dedup).

### Decision 2: Database-level unique constraints for true idempotency

Soft-checks (lookup-then-insert) leak under concurrency. The idempotency contract must be enforced by `UNIQUE (client_request_id)` on `work_orders` and on `movements.client_request_id` for receiving. PRC catches `unique_violation` (SQLSTATE `23505`) and returns the existing row.

### Decision 3: WO ID generator without epoch collisions

Replace `'WO-' || EXTRACT(EPOCH FROM NOW())::bigint` with `'WO-' || nextval('public.work_order_seq')` backed by a dedicated sequence. Sequences are atomic, never collide, and human-readable. Backfill: existing IDs stay; sequence starts at `MAX(numeric_part_of_id) + 1`.

### Decision 4: Structured error codes, not string regex

Create `src/features/inventory/types/errors.ts` exporting `WorkOrderErrorCode` enum (`INSUFFICIENT_STOCK`, `DECIMAL_PRECISION`, `DUPLICATE_REQUEST`, `NETWORK`, `CONSTRAINT_VIOLATION`, `UNKNOWN`). Backend RPCs RAISE EXCEPTION with a stable `MESSAGE` containing the code as JSON. Frontend parses once and routes to user-facing messages. Eliminates the brittle `if (msg.includes('Insufficient stock'))` chain in `WorkOrder.tsx:683`.

### Decision 5: Single-flight submit guard + AbortController

Replace the current `isSubmitting` state with a ref-backed flag set **synchronously before** the validation/submit chain begins, paired with an `AbortController` so unmounting the component cancels in-flight requests cleanly. Eliminates the double-click race that exists between `setConfirmOpen(true)` and `setIsSubmitting(true)`.

### Decision 6: Refresh-then-validate pattern

Before submitting a WO or Receiving, force a fresh re-fetch of the relevant `fifo_layers` and re-run the client-side validation against the fresh data. This narrows but does not eliminate the race window; combined with `FOR UPDATE` locks in `execute_fifo_consumption_validated` (already in 034), the system becomes correct under concurrent load.

### Decision 7: Reuse, don't replace, the existing patterns

`rpcWithRetry` (workorder.service.ts:75), `findExistingWorkOrderByReference` (workorder.service.ts:98), the Vitest+MSW test scaffolding, and the `telemetry.ts` interface all stay. We layer on top:
- Replace `findExistingWorkOrderByReference` lookup key with `client_request_id`.
- Wire `telemetry.event/error` calls at lifecycle points (submit_started, submit_succeeded, submit_failed_*, dedup_hit).
- Add new tests in same `__tests__` folders as existing ones, same Vitest config.

---

## Implementation plan

Single coordinated milestone, no phasing. Each numbered task is atomic and lands as one commit.

### Database migrations

**Migration 042 — `add_client_request_id_for_idempotency.sql`**
- `ALTER TABLE work_orders ADD COLUMN client_request_id UUID;`
- `CREATE UNIQUE INDEX idx_work_orders_client_request_id ON work_orders(client_request_id) WHERE client_request_id IS NOT NULL;` (partial — historical NULLs are fine)
- `ALTER TABLE movements ADD COLUMN client_request_id UUID;`
- `CREATE UNIQUE INDEX idx_movements_client_request_id ON movements(client_request_id) WHERE client_request_id IS NOT NULL;` (used by receiving)

**Migration 043 — `work_order_id_sequence.sql`**
- `CREATE SEQUENCE public.work_order_seq START WITH (greatest current epoch ID + 1);`
- Modify `create_work_order_transaction` RPC: replace `'WO-' || EXTRACT(EPOCH FROM NOW())::bigint` with `'WO-' || nextval('public.work_order_seq')`. Same for receiving's layer ID generation pattern.

**Migration 044 — `idempotent_work_order_rpc.sql`**
Refactor `create_work_order_transaction` to:
1. Accept new `p_client_request_id UUID` parameter.
2. As first step, `SELECT id FROM work_orders WHERE client_request_id = p_client_request_id LIMIT 1`. If found, return existing `work_order_id` and the persisted `total_raw_cost / total_waste_cost / produce_unit_cost / material_consumptions` (read back from `work_orders` + `movements` + `layer_consumptions`). No re-execution.
3. Otherwise execute normally, INSERT including `client_request_id`. If `unique_violation` raised by concurrent insert with same `client_request_id`, catch, fall through to step 2 logic and return that existing WO.
4. Return `jsonb` shape unchanged + new field `was_duplicate boolean` so frontend can show a different toast.

**Migration 045 — `idempotent_receiving_rpc.sql`**
- Add `p_client_request_id UUID` to `create_receiving_transaction`.
- Same idempotency flow as 044 against `movements.client_request_id`.

**Migration 046 — `error_code_envelope.sql`**
- Modify all RAISE EXCEPTION sites in WO and Receiving RPCs to include a `JSON_BUILD_OBJECT('code', '...', 'detail', ...)` payload as the exception message. Codes:
  - `INSUFFICIENT_STOCK` (replaces "Insufficient stock (layers)…")
  - `DECIMAL_PRECISION` (replaces consistent_total CHECK paths if any survive)
  - `INVALID_INPUT` (output_quantity ≤ 0, etc.)
  - `INTEGRITY_VIOLATION` (catch-all for CHECK / FK)
- The `USING ERRCODE = '23514'` stays (Postgres convention) but the message becomes parseable.

### Frontend changes

**File: `src/features/inventory/types/errors.ts` (NEW)**
- Export `WorkOrderErrorCode` and `ReceivingErrorCode` enums.
- Export `parseRpcError(err: unknown): { code: ErrorCode; detail: string; raw: string }` helper.
- Export `formatUserMessage(code, detail)` returning user-facing English string; isolated for future i18n.

**File: `src/features/inventory/services/supabase/workorder.service.ts`**
- Pass `p_client_request_id` to RPC; `createWorkOrder` accepts a new `clientRequestId` param.
- Remove `findExistingWorkOrderByReference` soft-check (replaced by RPC's atomic dedup). Keep the function for the post-failure fallback (network reply lost case): on max-retries exhausted, look up by `client_request_id` directly via `.eq('client_request_id', id)`.
- Wire `telemetry.event('wo.submit.dedup_hit', {...})` when `was_duplicate=true`.
- Wire `telemetry.error('wo.submit.failed', err, {code, ...})` on failures.

**File: `src/features/inventory/services/inventory.adapter.ts`**
- `processWorkOrder` accepts and forwards `clientRequestId`.
- `processReceiving` accepts and forwards `clientRequestId`.

**File: `src/features/inventory/pages/WorkOrder.tsx`**
- Replace `defaultWOIdRef` with `currentSubmissionId: useRef<string | null>(null)`. Set to `crypto.randomUUID()` at start of `finalizeWO()`. After success, **reset to null** so next submission generates a new one.
- Keep `invoice_no` field for human-readable reference (existing format `WO-YYYYMMDDHHMM-XXXX`) but **regenerate on every form reset** (after success, after page refresh).
- Replace error-string regex chain at line 683 with `parseRpcError(err)` + switch on `WorkOrderErrorCode`.
- Add ref-backed single-flight guard: `submittingRef.current = true` **before** any async work; `false` in `finally`. The visible button disabled state continues using `isSubmitting` for accessibility.
- Before submitting, force `getFIFOLayers(skuId)` re-fetch for every selected SKU and re-run inline validation. Only proceed if fresh layers still validate.

**File: `src/features/inventory/pages/Receiving.tsx` + `services/useReceive.ts`**
- Same single-flight guard pattern.
- Same `crypto.randomUUID()` per submission.
- Same `parseRpcError` integration.
- For the explicit "Damaged Quantity" input (line 260) which currently uses `parseInt`, switch to `parseFloat` with rounding to 3 decimals — defense in depth even if not user-blocking.

**File: `src/features/inventory/services/supabase/movement-delete-validation.service.ts`**
- Add a final pre-delete check inside the same RPC transaction (currently the validation is a separate SELECT then DELETE). If the validation cannot be moved into the RPC, at minimum re-validate inside the RPC after acquiring locks.

### Tests (added in same Vitest setup, reusing `setupTests.ts`)

**File: `src/features/inventory/services/supabase/__tests__/workorder.service.idempotency.test.ts` (NEW)**
- Same submission, same client_request_id → second call returns first WO (`was_duplicate=true`).
- Different submissions, same business data, different client_request_id → both persist.
- Network reply lost between RPC success and frontend → `findExistingWorkOrderByReference` recovers via `client_request_id` lookup.

**File: `src/features/inventory/services/supabase/__tests__/workorder.service.error-codes.test.ts` (NEW)**
- Verifies every RPC error returns a valid `WorkOrderErrorCode` after `parseRpcError`.
- Verifies fallback to `UNKNOWN` for unrecognized errors.

**File: `src/__tests__/integration/workorder.submit.success.test.tsx` (NEW)**
- Mounts `<WorkOrder>` with mocked services, fills form, clicks Finalize, asserts `processWorkOrder` called once, success toast appears, form resets.

**File: `src/__tests__/integration/workorder.submit.double-click.test.tsx` (NEW)**
- Same as above but fires two click events synchronously. Asserts `processWorkOrder` called exactly once.

**File: `src/__tests__/integration/workorder.submit.consistent_total.test.tsx` (NEW)**
- Submits WO with decimal qty (5.25). Asserts no `consistent_total` error surfaces (post-041 + post-044).

**File: `src/__tests__/integration/receiving.submit.idempotency.test.tsx` (NEW)**
- Same dedup contract as WO.

### Observability

**File: `src/features/inventory/services/telemetry.ts`**
- No changes to the file — already supports event/error sinks.
- New call sites: WO and Receiving submit lifecycle (started, succeeded, failed_<code>, dedup_hit), preload failures, retry attempts.
- Production users see them in browser DevTools console, sufficient for debugging until Sentry is added.

### Cleanup of historical data

**Migration 047 — `backfill_client_request_id_for_audit.sql`**
- For all existing WOs and movements, set `client_request_id = gen_random_uuid()` so they are addressable by ID (one-shot backfill, no UNIQUE conflict because new UUIDs are random).
- Idempotent: only updates rows where `client_request_id IS NULL`.

---

## Critical files (paths, with the change in one line each)

| File | Change |
|------|--------|
| `supabase/migrations/042_add_client_request_id_for_idempotency.sql` | NEW — add column + unique index |
| `supabase/migrations/043_work_order_id_sequence.sql` | NEW — replace EPOCH-based ID with sequence |
| `supabase/migrations/044_idempotent_work_order_rpc.sql` | NEW — RPC accepts client_request_id and dedupes atomically |
| `supabase/migrations/045_idempotent_receiving_rpc.sql` | NEW — same for receiving |
| `supabase/migrations/046_error_code_envelope.sql` | NEW — RAISE EXCEPTION emits JSON with stable code |
| `supabase/migrations/047_backfill_client_request_id_for_audit.sql` | NEW — one-shot backfill |
| `src/features/inventory/types/errors.ts` | NEW — error code enum + parser + formatter |
| `src/features/inventory/services/supabase/workorder.service.ts` | Add clientRequestId; rework lookup; telemetry calls |
| `src/features/inventory/services/supabase/movement.service.ts` | Same for receiving path |
| `src/features/inventory/services/inventory.adapter.ts` | Forward clientRequestId |
| `src/features/inventory/services/useReceive.ts` | Generate UUID per submission |
| `src/features/inventory/pages/WorkOrder.tsx` | Single-flight guard, fresh-fetch validate, error code switch, regenerate WO ref |
| `src/features/inventory/pages/Receiving.tsx` | Same patterns |
| `src/features/inventory/services/supabase/movement-delete-validation.service.ts` | Move final validation into RPC |
| `src/__tests__/integration/workorder.submit.success.test.tsx` | NEW — happy path |
| `src/__tests__/integration/workorder.submit.double-click.test.tsx` | NEW — single-flight assertion |
| `src/__tests__/integration/workorder.submit.consistent_total.test.tsx` | NEW — decimal qty regression |
| `src/__tests__/integration/receiving.submit.idempotency.test.tsx` | NEW — dedup contract |
| `src/features/inventory/services/supabase/__tests__/workorder.service.idempotency.test.ts` | NEW |
| `src/features/inventory/services/supabase/__tests__/workorder.service.error-codes.test.ts` | NEW |

---

## Verification plan

End-to-end verification after all migrations applied and frontend deployed:

### Step 1 — Migration sanity
1. Apply migrations 042 → 047 in order via `supabase db query --linked -f <file>` (the access token route already used today).
2. After each, `SELECT pg_get_functiondef('create_work_order_transaction'::regprocedure)` to confirm signature.
3. `SELECT count(*) FILTER (WHERE client_request_id IS NULL), count(*) FROM work_orders;` should be 0 NULL after 047.

### Step 2 — Vitest suite
- `npm run test` — all existing tests must remain green; new tests must pass.

### Step 3 — Manual UI smoke (against production via deployed Vercel preview)
1. **Decimal qty, post-041 path** — Create WO consuming `R25 C42 1/8" X 42" X 72"` qty 0.20 (a decimal). Expect success.
2. **Repeated submission, identical body** — Create WO #1 with name "TEST-DEDUP" qty 1, then change nothing and click Finalize again. Expect: only one WO in DB; second click shows "Already submitted" or no-op.
3. **Two browser tabs, same operator** — Open two tabs simultaneously, create WO with same name+qty in each. Expect: both succeed (different `client_request_id`s), distinct WO IDs.
4. **Insufficient stock** — Try a WO that exceeds available. Expect: clear "Not enough stock for SKU X" message (from `INSUFFICIENT_STOCK` code), not generic "An unexpected error".
5. **Force network failure mid-RPC** — In DevTools, throttle to "Offline" right after clicking Finalize. Expect: error message "Network issue. We saved your work — checking…". Then go back online; refresh page; the WO should be findable in Movements.
6. **Receiving with duplicate invoice** — Submit a receiving with a `client_request_id` that already exists (force via DevTools state inspection). Expect: dedup message, no new layer.

### Step 4 — Reconciliation re-run
- After 24h of normal operation, re-run the reconciliation script (`_reconcile_v2.cjs`) and compare deltas vs the baseline taken today. Expectation: no new divergences introduced; existing divergences either explained or scheduled for cleanup.

### Step 5 — Rollback contract
If any of the above fails:
- Migrations 042–047 are pure additive (no destructive ALTERs); to roll back, drop the new columns/indexes/sequence and `CREATE OR REPLACE` the previous RPC versions from migration 040 / 041.
- Frontend revert: `git revert` the milestone commit on `main` and Vercel auto-redeploys the previous build.
- No data loss because client_request_id is additive metadata.

---

## Out-of-scope follow-ups (do NOT include in this milestone)

- Sentry / OpenTelemetry wiring in `telemetry.ts`
- Optimistic locking on SKU edits
- RLS `WITH CHECK` clauses
- Excel export precision audit
- Realtime subscription debouncing in `Movements.tsx`
- Retroactive fixing of the existing $23k QB divergence (manual operator task with the reconciliation Excel as guide)
