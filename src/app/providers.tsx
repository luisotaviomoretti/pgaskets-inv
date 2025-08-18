'use client'

import React, { PropsWithChildren, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Toaster } from 'sonner';

/**
 * Providers
 * Envolve a aplicação com QueryClientProvider e configura o Toaster.
 * - staleTime: 5 min
 * - cacheTime (gcTime em v5): 10 min
 */
export default function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        // Para React Query v5, a chave é gcTime; para v4 é cacheTime.
        // As duas são definidas para manter compatibilidade.
        gcTime: 10 * 60 * 1000 as any,
        cacheTime: 10 * 60 * 1000 as any,
        refetchOnWindowFocus: false,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <Toaster position="top-right" />
      {children}
      {process.env.NODE_ENV === 'development' ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}
