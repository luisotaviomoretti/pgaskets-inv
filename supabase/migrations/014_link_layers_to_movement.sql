-- 014_link_layers_to_movement.sql
-- Adds a reliable FK from fifo_layers to the RECEIVE movement that created the layer
-- and indexes it so deletes can target the exact layer.

BEGIN;

ALTER TABLE public.fifo_layers
  ADD COLUMN IF NOT EXISTS created_by_movement_id integer REFERENCES public.movements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fifo_layers_created_by_mov ON public.fifo_layers(created_by_movement_id);

COMMIT;
