import { Navigate, type RouteObject } from 'react-router';
import { RequireRole } from '@/features/auth/RequireRole';
import { LoginPage } from '@/features/auth/LoginPage';
import { homeFor, useMe } from '@/features/auth/auth';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { NumbersPage } from '@/features/numbers/NumbersPage';
import { LiveAgentsPage } from '@/features/live/LiveAgentsPage';
import { DialerPage } from '@/features/dialer/DialerPage';
import { CallLogPage } from '@/features/calllog/CallLogPage';
import { CampaignsPage } from '@/features/campaigns/CampaignsPage';
import { LeadsPage } from '@/features/leads/LeadsPage';
import { FormsPage } from '@/features/forms/FormsPage';
import { CallbacksPage } from '@/features/callbacks/CallbacksPage';
import { DncPage } from '@/features/dnc/DncPage';
import { QueuesPage } from '@/features/queues/QueuesPage';
import { UsersPage } from '@/features/users/UsersPage';
import { TeamsPage } from '@/features/teams/TeamsPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
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

// Admin screens by nav path. A screen missing here shows a link to the
// classic admin instead (how screens were moved one by one in Stage 3).
const REBUILT: Record<string, RouteObject['element']> = {
  '/admin': <DashboardPage />,
  '/admin/live': <LiveAgentsPage />,
  '/admin/dialer': <DialerPage />,
  '/admin/calls': <CallLogPage />,
  '/admin/campaigns': <CampaignsPage />,
  '/admin/leads': <LeadsPage />,
  '/admin/forms': <FormsPage />,
  '/admin/callbacks': <CallbacksPage />,
  '/admin/dnc': <DncPage />,
  '/admin/queues': <QueuesPage />,
  '/admin/numbers': <NumbersPage />,
  '/admin/users': <UsersPage />,
  '/admin/teams': <TeamsPage />,
  '/admin/reports': <ReportsPage />,
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
