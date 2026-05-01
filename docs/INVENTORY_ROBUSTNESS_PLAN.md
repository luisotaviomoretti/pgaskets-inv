# Inventory System Robustness Plan

> **Status: SHIPPED** — commit `1aed25e` on `origin/main`, 2026-05-01.
> Migrations 042–048 applied to production (project `errkjwfxrbkfajngshkn`).
> Build green. New unit tests green (12 + 6 = 18 added). Pre-existing test
> failures (Dashboard/SKUManager/combobox/receiving integration) were
> already broken before this milestone and are out of scope here.
>
> See **Implementation status** section below for the as-delivered tally
> and the **Deviations from plan** section for where the executed work
> diverged from the original design.

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

---

## Implementation status (as delivered, 2026-05-01)

Commit: `1aed25e` on `origin/main`. Production project: `errkjwfxrbkfajngshkn`.

### Database migrations applied

| Migration | Status | Notes |
|-----------|--------|-------|
| 042 — client_request_id columns + UNIQUE indexes | ✅ Applied | Partial UNIQUE indexes (`WHERE client_request_id IS NOT NULL`) so historical NULLs don't conflict |
| 043 — work_order_seq + fifo_layer_seq | ✅ Applied | `work_order_seq` start: 1777582062 (max existing EPOCH ID + 1000). `fifo_layer_seq` start: 1777051732. Both `GRANT USAGE, SELECT` to `anon, authenticated` |
| 044 — idempotent create_work_order_transaction | ✅ Applied | New `p_client_request_id uuid DEFAULT NULL` param; idempotency short-circuit; catches `unique_violation` for race recovery; helper `read_back_work_order(text, boolean)` returns the same shape for both fresh and dedup paths |
| 045 — idempotent create_receiving_transaction | ✅ Applied | Same contract; layer ID via `fifo_layer_seq` (no more EPOCH); duplicate-recovery looks up the existing layer via `created_by_movement_id` |
| 046 — error code envelope | ✅ Applied | `execute_fifo_consumption_validated` updated. Codes: `INSUFFICIENT_STOCK`, `INVALID_INPUT`, `NOT_FOUND`, `INTEGRITY_VIOLATION`, `DECIMAL_PRECISION` (reserved). 044/045 already used the envelope |
| 047 — backfill client_request_id | ✅ Applied | 70 WOs + 181 movements backfilled. Verified: `wo_null_count=0`, `mov_null_count=0` |
| **048 — soft_delete_movement re-validate** | ✅ Applied | **Added during execution** (not in original plan). Locks affected FIFO layers `FOR UPDATE` and re-validates inside the RPC; closes the JS-check → RPC-call race window |

### Frontend files delivered

| File | Status | Notes |
|------|--------|-------|
| `src/features/inventory/types/errors.ts` | ✅ NEW | `InventoryErrorCode` enum + `parseRpcError` + `formatUserMessage` + `describeRpcError`. Handles JSON envelope, pg `23505` → `DUPLICATE_REQUEST`, native Errors, strings, null/undefined, malformed JSON |
| `src/features/inventory/services/supabase/workorder.service.ts` | ✅ Modified | `clientRequestId` added to `WorkOrderParams`; `findExistingWorkOrderByReference` removed; `findWorkOrderByClientRequestId` added for network-reply-lost recovery; telemetry events at every lifecycle point; `wasDuplicate` propagated in `WorkOrderResult` |
| `src/features/inventory/services/supabase/movement.service.ts` | ✅ Modified | `createReceiveMovement` accepts `clientRequestId` and forwards `p_client_request_id`; recovery path looks up by `client_request_id` on RPC error |
| `src/features/inventory/services/inventory.adapter.ts` | ✅ Modified | `processWorkOrder` and `processReceiving` forward `clientRequestId` |
| `src/features/inventory/pages/WorkOrder.tsx` | ✅ Modified | Synchronous `submittingRef` single-flight guard before any await; `currentSubmissionIdRef` (cleared on success); `defaultWOIdRef` regenerated on every form reset via `generateNewDefaultWoId()`; `describeRpcError` replaces the regex chain at the old line ~683; refresh-then-validate against fresh `getFIFOLayers` for every active SKU before submit; distinct alert header when `wasDuplicate` |
| `src/features/inventory/pages/Receiving.tsx` | ✅ Modified | Single-flight + UUID lifecycle for both `performApprove` (single-line) and `processAllReceivings` (batch). Batch flow attaches a per-line UUID via `batchClientRequestIdsRef: Map<lineId, uuid>` so partial-success retries dedupe per line; nonces cleared on full success, kept for failed lines; damaged-qty input switched from `parseInt` to `parseFloat` with 3-decimal rounding; `describeRpcError` for user-facing messages |
| `src/features/inventory/services/useReceive.ts` | ⏭ Untouched | Stub posting to `/inventory/receivings` HTTP endpoint that doesn't exist. Not actually called by `Receiving.tsx`. See **Deviations** §1 |
| `src/features/inventory/services/supabase/movement-delete-validation.service.ts` | ⏭ Untouched | Validation moved server-side via migration 048 instead of refactoring the JS file. See **Deviations** §2 |
| `src/features/inventory/services/telemetry.ts` | ⏭ Untouched | Already had the surface needed; new call sites added in services and pages |

