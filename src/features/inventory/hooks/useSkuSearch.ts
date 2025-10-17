import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type SkuSummary = {
  id: string; // sku_id
  description: string;
  product_category: string;
  unit: string;
  on_hand?: number | null;
  average_cost?: number | null;
  active?: boolean | null;
};

export type UseSkuSearchParams = {
  query?: string;
  category?: string | null;
  activeOnly?: boolean;
  pageSize?: number;
};

export type UseSkuSearchResult = {
  items: SkuSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  total: number;
  setQuery: (q: string) => void;
  setCategory: (c: string | null) => void;
  reset: () => void;
  fetchNext: () => Promise<void>;
};

/**
 * Non-disruptive SKU search hook built on existing Supabase client.
 * - Debounced search (300ms)
 * - Pagination via fetchNext
 * - Filters by category and active flag
 * - Returns minimal fields to keep payloads small
 */
export function useSkuSearch(params?: UseSkuSearchParams): UseSkuSearchResult {
  const [query, setQuery] = useState(params?.query ?? '');
  const [category, setCategory] = useState<string | null>(params?.category ?? null);
  const [items, setItems] = useState<SkuSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const pageSize = params?.pageSize ?? 50;
  const activeOnly = params?.activeOnly ?? true;

  const pageRef = useRef(0);
  const debouncedRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    pageRef.current = 0;
    setItems([]);
    setHasMore(true);
    setTotal(0);
  }, []);

  const fetchPage = useCallback(async (page: number) => {
    setLoading(true);
    setError(null);
    try {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      let qb = supabase
        .from('skus')
        .select('id, description, product_category, unit, on_hand, average_cost, active', { count: 'exact' })
        .order('description', { ascending: true })
        .order('id', { ascending: true });

      if (activeOnly) qb = qb.eq('active', true);
      if (category) qb = qb.eq('product_category', category);

      const q = query.trim();
      if (q.length >= 2) {
        qb = qb.or(`id.ilike.%${q}%,description.ilike.%${q}%`);
      }

      qb = qb.range(from, to);

      const { data, error, count } = await qb;
      if (error) throw error;

      const list: SkuSummary[] = (data || []).map((row: any) => ({
        id: row.id,
        description: row.description,
        product_category: row.product_category,
        unit: row.unit,
        on_hand: row.on_hand,
        average_cost: row.average_cost,
        active: row.active,
      }));

      setItems(prev => (page === 0 ? list : [...prev, ...list]));
      setHasMore((list?.length ?? 0) === pageSize);
      setTotal(count ?? 0);
    } catch (e: any) {
      setError(e?.message || 'Failed to load SKUs');
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [activeOnly, category, pageSize, query]);

  const fetchNext = useCallback(async () => {
    if (loading || !hasMore) return;
    const next = pageRef.current + 1;
    pageRef.current = next;
    await fetchPage(next);
  }, [fetchPage, hasMore, loading]);

  // Debounced initial+reactive fetch
  useEffect(() => {
    reset();
    if (debouncedRef.current) window.clearTimeout(debouncedRef.current);
    debouncedRef.current = window.setTimeout(() => {
      pageRef.current = 0;
      fetchPage(0);
    }, 300);
    return () => {
      if (debouncedRef.current) window.clearTimeout(debouncedRef.current);
    };
  }, [query, category, activeOnly, pageSize, fetchPage, reset]);

  return useMemo(() => ({
    items,
    loading,
    error,
    hasMore,
    total,
    setQuery,
    setCategory,
    reset,
    fetchNext,
  }), [error, hasMore, items, loading, reset, total, fetchNext]);
}
