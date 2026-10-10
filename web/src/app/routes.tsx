import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { RequireRole } from '@/features/auth/RequireRole';
import { LoginPage } from '@/features/auth/LoginPage';
import { homeFor, useMe } from '@/features/auth/auth';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { AdminLayout } from './AdminLayout';
import { NotFoundPage } from './NotFoundPage';
import { RequireScreen } from './RequireScreen';
import { allNavItems } from './nav';

function Home() {
  const { data: user, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

// Each screen is its own download, fetched the first time it's opened, so
// logging in doesn't load every screen (agents never load admin ones).
function page(load: () => Promise<Record<string, ComponentType>>, name: string) {
  const Screen = lazy(() => load().then((m) => ({ default: m[name] })));
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Screen />
    </Suspense>
  );
}

// Admin screens by nav path (app/nav.ts). app.test.tsx checks every menu entry has one.
const SCREENS: Record<string, RouteObject['element']> = {
  '/admin': page(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage'),
  '/admin/live': page(() => import('@/features/live/LiveAgentsPage'), 'LiveAgentsPage'),
  '/admin/dialer': page(() => import('@/features/dialer/DialerPage'), 'DialerPage'),
  '/admin/calls': page(() => import('@/features/calllog/CallLogPage'), 'CallLogPage'),
  '/admin/campaigns': page(() => import('@/features/campaigns/CampaignsPage'), 'CampaignsPage'),
  '/admin/leads': page(() => import('@/features/leads/LeadsPage'), 'LeadsPage'),
  '/admin/forms': page(() => import('@/features/forms/FormsPage'), 'FormsPage'),
  '/admin/callbacks': page(() => import('@/features/callbacks/CallbacksPage'), 'CallbacksPage'),
  '/admin/dnc': page(() => import('@/features/dnc/DncPage'), 'DncPage'),
  '/admin/queues': page(() => import('@/features/queues/QueuesPage'), 'QueuesPage'),
  '/admin/numbers': page(() => import('@/features/numbers/NumbersPage'), 'NumbersPage'),
  '/admin/users': page(() => import('@/features/users/UsersPage'), 'UsersPage'),
  '/admin/teams': page(() => import('@/features/teams/TeamsPage'), 'TeamsPage'),
  '/admin/roles': page(() => import('@/features/roles/RolesPage'), 'RolesPage'),
  '/admin/audit': page(() => import('@/features/audit/AuditPage'), 'AuditPage'),
  '/admin/reports': page(() => import('@/features/reports/ReportsPage'), 'ReportsPage'),
};

const adminChildren: RouteObject[] = allNavItems().map((item) => {
  const element = <RequireScreen screen={item.screen}>{SCREENS[item.to] ?? <NotFoundPage />}</RequireScreen>;
  return item.to === '/admin' ? { index: true, element } : { path: item.to.replace('/admin/', ''), element };
});

export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/admin',
    element: (
      <RequireRole role={['admin', 'staff']}>
        <AdminLayout />
      </RequireRole>
    ),
    children: [...adminChildren, { path: '*', element: <NotFoundPage /> }],
  },
  {
    path: '/agent',
    element: <RequireRole role="agent">{page(() => import('@/features/agent/AgentPage'), 'AgentPage')}</RequireRole>,
  },
  { path: '*', element: <NotFoundPage /> },
];