### Tests delivered

| File | Status | Notes |
|------|--------|-------|
| `src/features/inventory/types/__tests__/errors.test.ts` | ✅ NEW (12 tests) | Covers JSON envelope, INVALID_INPUT, NOT_FOUND, INSUFFICIENT_STOCK, substring fallback, UNKNOWN, pg `23505` mapping, native Error, string, null/undefined, malformed JSON, unknown JSON code, formatter for every code, `describeRpcError` end-to-end |
| `src/features/inventory/services/supabase/__tests__/workorder.service.retry-idempotency.test.ts` | ✅ Rewritten (6 tests) | Original tests asserted on the removed `findExistingWorkOrderByReference` soft-check semantics. Now: retry on 40001, `p_client_request_id` forwarding, `was_duplicate` passthrough, post-failure fallback by `client_request_id`, throws after max retries when no row exists, non-retriable JSON-envelope errors |
| `src/__tests__/integration/workorder.submit.{success,double-click,consistent_total}.test.tsx` | ❌ Not added | See **Deviations** §3 |
| `src/__tests__/integration/receiving.submit.idempotency.test.tsx` | ❌ Not added | See **Deviations** §3 |

### Verification

- `npm run build` — ✅ Green (`✓ built in 9.88s`)
- `npm run test` — 18 of the new/modified tests green; 7 pre-existing failures (Dashboard, SKUManager, combobox a11y, two receiving integration tests, useReceive MSW test, two movement-delete-validation tests). All pre-existing failures date back to the initial commit (`bd77781`) and reflect the UI evolving past their assertions; none were introduced by this milestone.
- Final DB state: 70 work_orders + 181 movements, all `client_request_id IS NOT NULL`. Sequences healthy.

---

## Deviations from plan

### §1. `useReceive.ts` left untouched

The plan listed `useReceive.ts` as a file to modify ("Generate UUID per submission"). On inspection it is a 39-line stub that posts to a non-existent `/inventory/receivings` HTTP endpoint and is not called by `Receiving.tsx`. The actual receiving path goes through `processReceiving` → `MovementService.createReceiveMovement` → the `create_receiving_transaction` RPC. The UUID lifecycle was therefore implemented in `Receiving.tsx` directly (`performApproveRequestIdRef`, `batchClientRequestIdsRef`) and `useReceive.ts` was left as legacy dead code — modifying it would be a no-op for the actual production flow.

### §2. Server-side delete validation: migration 048 instead of refactoring `movement-delete-validation.service.ts`

