import { Navigate, type RouteObject } from 'react-router';
import { RequireRole } from '@/features/auth/RequireRole';
import { LoginPage } from '@/features/auth/LoginPage';
import { homeFor, useMe } from '@/features/auth/auth';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { NumbersPage } from '@/features/numbers/NumbersPage';
import { ClassicScreenPage } from '@/features/placeholder/ClassicScreenPage';
import { AgentHomePage } from '@/features/agent/AgentHomePage';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { AdminLayout } from './AdminLayout';
import { NotFoundPage } from './NotFoundPage';
import { allNavItems } from './nav';

function Home() {
  const { data: user, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

// Admin screens not rebuilt yet point to the classic page. Each one is
// replaced by its real page as it moves (docs/APP_REBUILD_PLAN.md, Stage 3).
const REBUILT: Record<string, RouteObject['element']> = {
  '/admin': <DashboardPage />,
  '/admin/numbers': <NumbersPage />,
};

const adminChildren: RouteObject[] = allNavItems().map((item) => {
  const element = REBUILT[item.to] ?? <ClassicScreenPage item={item} />;
  return item.to === '/admin' ? { index: true, element } : { path: item.to.replace('/admin/', ''), element };
});

export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/admin',
    element: (
      <RequireRole role="admin">
        <AdminLayout />
      </RequireRole>
    ),
    children: [...adminChildren, { path: '*', element: <NotFoundPage /> }],
  },
  {
    path: '/agent',
    element: (
      <RequireRole role="agent">
        <AgentHomePage />
      </RequireRole>
    ),
  },
  { path: '*', element: <NotFoundPage /> },
];
