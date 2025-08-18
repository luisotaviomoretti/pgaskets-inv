-- 015_backfill_created_by_movement_id.sql
-- Best-effort backfill: link existing fifo_layers to their originating RECEIVE movement
-- Uses exact match on sku_id, original_quantity, unit_cost, and closest movement datetime within +/- 2 minutes.

BEGIN;

WITH candidate_links AS (
  SELECT
    fl.id AS layer_id,
    m.id AS movement_id,
    m.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY fl.id
      ORDER BY ABS(EXTRACT(EPOCH FROM (fl.created_at - m.created_at)))
    ) AS rn
  FROM public.fifo_layers fl
  JOIN public.movements m
    ON m.type = 'RECEIVE'
   AND m.sku_id = fl.sku_id
   AND m.quantity = fl.original_quantity
   AND m.unit_cost = fl.unit_cost
   AND m.created_at BETWEEN fl.created_at - INTERVAL '2 minutes' AND fl.created_at + INTERVAL '2 minutes'
  WHERE fl.created_by_movement_id IS NULL
)
UPDATE public.fifo_layers fl
SET created_by_movement_id = c.movement_id
FROM candidate_links c
WHERE fl.id = c.layer_id AND c.rn = 1;

COMMIT;
