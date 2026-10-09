import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { LogOut, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout, useMe } from '@/features/auth/auth';
import { cn } from '@/lib/utils';
import { allNavItems } from './nav';
import { Sidebar } from './Sidebar';

function usePageTitle() {
  const { pathname } = useLocation();
  const item = allNavItems().find((i) => i.to === pathname);
  return item?.label ?? 'DialForge';
}

export function AdminLayout() {
  const { data: user } = useMe();
  const logout = useLogout();
  const title = usePageTitle();
  // Phone drawer; the sidebar closes it when a screen is picked.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.title = `${title} · DialForge`;
  }, [title]);

  return (
    <div className="flex h-full">
      {/* Desktop: fixed sidebar. Phone: slide-in drawer. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 lg:block">
        <Sidebar />
      </aside>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden',
          menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setMenuOpen(false)}
        aria-hidden
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 transition-transform lg:hidden',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-hidden={!menuOpen}
      >
        <Sidebar onNavigate={() => setMenuOpen(false)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
          >
            {menuOpen ? <X /> : <Menu />}
          </Button>
          <h1 className="flex-1 truncate text-lg font-bold">{title}</h1>
          <div className="hidden text-right text-sm leading-tight sm:block">
            <div className="font-semibold">{user?.username}</div>
            <div className="text-xs text-muted-foreground capitalize">{user?.role}</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut /> <span className="hidden sm:inline">Log out</span>
          </Button>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
