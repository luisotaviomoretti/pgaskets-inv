-- 019_add_movements_updated_at.sql
-- Add missing updated_at column to movements table

BEGIN;

ALTER TABLE public.movements 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Create trigger to auto-update updated_at on movement changes
CREATE OR REPLACE FUNCTION public.update_movements_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_movements_updated_at ON public.movements;
CREATE TRIGGER trigger_update_movements_updated_at
    BEFORE UPDATE ON public.movements
    FOR EACH ROW
    EXECUTE FUNCTION public.update_movements_updated_at();

COMMIT;
