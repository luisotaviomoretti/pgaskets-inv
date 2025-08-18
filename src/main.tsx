import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InventoryWireframe from '@/features/inventory/pages/Wireframe';

function App() {
  return (
    <InventoryWireframe />
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

const queryClient = new QueryClient();

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
