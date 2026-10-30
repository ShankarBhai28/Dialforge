// Live Agents side panel: one agent's status and call, Listen / Whisper /
// Barge through the supervisor's monitoring line (features/monitor), and
// Force logout. Opens from the agent's name (or the headphone icon on a call).
import { useState } from 'react';
import { toast } from 'sonner';
import { Headphones, LoaderCircle, LogOut, PhoneOff, Plug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/common';
import { ERROR_TOAST } from '@/lib/toast';
import { useNow } from '@/lib/hooks';
import { cn, formatSeconds } from '@/lib/utils';
import type { LiveAgent } from '@/features/dashboard/api';
import { AgentStatusBadge } from '@/features/dashboard/AgentStatusBadge';
import { MODE_INFO } from '@/features/monitor/MonitorBar';
import {
  connectMonitorLine,
  disconnectMonitorLine,
  startMonitor,
  stopMonitor,
  switchMode,
  useMonitorLine,
  type MonitorMode,
} from '@/features/monitor/monitorLine';

/** Who hears whom in each mode (the supervisor always hears the call). */
const HEARS: Record<MonitorMode, { agent: boolean; customer: boolean }> = {
  listen: { agent: false, customer: false },
  whisper: { agent: true, customer: false },
  barge: { agent: true, customer: true },
};
const START_LABEL: Record<MonitorMode, string> = {
  listen: 'Start listening',
  whisper: 'Start whispering',
  barge: 'Barge in',
};

function YesNo({ yes }: { yes: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-semibold',
        yes ? 'bg-status-available/12 text-status-available' : 'bg-muted text-slate-600',
      )}
    >
      {yes ? 'Yes' : 'No'}
    </span>
  );
}

