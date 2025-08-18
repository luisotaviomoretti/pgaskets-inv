-- 020_fix_on_hand_trigger.sql
-- Purpose: Make skus.on_hand authoritative from fifo_layers and ignore WASTE
-- Context: 001_initial_schema.sql created an AFTER INSERT trigger on movements that
--          arithmetically updated skus.on_hand (on_hand = on_hand + NEW.quantity).
--          After migrations 010 and 013, layers are authoritative and WASTE must not
--          reduce on_hand. This migration redefines the trigger function to sync
--          on_hand from layers only for movement types that actually affect layers.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_sku_on_hand()
RETURNS TRIGGER AS $$
BEGIN
  -- Only sync on movements that modify fifo_layers
  IF NEW.sku_id IS NOT NULL AND NEW.type IN ('RECEIVE','ISSUE','ADJUSTMENT','TRANSFER') THEN
    UPDATE public.skus
    SET
      on_hand = public.get_available_from_layers(NEW.sku_id),
      updated_at = NOW()
    WHERE id = NEW.sku_id;
  END IF;

  -- For WASTE and PRODUCE: do nothing here. WASTE does not change layers,
  -- PRODUCE may not reference a SKU and does not affect raw layers.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
