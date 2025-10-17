import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { useSkuSearch, type SkuSummary } from '@/features/inventory/hooks/useSkuSearch';
import { useCategoriesLite } from '@/features/inventory/hooks/useCategoriesLite';

export type SkuPickerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selected: SkuSummary[]) => void;
  selectionMode?: 'single' | 'multi';
  defaultCategory?: string | null;
  initialQuery?: string | null;
};

function ellipsisMiddle(str: string, max = 64) {
  if (!str) return '';
  if (str.length <= max) return str;
  const half = Math.floor((max - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

export const SkuPickerModal: React.FC<SkuPickerModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectionMode = 'single',
  defaultCategory = null,
  initialQuery = ''
}) => {
  const [tab, setTab] = useState<'search' | 'browse'>('search');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [category, setCategory] = useState<string | null>(defaultCategory ?? null);
  const { items, loading, error, hasMore, total, setQuery: setHookQuery, setCategory: setHookCategory, reset, fetchNext } = useSkuSearch({ query, category, activeOnly: true, pageSize: 50 });
  const { items: categories, loading: loadingCats } = useCategoriesLite({ activeOnly: true });

  const [selected, setSelected] = useState<Map<string, SkuSummary>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTab(defaultCategory ? 'browse' : 'search');
    setQuery(initialQuery ?? '');
    setCategory(defaultCategory ?? null);
    reset();
  }, [defaultCategory, initialQuery, isOpen, reset]);

  useEffect(() => {
    setHookQuery(query);
  }, [query, setHookQuery]);

  useEffect(() => {
    setHookCategory(category ?? null);
  }, [category, setHookCategory]);

  useEffect(() => {
    if (!isOpen) setSelected(new Map());
  }, [isOpen]);

  const onPick = (sku: SkuSummary) => {
    if (selectionMode === 'single') {
      onConfirm([sku]);
      onClose();
      return;
    }
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(sku.id)) next.delete(sku.id); else next.set(sku.id, sku);
      return next;
    });
  };

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight + 48 >= el.scrollHeight) {
      if (hasMore && !loading) fetchNext();
    }
  };

  const skuRow = (sku: SkuSummary) => {
    const checked = selected.has(sku.id);
    return (
      <button
        key={sku.id}
        onClick={() => onPick(sku)}
        className="w-full text-left px-3 py-2 rounded-md border hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
        aria-pressed={checked}
      >
        <div className="flex items-center gap-2">
          {selectionMode === 'multi' && (
            <Checkbox checked={checked} onCheckedChange={(_checked) => onPick(sku)} />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-900 truncate" title={sku.description}>{ellipsisMiddle(sku.description, 120)}</div>
            <div className="text-xs text-slate-500 mt-0.5" title={sku.id}>{ellipsisMiddle(`${sku.id} · ${sku.product_category} · ${sku.unit}`, 120)}</div>
          </div>
          {typeof sku.on_hand === 'number' && (
            <div className="text-xs text-slate-600 shrink-0">{sku.on_hand}</div>
          )}
        </div>
      </button>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o ? onClose() : void 0}>
      <DialogContent className="mx-auto w-[90vw] max-w-[93.6rem] max-h-[95vh] overflow-y-hidden overflow-x-visible">
        <DialogHeader>
          <DialogTitle>Select SKU</DialogTitle>
          <DialogDescription>Search by name or browse by category. Only active SKUs are shown.</DialogDescription>
        </DialogHeader>

        <div className="px-6">
          <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
            <TabsList className="grid grid-cols-2 mb-3">
              <TabsTrigger value="search">Search</TabsTrigger>
              <TabsTrigger value="browse">Browse</TabsTrigger>
            </TabsList>

            <TabsContent value="search">
              <div className="flex items-center gap-2 mb-3">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Type at least 2 characters..."
                  aria-label="Search SKUs"
                />
              </div>

              <div className="text-xs text-slate-500 mb-2">{loading ? 'Loading…' : `${total} result(s)`}{error ? ` · ${error}` : ''}</div>

              <div className="h-[72vh] overflow-y-scroll overscroll-contain pr-2" onScroll={handleScroll} ref={listRef as any}>
                <div className="space-y-2">
                  {items.map(skuRow)}
                  {hasMore && !loading && (
                    <div className="flex justify-center py-2">
                      <Button variant="outline" size="sm" onClick={() => fetchNext()}>Load more</Button>
                    </div>
                  )}
                  {loading && <div className="text-center text-sm text-slate-500 py-2">Loading…</div>}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="browse">
              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-4">
                  <div className="border rounded-md p-2 h-[72vh] overflow-auto overscroll-contain">
                    <button
                      className={`w-full text-left px-2 py-1 rounded ${category === null ? 'bg-slate-900 text-white' : 'hover:bg-slate-50'}`}
                      onClick={() => setCategory(null)}
                    >All categories</button>
                    <div className="mt-1 space-y-1">
                      {loadingCats && <div className="text-xs text-slate-500 px-2 py-1">Loading…</div>}
                      {categories.map(c => (
                        <button
                          key={c.name}
                          className={`w-full text-left px-2 py-1 rounded ${category === c.name ? 'bg-slate-900 text-white' : 'hover:bg-slate-50'}`}
                          onClick={() => setCategory(c.name)}
                          title={c.name}
                        >{ellipsisMiddle(c.name, 28)}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="col-span-8">
                  <div className="text-xs text-slate-500 mb-2">{loading ? 'Loading…' : `${total} result(s)`}{error ? ` · ${error}` : ''}</div>
                  <div className="h-[72vh] overflow-y-scroll overscroll-contain pr-2" onScroll={handleScroll}>
                    <div className="space-y-2">
                      {items.map(skuRow)}
                      {hasMore && !loading && (
                        <div className="flex justify-center py-2">
                          <Button variant="outline" size="sm" onClick={() => fetchNext()}>Load more</Button>
                        </div>
                      )}
                      {loading && <div className="text-center text-sm text-slate-500 py-2">Loading…</div>}
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <div className="flex-1 text-left px-6">
            {selectionMode === 'multi' && selectedList.length > 0 && (
              <div className="text-xs text-slate-600">Selected: {selectedList.length}</div>
            )}
          </div>
          <div className="px-6 pb-4 flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            {selectionMode === 'multi' && (
              <Button onClick={() => { onConfirm(selectedList); onClose(); }} disabled={selectedList.length === 0}>Add selected</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SkuPickerModal;