export function AgentPanel({
  agent: a,
  callType,
  monitorModes,
  onLogout,
  onClose,
}: {
  agent: LiveAgent;
  /** The Call type tag, as the table shows it. */
  callType: React.ReactNode;
  monitorModes: MonitorMode[];
  onLogout?: (a: LiveAgent) => void;
  onClose: () => void;
}) {
  const now = useNow();
  const line = useMonitorLine();
  const session = line.session;
  const mine = session?.agentId === a.id ? session : null;
  const other = session && !mine ? session : null;
  const [picked, setPicked] = useState<MonitorMode>(monitorModes[0] ?? 'listen');
  const mode = mine ? mine.mode : picked;

  // When this monitor went live (for its timer), and a note when it stops by
  // itself (the call ended) rather than by Stop. Adjusted while rendering when
  // the session changes; the panel remounts per agent (key), so no reset needed.
  const [liveSince, setLiveSince] = useState<number | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [prev, setPrev] = useState(mine);
  if (mine !== prev) {
    setPrev(mine);
    if (mine?.live && !prev?.live) setLiveSince(now);
    if (!mine && prev) {
      setLiveSince(null);
      if (!stopping) setEnded('The call ended - monitoring stopped.');
      setStopping(false);
    }
  }

  const call = a.call ?? null;
  const onCall = !!a.active_call_number;
  const since = a.started_at ? Math.max(0, (now - new Date(a.started_at).getTime()) / 1000) : null;
  const talk = call ? Math.max(0, (now - new Date(call.connectedAt ?? call.startedAt).getTime()) / 1000) : null;
  const lineReady = line.status === 'connected';

  const start = () => {
    setEnded(null);
    startMonitor(a.id, a.username, mode).catch((err: Error) => toast.error(err.message, ERROR_TOAST));
  };
  const stop = () => {
    setStopping(true);
    stopMonitor();
  };
  const pick = (m: MonitorMode) => {
    setPicked(m);
    if (mine?.live) switchMode(m);
  };

  return (
    <aside
      aria-label={`Agent ${a.username}`}
      className="flex flex-col overflow-hidden rounded-lg border bg-card lg:sticky lg:top-4 lg:w-96 lg:shrink-0 lg:self-start"
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 pt-4 pb-3">
        <div className="min-w-0">
          <div className="truncate text-lg font-bold">{a.username}</div>
          <div className="text-sm text-muted-foreground">
            ext {a.extension_name ?? '—'}
            {a.campaign_name && ` · ${a.campaign_name}`}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <AgentStatusBadge status={a.status} onCall={onCall} />
            {a.reason && <span className="text-xs text-muted-foreground">{a.reason}</span>}
            {since !== null && !onCall && (
              <span className="text-sm text-muted-foreground tabular-nums">
                {a.status === 'available' ? 'idle ' : ''}
                {formatSeconds(since)}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close panel" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        {onCall ? (
          <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3">
            <div className="min-w-0">
              <div className="font-semibold tabular-nums">{call?.number ?? a.active_call_number}</div>
              {call?.leadName && <div className="truncate text-sm text-muted-foreground">{call.leadName}</div>}
              <div className="mt-1.5">{callType}</div>
            </div>
            {talk !== null && (
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums">{formatSeconds(talk)}</div>
                <div className="text-xs text-muted-foreground">{call?.connectedAt ? 'talk time' : 'ringing'}</div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {ended ?? 'Not on a call.'}
            {monitorModes.length > 0 && ` Listen, Whisper and Barge show here when ${a.username} is on a call.`}
          </div>
        )}

        {onCall && monitorModes.length > 0 && (
          <section aria-label="Monitor this call" className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Monitor this call</h3>

            {!lineReady && (
              <div className="flex items-center justify-between gap-3 rounded-md bg-status-break/12 px-3 py-2.5 text-sm text-amber-900">
                <span>
                  {line.status === 'connecting'
                    ? 'Connecting your monitoring line…'
                    : 'Your monitoring line is not connected.'}
                </span>
                <Button size="sm" onClick={() => void connectMonitorLine()} disabled={line.status === 'connecting'}>
                  {line.status === 'connecting' ? <LoaderCircle className="animate-spin" /> : <Plug />} Connect line
                </Button>
              </div>
            )}

            <div
              role="radiogroup"
              aria-label="Monitoring mode"
              className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
            >
              {monitorModes.map((m) => {
                const Icon = MODE_INFO[m].icon;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => pick(m)}
                    className={cn(
                      'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-sm text-sm font-semibold [&_svg]:size-4',
                      mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon /> {MODE_INFO[m].label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col gap-2 rounded-md border px-4 py-3 text-sm" aria-label="Who hears whom">
              <p className="text-slate-700">{MODE_INFO[mode].hint}.</p>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">You hear the call</span>
                <YesNo yes />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">The agent hears you</span>
                <YesNo yes={HEARS[mode].agent} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">The customer hears you</span>
                <YesNo yes={HEARS[mode].customer} />
              </div>
            </div>

            {mine && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-status-available bg-status-available/5 px-3 py-2.5 text-sm font-semibold text-status-available"
              >
                {mine.live ? (
                  <>
                    <span className="size-2 rounded-full bg-status-available" />
                    {MODE_INFO[mine.mode].doing} {a.username}
                    {liveSince !== null && (
                      <span className="tabular-nums"> · {formatSeconds((now - liveSince) / 1000)}</span>
                    )}
                  </>
                ) : (
                  <>
                    <LoaderCircle className="size-4 animate-spin" /> Connecting - your line rings and answers by itself…
                  </>
                )}
              </div>
            )}

            {mine ? (
              <Button variant="destructive" size="lg" onClick={stop}>
                <PhoneOff /> Stop
              </Button>
            ) : (
              <Button
                size="lg"
                className={cn(mode === 'barge' && 'bg-amber-700 hover:bg-amber-800')}
                disabled={!lineReady || !!other}
                onClick={start}
              >
                <Headphones /> {START_LABEL[mode]}
              </Button>
            )}
            {other && (
              <p className="text-xs text-muted-foreground">
                You are monitoring {other.agent} - stop that first (open {other.agent}, or Stop in the bar above).
              </p>
            )}
          </section>
        )}

        {line.error && (
          <p role="alert" className="text-xs text-destructive">
            {line.error}
          </p>
        )}
      </div>

      {(onLogout && a.status) || lineReady ? (
        <div className="flex flex-col gap-2 border-t px-5 py-3">
          {onLogout && a.status && (
            <Button
              variant="outline"
              className="text-destructive"
              disabled={onCall}
              title={onCall ? 'Not possible during a call' : undefined}
              onClick={() => onLogout(a)}
            >
              <LogOut /> Force logout {a.username}
            </Button>
          )}
          {lineReady && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                <StatusPill tone="green">Line {line.extension}</StatusPill> monitoring line connected
              </span>
              <button
                type="button"
                className="cursor-pointer underline hover:text-foreground"
                onClick={() => {
                  if (mine) setStopping(true);
                  disconnectMonitorLine();
                }}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
