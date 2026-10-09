import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAccess } from '@/features/auth/access';
import { isGroup, visibleNav, type NavGroup, type NavItem } from './nav';

const OPEN_KEY = 'dialforge.nav.open';

function loadOpen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '["campaign"]');
    return Array.isArray(v) ? v : ['campaign'];
  } catch {
    return ['campaign'];
  }
}

function saveOpen(keys: string[]) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(keys));
  } catch {
    /* private mode - fine */
  }
}

const groupHasPath = (g: NavGroup, path: string) => g.items.some((i) => path === i.to || path.startsWith(i.to + '/'));

function Item({ item, nested, onNavigate }: { item: NavItem; nested?: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/admin'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white',
          nested ? 'px-3 py-2 text-[13px]' : 'px-3.5 py-2.5 text-sm',
          isActive && 'bg-white/15 text-white',
        )
      }
    >
      <Icon className={nested ? 'size-4' : 'size-[18px]'} />
      {item.label}
    </NavLink>
  );
}

/** Admin sidebar: click a group heading to show or hide its screens. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { canView } = useAccess();
  const nav = visibleNav(canView);
  const [open, setOpen] = useState<string[]>(loadOpen);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // On arriving at a screen, open its group (the user can still close it).
  // Adjusting state during render, not in an effect, avoids a second paint.
  if (openedFor !== pathname) {
    setOpenedFor(pathname);
    const active = nav.find((e): e is NavGroup => isGroup(e) && groupHasPath(e, pathname));
    if (active && !open.includes(active.key)) setOpen([...open, active.key]);
  }

  useEffect(() => saveOpen(open), [open]);

  function toggle(key: string) {
    setOpen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  return (
    <nav aria-label="Admin" className="flex h-full flex-col bg-gradient-to-b from-ink to-ink-2 px-3 py-5 text-white">
      <div className="mb-6 flex items-center gap-2.5 px-3 text-lg font-extrabold">
        <span className="size-2.5 rounded-full bg-teal-400 shadow-[0_0_12px] shadow-teal-400" />
        DialForge
      </div>

      <div className="-mx-1 flex-1 space-y-0.5 overflow-y-auto px-1">
        {nav.map((entry) => {
          if (!isGroup(entry)) return <Item key={entry.to} item={entry} onNavigate={onNavigate} />;
          const isOpen = open.includes(entry.key);
          const hasActive = groupHasPath(entry, pathname);
          const Icon = entry.icon;
          return (
            <div key={entry.key}>
              <button
                type="button"
                onClick={() => toggle(entry.key)}
                aria-expanded={isOpen}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-md px-3.5 py-2.5 text-left text-sm font-bold text-white/85 transition-colors hover:bg-white/10 hover:text-white',
                  hasActive && !isOpen && 'bg-white/10 text-white',
                )}
              >
                <Icon className="size-[18px]" />
                <span className="flex-1">{entry.label}</span>
                <ChevronRight className={cn('size-4 opacity-70 transition-transform', isOpen && 'rotate-90')} />
              </button>
              {isOpen && (
                <div className="mt-0.5 mb-1.5 ml-4 space-y-0.5 border-l border-white/15 pl-2">
                  {entry.items.map((item) => (
                    <Item key={item.to} item={item} nested onNavigate={onNavigate} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
