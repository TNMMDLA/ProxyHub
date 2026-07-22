import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError } from './api';
import { AppShell } from './components/AppShell';
import { QueryErrorState } from './components/ui';
import { AuthPage } from './pages/AuthPage';
import type { Admin } from './types';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const NodesPage = lazy(() => import('./pages/NodesPage'));
const PoolsPage = lazy(() => import('./pages/PoolsPage'));
const ServersPage = lazy(() => import('./pages/ServersPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));

function ScreenLoader() {
  return (
    <div className="screen-loader">
      <span />
    </div>
  );
}

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Admin>('/auth/me'),
    retry: (count, error) =>
      !(error instanceof ApiError && error.code === 'AUTH_REQUIRED') && count < 1,
  });
  if (me.isLoading) return <ScreenLoader />;
  if (me.isError && !(me.error instanceof ApiError && me.error.code === 'AUTH_REQUIRED')) {
    return <QueryErrorState error={me.error} fullPage onRetry={() => void me.refetch()} />;
  }
  if (!me.data) return <AuthPage />;
  return (
    <Routes>
      <Route element={<AppShell admin={me.data} />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/dashboard"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <DashboardPage />
            </Suspense>
          }
        />
        <Route
          path="/servers"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <ServersPage />
            </Suspense>
          }
        />
        <Route
          path="/nodes"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <NodesPage />
            </Suspense>
          }
        />
        <Route
          path="/node-pools"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <PoolsPage />
            </Suspense>
          }
        />
        <Route
          path="/security"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <SecurityPage admin={me.data} />
            </Suspense>
          }
        />
        <Route
          path="/notifications"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <ActivityPage mode="notifications" />
            </Suspense>
          }
        />
        <Route
          path="/audit-logs"
          element={
            <Suspense fallback={<ScreenLoader />}>
              <ActivityPage mode="audit" />
            </Suspense>
          }
        />
        <Route path="/settings" element={<Navigate to="/security" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
