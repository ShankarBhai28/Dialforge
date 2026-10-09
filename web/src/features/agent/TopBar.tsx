import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Clock,
  Coffee,
  ExternalLink,
  Headset,
  LogOut,
  PhoneOff,
  Timer,
  Users2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLogout, useMe } from '@/features/auth/auth';
import type { AgentStats } from './api';
import { useController, usePhone } from './AgentProvider';
import { EXTENSION_KEY } from './ConnectLine';

const BREAK_REASONS = ['Meeting', 'Lunch', 'Tea Break'];

/** 3725 -> "01:02:05" (the classic tiles' format). */
export const hms = (total: number) =>
  [Math.floor(total / 3600), Math.floor((total % 3600) / 60), Math.floor(total % 60)]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

function pillFor(stats: AgentStats | undefined) {
  switch (stats?.currentStatus) {
    case 'available':
      return {
        text: stats.currentQueueName ? `Available - ${stats.currentQueueName}` : 'Available',
        cls: 'bg-status-available',
        pulse: true,
      };
    case 'break':
      return { text: stats.currentReason || 'Break', cls: 'bg-status-break', pulse: false };
    case 'acw':
      return { text: 'ACW - Wrapping Up', cls: 'bg-status-acw', pulse: false };
    default:
      return { text: 'Offline', cls: 'bg-status-offline', pulse: false };
  }
}

function StatusMenu({ stats }: { stats: AgentStats | undefined }) {
  const { controller } = useController();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pill = pillFor(stats);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (status: 'available' | 'break', reason?: string) => {
    setOpen(false);
    void controller.setStatus(status, reason);
  };
  const item = 'flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-sm hover:bg-muted';
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold text-white',
          pill.cls,
        )}
      >
        <span className={cn('size-2 rounded-full bg-white', pill.pulse && 'animate-pulse')} />
        <span className="max-w-48 truncate">{pill.text}</span>
        <ChevronDown className="size-4 opacity-80" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-lg border bg-card py-1 shadow-xl"
        >
          <button role="menuitem" className={item} onClick={() => choose('available')}>
            <span className="size-2 rounded-full bg-status-available" /> Available
          </button>
          {BREAK_REASONS.map((r) => (
            <button key={r} role="menuitem" className={item} onClick={() => choose('break', r)}>
              <span className="size-2 rounded-full bg-status-break" /> Break — {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({ stats }: { stats: AgentStats | undefined }) {
  const { data: me } = useMe();
  const { line } = usePhone();
  const { controller, state } = useController();
  const logout = useLogout();

  function onLogout() {
    controller.shutdown();
    try {
      localStorage.removeItem(EXTENSION_KEY);
    } catch {
      /* private mode */
    }
    logout.mutate();
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 bg-gradient-to-r from-ink to-ink-2 px-4 text-white">
      <div className="flex items-center gap-2 font-extrabold">
        <span className="size-2.5 rounded-full bg-teal-400 shadow-[0_0_12px] shadow-teal-400" />
        <span className="hidden sm:inline">DialForge</span>
      </div>
      <div className="flex-1" />
      <div className="hidden items-center gap-1.5 text-sm tabular-nums text-white/80 md:flex" title="Logged in today">
        <Clock className="size-4" /> {hms(stats?.loginSeconds ?? 0)}
      </div>
      {state.call && (
        <Button variant="destructive" size="sm" onClick={() => controller.hangup()}>
          <PhoneOff /> Hang up
        </Button>
      )}
      <StatusMenu stats={stats} />
      <div className="hidden text-right text-xs leading-tight lg:block">
        <div className="font-semibold">{me?.username}</div>
        <div className="text-white/70">ext {line.extension}</div>
      </div>
      <a href="/agent.html" className="hidden text-xs text-white/60 hover:text-white xl:flex xl:items-center xl:gap-1">
        <ExternalLink className="size-3.5" /> Classic
      </a>
      <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={onLogout}>
        <LogOut /> <span className="hidden sm:inline">Log out</span>
      </Button>
    </header>
  );
}

const TILES: { key: keyof AgentStats; label: string; icon: LucideIcon; cls: string }[] = [
  { key: 'loginSeconds', label: 'Login Time', icon: Clock, cls: 'bg-accent text-accent-foreground' },
  { key: 'talkSeconds', label: 'Talk Time', icon: Headset, cls: 'bg-status-talk/12 text-status-talk' },
  { key: 'breakSeconds', label: 'Break Time', icon: Coffee, cls: 'bg-status-break/12 text-status-break' },
  { key: 'handleSeconds', label: 'Handle Time', icon: Users2, cls: 'bg-status-available/12 text-status-available' },
  { key: 'acwSeconds', label: 'ACW Time', icon: Timer, cls: 'bg-status-acw/12 text-status-acw' },
];

export function Tiles({ stats }: { stats: AgentStats | undefined }) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map(({ key, label, icon: Icon, cls }) => (
        <div key={key} className="flex items-center gap-3 rounded-lg bg-card p-3 shadow-card">
          <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', cls)}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs text-muted-foreground">{label}</div>
            <div className="font-bold tabular-nums">{hms(Number(stats?.[key] ?? 0))}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
