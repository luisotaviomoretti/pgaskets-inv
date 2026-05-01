-- 047_backfill_client_request_id_for_audit.sql
-- One-shot backfill: assign a fresh UUID to every existing WO and movement
-- whose client_request_id is NULL. After this, all rows are addressable by
-- client_request_id, which is useful for audit and any future maintenance
-- scripts. New UUIDs are random so they cannot collide with future client
-- submissions (effectively zero probability).
--
-- Idempotent: only updates where the column is NULL. Safe to re-run.

BEGIN;

UPDATE public.work_orders
SET client_request_id = gen_random_uuid()
WHERE client_request_id IS NULL;

UPDATE public.movements
SET client_request_id = gen_random_uuid()
WHERE client_request_id IS NULL;

COMMIT;
