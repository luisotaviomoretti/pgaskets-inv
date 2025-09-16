import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase client with controllable behavior
vi.mock('@/lib/supabase', () => {
  type Row = any;
  let workOrders: Row[] = [];

  const rpc = vi.fn<[
    name: string,
    params?: any
  ], Promise<{ data: any; error: any }>>();

  function makeThenable(resultProducer: () => { data: any; error: any }) {
    return {
      then: (resolve: any, reject?: any) => {
        const res = resultProducer();
        return Promise.resolve(res).then(resolve, reject);
      },
    } as any;
  }

  const from = vi.fn((table: string) => {
    if (table === 'work_orders') {
      const state: any = { filters: {}, _limit: null };
      const qb: any = {
        select: vi.fn(() => qb),
        eq: vi.fn((col: string, val: any) => { state.filters[col] = val; return qb; }),
        order: vi.fn(() => qb),
        limit: vi.fn((n: number) => { state._limit = n; return qb; }),
      };
      // Make it awaitable (thenable)
      (qb as any).then = (resolve: any, reject?: any) => {
        const rows = workOrders.filter((r) => {
          for (const [k, v] of Object.entries(state.filters)) {
            if ((r as any)[k] !== v) return false;
          }
          return true;
        });
        const limited = typeof state._limit === 'number' ? rows.slice(0, state._limit) : rows;
        return Promise.resolve({ data: limited, error: null }).then(resolve, reject);
      };
      return qb;
    }
    // default empty table
    return makeThenable(() => ({ data: [], error: null }));
  });

  function __setMockWorkOrders(rows: any[]) { workOrders = rows; }
  function __resetSupabaseMock() { rpc.mockReset(); from.mockReset(); workOrders = []; }

  function handleSupabaseError(error: any): never { throw error; }

  return { supabase: { rpc, from }, handleSupabaseError, __setMockWorkOrders, __resetSupabaseMock };
});

// Mock FIFO plan to avoid hitting database
vi.mock('@/features/inventory/services/supabase/fifo.service', () => {
  const calculateFIFOPlan = vi.fn(async (_skuId: string, qty: number) => ({
    plan: [],
    totalCost: qty * 5, // fixed unit cost 5 for tests
    totalQty: qty,
    canFulfill: true,
  }));
  return { calculateFIFOPlan };
});

import { supabase, __setMockWorkOrders, __resetSupabaseMock } from '@/lib/supabase';
import { createWorkOrder } from '../workorder.service';

function successRpcPayload(id: string) {
  return {
    success: true,
    work_order_id: id,
    total_raw_cost: 100,
    total_waste_cost: 20,
    net_produce_cost: 80,
    produce_unit_cost: 8,
    material_consumptions: [],
  };
}

describe('createWorkOrder - Retry & Idempotency', () => {
  beforeEach(() => {
    __resetSupabaseMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 40001 and succeeds', async () => {
    vi.useFakeTimers();

    let call = 0;
    (supabase.rpc as any).mockImplementation(async (name: string) => {
      expect(name).toBe('create_work_order_transaction');
      call++;
      if (call === 1) return { data: null, error: { code: '40001', message: 'could not serialize' } };
      return { data: successRpcPayload('WO-OK-1'), error: null };
    });

    __setMockWorkOrders([]);

    const p = createWorkOrder({
      outputName: 'Product A',
      outputQuantity: 10,
      rawMaterials: [{ skuId: 'RW-1', quantity: 5 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-R1',
      notes: 'test'
    });

    // advance first backoff 100ms
    await vi.advanceTimersByTimeAsync(100);

    const res = await p;
    expect(res.workOrderId).toBe('WO-OK-1');
    expect((supabase.rpc as any).mock.calls.length).toBe(2);
  });

  it('returns existing immediately via idempotency pre-check (no RPC call)', async () => {
    __setMockWorkOrders([
      { id: 'WO-EXIST-1', invoice_no: 'REF-ID1', output_name: 'Prod X', output_quantity: 3 }
    ]);

    const res = await createWorkOrder({
      outputName: 'Prod X',
      outputQuantity: 3,
      rawMaterials: [{ skuId: 'RW-2', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-ID1',
      notes: 'precheck'
    });

    expect(res.workOrderId).toBe('WO-EXIST-1');
    expect((supabase.rpc as any).mock.calls.length).toBe(0);
  });

  it('after failed retries, fallback finds existing and returns it', async () => {
    vi.useFakeTimers();

    let created = false;
    (supabase.rpc as any).mockImplementation(async () => {
      // Simulate that the first attempt actually created the WO but response failed
      if (!created) {
        __setMockWorkOrders([
          { id: 'WO-EXIST-2', invoice_no: 'REF-FB1', output_name: 'Prod FB', output_quantity: 2 }
        ]);
        created = true;
      }
      return { data: null, error: { code: '40P01', message: 'deadlock detected' } };
    });

    const p = createWorkOrder({
      outputName: 'Prod FB',
      outputQuantity: 2,
      rawMaterials: [{ skuId: 'RW-3', quantity: 2 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-FB1',
      notes: 'fallback'
    });

    // advance 3 attempts: 100 + 200 + 400
    await vi.advanceTimersByTimeAsync(100 + 200 + 400);

    const res = await p;
    expect(res.workOrderId).toBe('WO-EXIST-2');
    expect((supabase.rpc as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('throws after max retries when no fallback exists', async () => {
    vi.useFakeTimers();

    (supabase.rpc as any).mockImplementation(async () => {
      return { data: null, error: { code: '55P03', message: 'lock not available' } };
    });
    __setMockWorkOrders([]);

    const p = createWorkOrder({
      outputName: 'Prod Fail',
      outputQuantity: 1,
      rawMaterials: [{ skuId: 'RW-4', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-NOFB',
      notes: 'max-retries'
    });

    await vi.advanceTimersByTimeAsync(100 + 200 + 400);
    await expect(p).rejects.toBeTruthy();
    expect((supabase.rpc as any).mock.calls.length).toBe(3);
  });

  it('does not treat different output_name/output_quantity as same WO (no idempotency when mismatch)', async () => {
    __setMockWorkOrders([
      { id: 'WO-MISMATCH', invoice_no: 'REF-MM', output_name: 'Prod Y', output_quantity: 5 }
    ]);

    (supabase.rpc as any).mockResolvedValue({ data: successRpcPayload('WO-NEW'), error: null });

    const res = await createWorkOrder({
      outputName: 'Prod Z', // mismatch name
      outputQuantity: 6,     // mismatch quantity
      rawMaterials: [{ skuId: 'RW-5', quantity: 3 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-MM',
      notes: 'mismatch'
    });

    expect(res.workOrderId).toBe('WO-NEW');
    expect((supabase.rpc as any).mock.calls.length).toBe(1);
  });

  it('when reference is missing, no idempotency applies and non-retriable errors are thrown', async () => {
    (supabase.rpc as any).mockResolvedValue({ data: null, error: { code: '23514', message: 'check constraint' } });

    await expect(createWorkOrder({
      outputName: 'Prod NR',
      outputQuantity: 1,
      rawMaterials: [{ skuId: 'RW-6', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      // reference omitted
      notes: 'no-ref'
    } as any)).rejects.toBeTruthy();

    expect((supabase.rpc as any).mock.calls.length).toBe(1);
  });
});
