-- 018_grant_execute_on_delete_reverse.sql
-- Ensure API roles can call our RPCs
BEGIN;
GRANT EXECUTE ON FUNCTION public.delete_movement(integer, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_movement(integer, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_movement_deletion_info(integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_production_group_deletion_info(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_production_group(text, text, text) TO anon, authenticated, service_role;
COMMIT;
