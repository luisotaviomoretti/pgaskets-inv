-- 011_inventory_summary_from_layers.sql
-- Rebuild inventory_summary to derive quantities and average cost from fifo_layers
-- Add supporting indexes and grants
-- Optional: trigger to keep skus.on_hand synchronized from layers

-- 1) Helpful indexes for performance
create index if not exists idx_fifo_layers_sku_id on public.fifo_layers(sku_id);
create index if not exists idx_fifo_layers_remaining_pos on public.fifo_layers(sku_id)
  where remaining_quantity > 0;

-- 2) View: inventory_summary derived from fifo_layers
-- Drop old view first to allow column set changes
drop view if exists public.inventory_summary;

create or replace view public.inventory_summary as
select
  s.id,
  s.description,
  s.type,
  s.product_category,
  s.unit,
  -- on_hand derived from layers with remaining_quantity > 0
  coalesce(sum(case when fl.remaining_quantity > 0 then fl.remaining_quantity else 0 end), 0)::numeric as on_hand,
  s.reserved,
  s.min_stock,
  s.max_stock,
  s.active,
  -- Status computed against derived on_hand
  case 
    when coalesce(sum(case when fl.remaining_quantity > 0 then fl.remaining_quantity else 0 end), 0) <= s.min_stock then 'BELOW_MIN'
    when s.max_stock is not null 
         and coalesce(sum(case when fl.remaining_quantity > 0 then fl.remaining_quantity else 0 end), 0) >= s.max_stock then 'OVERSTOCK'
    else 'OK'
  end as status,
  -- Weighted average cost of remaining layers (fallback to s.average_cost if no layers)
  coalesce(
    sum(case when fl.remaining_quantity > 0 then fl.remaining_quantity * fl.unit_cost end)
      / nullif(sum(case when fl.remaining_quantity > 0 then fl.remaining_quantity end), 0),
    s.average_cost,
    0
  ) as current_avg_cost,
  count(fl.id) filter (where fl.remaining_quantity > 0) as active_layers
from public.skus s
left join public.fifo_layers fl
  on fl.sku_id = s.id
group by s.id, s.description, s.type, s.product_category, s.unit, 
         s.reserved, s.min_stock, s.max_stock, s.active, s.average_cost;

-- 3) Grants (adjust to your security model)
-- Typically Supabase uses anon/authenticated with RLS
grant select on table public.inventory_summary to anon, authenticated, service_role;

-- 4) Optional: trigger to auto-sync skus.on_hand after fifo_layers changes
-- Requires public.sync_sku_on_hand_from_layers(sku_id uuid) created in migration 010
create or replace function public.tr_sync_on_hand_after_layer_change()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Coalesce NEW/OLD so this works for insert/update/delete
  perform public.sync_sku_on_hand_from_layers(coalesce(new.sku_id, old.sku_id));
  return null;
end;
$$;

drop trigger if exists trg_sync_on_hand_after_layer_change on public.fifo_layers;
create trigger trg_sync_on_hand_after_layer_change
after insert or update or delete on public.fifo_layers
for each row execute function public.tr_sync_on_hand_after_layer_change();
