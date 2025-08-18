import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReceive } from '@/features/inventory/services/useReceive';
import { setReceiveError, getLastReceiveRequest } from '../testServer';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children as any);
}

describe('useReceive + MSW', () => {
  it('submits successfully', async () => {
    const { result } = renderHook(() => useReceive(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        vendorId: 'VEN-1',
        invoice: 'INV-1',
        datetime: new Date().toISOString(),
        lines: [{ sku: 'SKU-1', unit: 'pcs', qty: 1, unitCost: 2 }],
      });
    });
    expect(result.current.isSuccess).toBe(true);
    const body = getLastReceiveRequest();
    expect(body.vendorId).toBe('VEN-1');
    expect(body.lines[0].qty).toBe(1);
  });

  it('handles API error', async () => {
    setReceiveError('Validation failed', 422);
    const { result } = renderHook(() => useReceive(), { wrapper });
    await expect(
      act(async () => {
        await result.current.mutateAsync({
          vendorId: '',
          invoice: 'INV-1',
          datetime: new Date().toISOString(),
          lines: [{ sku: 'SKU-1', unit: 'pcs', qty: 0, unitCost: 2 }],
        });
      })
    ).rejects.toBeDefined();
  });
});
