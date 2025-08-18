import React, { PropsWithChildren } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper: React.FC<PropsWithChildren> = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}

export function createFixtures() {
  const vendors = [
    { name: 'Acme Supplies', bank: '001', address: 'Street 1' },
    { name: 'Beta Components', bank: '237', address: 'Street 2' },
  ];
  const skus = [
    { id: 'SKU-RAW-1', type: 'RAW', unit: 'kg' },
    { id: 'SKU-SALE-1', type: 'SELLABLE', unit: 'pcs' },
  ];
  const layersBySku: Record<string, any[]> = {};
  return { vendors, skus, layersBySku };
}