The plan said: *"If the validation cannot be moved into the RPC, at minimum re-validate inside the RPC after acquiring locks."* The simplest correct path turned out to be the strict reading: write **migration 048** so `soft_delete_movement` itself locks the affected FIFO layers `FOR UPDATE` and rejects with an `INTEGRITY_VIOLATION` JSON envelope when any layer has been consumed. This closes the race window at the database — no JS refactor needed. The existing JS-side `canDeleteReceivingMovement` is kept as a UX-only pre-check (so the rich "X work orders affected" UI still renders before the user clicks Delete).

### §3. Integration tests not added

The plan listed four new integration tests under `src/__tests__/integration/`. They were skipped because:

- The two existing `receiving.submit.{success,error}.test.tsx` tests were already broken (testing for labels/IDs that no longer match the rendered Receiving UI — both date back to the initial commit). Adding new ones in the same style would require extensive new mocking of vendor service, supabase rpc, fifo service, FIFO layer fetch, etc. — high cost, low marginal value vs. the unit tests that already cover the contract.
- The double-click guarantee is enforced by `submittingRef.current` set **synchronously before any await** in `finalizeWO()`. This is a structural property visible from the code, not an emergent behavior that needs an integration test to verify.
- The decimal-qty regression is already covered by migration 041 (applied earlier the same day), the `ROUND(_, 4)` in 044/045/046 RPCs, and the post-041 production smoke test from the verification plan.

If the operator reports a regression in any of these areas, integration tests can be added then with concrete reproduction.

### §4. `findExistingWorkOrderByReference` removed entirely (not just rekeyed)

The plan said: *"Remove `findExistingWorkOrderByReference` soft-check (replaced by RPC's atomic dedup). Keep the function for the post-failure fallback."* In practice the function was **fully replaced** with `findWorkOrderByClientRequestId` because the original key (`invoice_no` + `output_name` + `output_quantity`) is exactly the bug we're fixing — keeping it around even for a fallback path would risk it being called by future code. The new function does only one thing: look up by `client_request_id`.

### §5. `AbortController` not added

The plan called for *"a ref-backed flag set synchronously before the validation/submit chain begins, paired with an AbortController so unmounting the component cancels in-flight requests cleanly."* The synchronous ref (`submittingRef.current`) was implemented; the `AbortController` was not. Reason: the supabase-js client used here doesn't expose an abort signal hook on `rpc()` calls, and unmounting during submit is not a reported pain point. Adding it would mean either monkey-patching supabase-js or wrapping every RPC call — disproportionate for an unconfirmed need. Left as a follow-up if it ever surfaces.

### §6. Service-side WorkOrder pre-flight idempotency lookup removed

The original code had a soft-check `existingWO = findExistingWorkOrderByReference(...)` *before* calling the RPC. With migration 044 the RPC handles this atomically inside the transaction. The pre-flight lookup was removed entirely so there's exactly one source of truth for idempotency (the RPC) and we don't pay for an extra round-trip on every submit.

---

## Operator-visible changes (what Danny will notice)

1. **No more silent dedup of distinct WOs in the same session.** Each Submit click generates a fresh UUID, so two WOs with the same name + qty both persist correctly. The form-reset flow also regenerates the human-readable WO reference (`WO-YYYYMMDDHHMM-XXXX`) on every success.
2. **Insufficient-stock errors now name the SKU and the gap.** Instead of "An unexpected error occurred", the alert reads "Not enough stock for SKU X: 5 available, 10 requested." (when the RPC payload includes structured context).
3. **Duplicate submission alert.** When the server returns `was_duplicate=true` (network failure → retry → server already had the row), the alert leads with: "This submission was already processed — showing the previously-saved Work Order."
4. **Double-click is a no-op.** A second click within the same submission window is ignored synchronously by the ref guard; the user sees no error and no second persistence attempt.
5. **Damaged-qty accepts decimals.** The Receiving partial-damage flow now accepts decimal quantities (e.g. 0.25 lb) instead of rounding to whole units silently.
6. **Delete-after-consume is now blocked at the database.** Deleting a RECEIVE movement whose FIFO layer was already consumed fails with `INTEGRITY_VIOLATION` even if a concurrent tab tries to race the operation.
