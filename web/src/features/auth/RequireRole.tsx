import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { startRealtime } from '@/lib/realtime';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { ErrorState } from '@/components/ErrorState';
import { homeFor, useMe, type Role } from './auth';

/** Renders children only for a logged-in user with this role (or one of these). */
export function RequireRole({ role, children }: { role: Role | Role[]; children: ReactNode }) {
  const { data: user, isPending, error, refetch } = useMe();
  const location = useLocation();
  const roles = Array.isArray(role) ? role : [role];
  const allowed = !!user && roles.includes(user.role);

  useEffect(() => {
    if (allowed) startRealtime();
  }, [allowed]);

  if (isPending) return <FullPageSpinner />;
  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (!allowed) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}
