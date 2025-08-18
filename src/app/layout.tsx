import React from 'react';
import Providers from './providers';

/**
 * RootLayout
 *
 * Arquitetura de providers:
 * - Este layout (server component) importa `Providers` (client component) que configura
 *   React Query (QueryClientProvider), Toaster (sonner) e Devtools em desenvolvimento.
 * - Mantemos o layout mínimo e isolamos providers em `src/app/providers.tsx` para
 *   reduzir re-renderizações e centralizar a configuração de libs globais.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}