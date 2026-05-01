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

function successRpcPayload(id: string, opts?: { wasDuplicate?: boolean }) {
  return {
    success: true,
    was_duplicate: !!opts?.wasDuplicate,
    work_order_id: id,
    total_raw_cost: 100,
    total_waste_cost: 20,
    net_produce_cost: 80,
    produce_unit_cost: 8,
    material_consumptions: [],
  };
}

describe('createWorkOrder - Retry & Idempotency (post-044)', () => {
  beforeEach(() => {
    __resetSupabaseMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 40001 (serialization) and succeeds on second attempt', async () => {
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
      notes: 'test',
      clientRequestId: '11111111-1111-1111-1111-111111111111',
    });

    await vi.advanceTimersByTimeAsync(100);

    const res = await p;
    expect(res.workOrderId).toBe('WO-OK-1');
    expect((supabase.rpc as any).mock.calls.length).toBe(2);
  });

  it('forwards p_client_request_id to the RPC', async () => {
    (supabase.rpc as any).mockResolvedValue({ data: successRpcPayload('WO-FWD-1'), error: null });
    __setMockWorkOrders([]);

    const cid = '22222222-2222-2222-2222-222222222222';
    await createWorkOrder({
      outputName: 'Prod CID',
      outputQuantity: 1,
      rawMaterials: [{ skuId: 'RW-2', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-CID',
      notes: 'cid-test',
      clientRequestId: cid,
    });

    const calls = (supabase.rpc as any).mock.calls;
    expect(calls.length).toBe(1);
    const params = calls[0][1];
    expect(params.p_client_request_id).toBe(cid);
  });

  it('passes through was_duplicate=true when server reports an idempotency hit', async () => {
    (supabase.rpc as any).mockResolvedValue({
      data: successRpcPayload('WO-DUP', { wasDuplicate: true }),
      error: null,
    });
    __setMockWorkOrders([]);

    const res: any = await createWorkOrder({
      outputName: 'Prod Dup',
      outputQuantity: 1,
      rawMaterials: [{ skuId: 'RW-2', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-DUP',
      notes: 'dup-test',
      clientRequestId: '33333333-3333-3333-3333-333333333333',
    });

    expect(res.workOrderId).toBe('WO-DUP');
    expect(res.wasDuplicate).toBe(true);
  });

  it('after exhausting retries, falls back to client_request_id lookup if WO already committed', async () => {
    vi.useFakeTimers();

    let created = false;
    (supabase.rpc as any).mockImplementation(async () => {
      // Simulate that the first attempt actually created the WO but the
      // network reply dropped, then subsequent attempts hit deadlocks.
      if (!created) {
        __setMockWorkOrders([
          { id: 'WO-FB-1', invoice_no: 'REF-FB1', client_request_id: '44444444-4444-4444-4444-444444444444' }
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
      notes: 'fallback',
      clientRequestId: '44444444-4444-4444-4444-444444444444',
    });

    await vi.advanceTimersByTimeAsync(100 + 200 + 400);

    const res: any = await p;
    expect(res.workOrderId).toBe('WO-FB-1');
    expect(res.wasDuplicate).toBe(true);
    expect((supabase.rpc as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('throws after max retries when no row exists for the client_request_id', async () => {
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
      notes: 'max-retries',
      clientRequestId: '55555555-5555-5555-5555-555555555555',
    });
    // Attach a noop catch so vi.advanceTimers doesn't surface an unhandled
    // rejection while the retry loop is still in flight.
    p.catch(() => {});

    await vi.advanceTimersByTimeAsync(100 + 200 + 400);
    await expect(p).rejects.toBeTruthy();
    expect((supabase.rpc as any).mock.calls.length).toBe(3);
  });

  it('non-retriable errors (e.g. INVALID_INPUT envelope) are thrown without retry', async () => {
    (supabase.rpc as any).mockResolvedValue({
      data: null,
      error: { code: '23514', message: '{"code":"INVALID_INPUT","detail":"Output quantity must be positive"}' },
    });
    __setMockWorkOrders([]);

    await expect(createWorkOrder({
      outputName: 'Prod NR',
      outputQuantity: 1,
      rawMaterials: [{ skuId: 'RW-6', quantity: 1 }],
      wasteLines: [],
      date: new Date(),
      reference: 'REF-NR',
      notes: 'no-retry',
      clientRequestId: '66666666-6666-6666-6666-666666666666',
    } as any)).rejects.toBeTruthy();

    expect((supabase.rpc as any).mock.calls.length).toBe(1);
  });
});
