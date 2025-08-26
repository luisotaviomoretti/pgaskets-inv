import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import InventoryWireframe from '@/features/inventory/pages/Wireframe';
import { AuthProvider } from '@/components/auth/AuthContext';
import LoginPage from '@/components/auth/LoginPage';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          {/* Redirect root to app */}
          <Route path="/" element={<Navigate to="/app" replace />} />
          
          {/* Login route */}
          <Route path="/login" element={<LoginPage />} />
          
          {/* Protected app route */}
          <Route 
            path="/app" 
            element={
              <ProtectedRoute>
                <InventoryWireframe />
              </ProtectedRoute>
            } 
          />
          
          {/* Catch all - redirect to app */}
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

const queryClient = new QueryClient();

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <Analytics />
  </QueryClientProvider>
);
