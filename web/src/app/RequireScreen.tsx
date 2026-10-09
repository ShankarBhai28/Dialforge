// Shows an admin screen only when the user's role includes it. The menu
// already hides the others; this covers typed-in or bookmarked addresses.
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ShieldOff } from 'lucide-react';
import { useAccess, type NavScreen } from '@/features/auth/access';
import { allNavItems } from './nav';

export function RequireScreen({ screen, children }: { screen: NavScreen; children: ReactNode }) {
  const { canView } = useAccess();
  if (canView(screen)) return children;
  // The dashboard is the admin home: without it, go to the first screen the role has.
  const first = allNavItems().find((i) => canView(i.screen));
  if (screen === 'dashboard' && first) return <Navigate to={first.to} replace />;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <ShieldOff className="size-10 text-muted-foreground" />
      <p className="font-semibold">Your role doesn&apos;t include this screen.</p>
      <p className="text-sm text-muted-foreground">Ask your Super Admin if you need it.</p>
    </div>
  );
}
