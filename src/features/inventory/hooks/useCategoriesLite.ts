import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type CategoryLite = {
  name: string;
};

export type UseCategoriesLiteParams = {
  activeOnly?: boolean;
};

export function useCategoriesLite(params?: UseCategoriesLiteParams) {
  const activeOnly = params?.activeOnly ?? true;
  const [items, setItems] = useState<CategoryLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let qb = supabase
        .from('skus')
        .select('product_category')
        .order('product_category', { ascending: true });

      if (activeOnly) qb = qb.eq('active', true);

      const { data, error } = await qb;
      if (error) throw error;

      // Normalize, deduplicate, and sort
      const seen = new Set<string>();
      const list: CategoryLite[] = [];
      for (const row of data || []) {
        const nameRaw = row?.product_category ?? '';
        const name = String(nameRaw).trim();
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        list.push({ name });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));

      setItems(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to load categories');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    reload();
  }, [reload]);

  return useMemo(() => ({ items, loading, error, reload }), [error, items, loading, reload]);
}
