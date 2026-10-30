// Live Agents: every agent's current status, queue and active call.
// Same data as the Dashboard's live table (GET /admin/live-agents), so the
// query, its cache key and the status badge are reused from features/dashboard.
// - One line per agent; Columns adds queue, team, extra queues, today, login
//   (remembered per browser). Call type: inbound / manual / dialer mode /
//   callback / transfer (backend services/liveFloor.js callType).
// - Filters: status (default: logged-in agents only), name / extension, queue.
// - Clicking an agent (or the headphone icon of one on a call) opens their
//   side panel (AgentPanel.tsx): call details, Listen / Whisper / Barge
//   through the supervisor's monitoring line (features/monitor), Force logout.
// - Force logout takes a stuck or absent agent offline (not during a call).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Columns3, Headphones, RefreshCw, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { post } from '@/lib/api';
import { useAccess } from '@/features/auth/access';
import { ErrorState } from '@/components/ErrorState';
import { formatTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { cn, formatSeconds } from '@/lib/utils';
import { dashboardKeys, useFloorSummary, useLiveAgents, type LiveAgent } from '@/features/dashboard/api';
import { AgentStatusBadge } from '@/features/dashboard/AgentStatusBadge';
import { MODE_INFO, MonitorStrip } from '@/features/monitor/MonitorBar';
import { useMonitorLine } from '@/features/monitor/monitorLine';
import { AgentPanel } from './AgentPanel';

const KNOWN = new Set(['available', 'break', 'acw']);

/** Bucket an agent the same way the badge does: a live call beats the status. */
function bucket(a: LiveAgent) {
  if (a.active_call_number) return 'talk';
  return a.status ?? 'offline';
}

/** Status filter: 'loggedin' = everyone who isn't offline. */
type StatusFilter = 'loggedin' | 'all' | 'available' | 'talk' | 'break' | 'acw' | 'offline';
const STATUS_FILTERS: { value: StatusFilter; label: string; tone?: 'green' | 'blue' | 'amber' | 'grey' }[] = [
  { value: 'loggedin', label: 'Logged in' },
  { value: 'available', label: 'Available', tone: 'green' },
  { value: 'talk', label: 'On call', tone: 'blue' },
  { value: 'break', label: 'Break', tone: 'amber' },
  { value: 'acw', label: 'Wrap-up', tone: 'amber' },
  { value: 'offline', label: 'Offline', tone: 'grey' },
  { value: 'all', label: 'All agents' },
];
const matchesStatus = (a: LiveAgent, f: StatusFilter) =>
  f === 'all' ? true : f === 'loggedin' ? bucket(a) !== 'offline' : bucket(a) === f;

const FILTER_KEY = 'dialforge.live.status';
function savedFilter(): StatusFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY) as StatusFilter | null;
    return v && STATUS_FILTERS.some((f) => f.value === v) ? v : 'loggedin';
  } catch {
    return 'loggedin';
  }
}

/** The status counts double as quick filters. */
function Counts({
  agents,
  value,
  onChange,
}: {
  agents: LiveAgent[];
  value: StatusFilter;
  onChange: (f: StatusFilter) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Agents by status">
      {STATUS_FILTERS.filter((f) => f.tone).map((f) => {
        const n = agents.filter((a) => bucket(a) === f.value).length;
        return (
          <button
            key={f.value}
            type="button"
            aria-pressed={value === f.value}
            onClick={() => onChange(value === f.value ? 'loggedin' : f.value)}
            className={cn('cursor-pointer rounded-full', value === f.value && 'ring-2 ring-primary ring-offset-1')}
          >
            <StatusPill tone={f.tone!}>
              {f.label}: {n}
            </StatusPill>
          </button>
        );
      })}
    </div>
  );
}

/** An agent without a campaign: the campaign defaults (migration 0022). */
const DEFAULT_WARN = { breakWarnMin: 10, breakAlertMin: 15, acwWarnSec: 60 };

type CallType = NonNullable<NonNullable<LiveAgent['call']>['type']>;
const CALL_TYPE: Record<CallType, { label: string; className: string }> = {
  inbound: { label: 'Inbound', className: 'bg-sky-500/12 text-sky-800' },
  manual: { label: 'Manual', className: 'bg-muted text-slate-700' },
  predictive: { label: 'Predictive', className: 'bg-accent text-accent-foreground' },
  progressive: { label: 'Progressive', className: 'bg-accent text-accent-foreground' },
  preview: { label: 'Preview', className: 'bg-accent text-accent-foreground' },
  callback: { label: 'Callback', className: 'bg-status-break/15 text-amber-800' },
  transfer: { label: 'Transfer', className: 'bg-violet-500/10 text-violet-800' },
};
/** Older servers send only `kind`. */
function callType(call: NonNullable<LiveAgent['call']>): CallType {
  return call.type ?? (call.kind === 'inbound' ? 'inbound' : call.kind === 'dialer' ? 'predictive' : 'manual');
}

/** Columns a supervisor can add with the Columns button; the rest are always shown. */
type OptionalColumn = 'queue' | 'teams' | 'extra' | 'today' | 'login';
const OPTIONAL_COLUMNS: { key: OptionalColumn; label: string }[] = [
  { key: 'queue', label: 'Queue' },
  { key: 'teams', label: 'Team' },
  { key: 'extra', label: 'Extra queues' },
  { key: 'today', label: 'Today (calls, talk, AHT)' },
  { key: 'login', label: 'Logged in at' },
];
const COLUMNS_KEY = 'dialforge.live.columns';
function savedColumns(): Set<OptionalColumn> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? OPTIONAL_COLUMNS.map((c) => c.key).filter((k) => v.includes(k)) : []);
  } catch {
    return new Set();
  }
}

function ColumnsMenu({ shown, onToggle }: { shown: Set<OptionalColumn>; onToggle: (c: OptionalColumn) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Columns3 /> Columns{shown.size > 0 && ` (+${shown.size})`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          Always shown: agent, status and time, extension, campaign, call type, current call
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONAL_COLUMNS.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={shown.has(c.key)}
            onCheckedChange={() => onToggle(c.key)}
            onSelect={(e) => e.preventDefault()} // stays open to tick several
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Time in status: amber / red when a break or wrap-up runs past the campaign's warning times. */
function statusTone(a: LiveAgent, seconds: number | null) {
  if (seconds === null || a.active_call_number) return '';
  const w = a.warn ?? DEFAULT_WARN;
  if (a.status === 'break') {
    if (seconds > w.breakAlertMin * 60) return 'font-semibold text-destructive';
    if (seconds > w.breakWarnMin * 60) return 'font-semibold text-status-break';
  }
  if (a.status === 'acw' && seconds > (a.wrapup_sec ?? 0) + w.acwWarnSec) return 'font-semibold text-destructive';
  return 'text-muted-foreground';
}

/** Above the table: callers waiting for an agent now, and today's floor totals. */
function FloorBar() {
  const floor = useFloorSummary();
  const f = floor.data;
  if (!f) return null;
  const waitingTone = f.waiting === 0 ? 'green' : (f.longestWaitSeconds ?? 0) > 60 ? 'red' : 'amber';
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-muted/30 px-4 py-3"
      aria-label="Floor"
    >
      <div>
        <div className="text-xs font-medium text-muted-foreground">Callers waiting</div>
        <div className="flex items-center gap-2">
          <StatusPill tone={waitingTone}>{f.waiting === 0 ? 'None' : `${f.waiting} waiting`}</StatusPill>
          {f.longestWaitSeconds !== null && f.waiting > 0 && (
            <span className="text-sm tabular-nums">longest {formatSeconds(f.longestWaitSeconds)}</span>
          )}
        </div>
        {f.waiting > 0 && (
          <div className="text-xs text-muted-foreground">
            {f.waitingInbound} inbound · {f.waitingDialer} dialer
          </div>
        )}
      </div>
      <div>
        <div className="text-xs font-medium text-muted-foreground">Today</div>
        <div className="text-sm tabular-nums">
          <b>{f.today.calls}</b> calls · <b>{f.today.connected}</b> connected · talk{' '}
          <b>{formatSeconds(f.today.talkSeconds)}</b>
        </div>
      </div>
    </div>
  );
}

const LINE_DOT: Record<string, [string, string, string]> = {
  registered: ['bg-status-available', 'phone line connected', 'Phone line connected'],
  unregistered: [
    'bg-destructive',
    'phone line not connected',
    'Phone line NOT connected - calls cannot reach this agent',
  ],
  unknown: ['bg-muted-foreground/40', 'phone line unknown', 'Line state unknown'],
};

const DASH = <span className="text-muted-foreground">—</span>;

function CallTypeTag({ call }: { call: NonNullable<LiveAgent['call']> }) {
  const type = CALL_TYPE[callType(call)];
  return (
    <span className={cn('inline-block rounded-md px-2 py-0.5 text-xs font-semibold', type.className)}>
      {type.label}
    </span>
  );
}

function AgentsTable({
  agents,
  columns,
  canMonitor,
  selectedId,
  onOpen,
}: {
  agents: LiveAgent[];
  columns: Set<OptionalColumn>;
  /** The supervisor may listen / whisper / barge: on-call rows get the headphone icon. */
  canMonitor: boolean;
  selectedId: number | null;
  onOpen: (id: number) => void;
}) {
  const now = useNow();
  const line = useMonitorLine();
  const ago = (iso: string | null | undefined) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : null);
  const col = (c: OptionalColumn) => columns.has(c);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="whitespace-nowrap">
            <TableHead>Agent</TableHead>
            {col('teams') && <TableHead>Team</TableHead>}
            <TableHead>Status · time</TableHead>
            <TableHead>Ext</TableHead>
            <TableHead>Campaign</TableHead>
            {col('queue') && <TableHead>Queue</TableHead>}
            {col('extra') && <TableHead>Extra queues</TableHead>}
            <TableHead>Call type</TableHead>
            <TableHead>Current call</TableHead>
            {col('today') && <TableHead>Today</TableHead>}
            {col('login') && <TableHead>Logged in</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((a) => {
            const since = a.status ? ago(a.started_at) : null;
            const monitored = line.session?.agentId === a.id ? line.session : null;
            const selected = a.id === selectedId;
            const call = a.call ?? null;
            const callSecs = call ? ago(call.connectedAt ?? call.startedAt) : null;
            // On a call the timer is the call's; Available = idle time; else time in the status.
            const timer =
              call && callSecs !== null
                ? `${call.connectedAt ? 'talk' : 'ringing'} ${formatSeconds(callSecs)}`
                : since !== null
                  ? `${a.status === 'available' && !a.active_call_number ? 'idle ' : ''}${formatSeconds(since)}`
                  : null;
            const dot = a.line ? (LINE_DOT[a.line] ?? LINE_DOT.unknown) : null;
            return (
              <TableRow
                key={a.id}
                aria-selected={selected}
                className={cn(
                  'whitespace-nowrap',
                  monitored && 'bg-status-available/5',
                  selected && 'bg-accent/40 shadow-[inset_3px_0_0_var(--color-primary)]',
                )}
              >
                <TableCell className="py-1">
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      className="min-h-9 cursor-pointer font-semibold hover:underline"
                      onClick={() => onOpen(a.id)}
                    >
                      {a.username}
                    </button>
                    {canMonitor && a.active_call_number && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-primary"
                        aria-label={`Monitor ${a.username}`}
                        title="Listen / Whisper / Barge"
                        onClick={() => onOpen(a.id)}
                      >
                        <Headphones />
                      </Button>
                    )}
                    {monitored && (
                      <span className="rounded-full bg-status-available/12 px-2 py-0.5 text-[11px] font-semibold text-status-available">
                        {monitored.live ? MODE_INFO[monitored.mode].label.toLowerCase() : 'connecting…'}
                      </span>
                    )}
                  </span>
                </TableCell>
                {col('teams') && <TableCell className="text-muted-foreground">{a.teams ?? DASH}</TableCell>}
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    {/* A status the badge doesn't know is shown as-is, like the classic page. */}
                    {a.status && !KNOWN.has(a.status) && !a.active_call_number ? (
                      <StatusPill tone="grey">{a.status}</StatusPill>
                    ) : (
                      <AgentStatusBadge status={a.status} onCall={!!a.active_call_number} />
                    )}
                    {a.reason && <span className="text-xs text-muted-foreground">{a.reason}</span>}
                    {timer && (
                      <span
                        className={cn('text-sm tabular-nums', statusTone(a, since))}
                        title={a.started_at ? `In this status since ${formatTime(a.started_at)}` : undefined}
                      >
                        {timer}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {a.extension_name ?? DASH}
                  {dot && (
                    <span
                      className={cn('ml-2 inline-block size-2 rounded-full align-middle', dot[0])}
                      role="img"
                      aria-label={dot[1]}
                      title={dot[2]}
                    />
                  )}
                </TableCell>
                <TableCell>{a.campaign_name ?? DASH}</TableCell>
                {col('queue') && <TableCell>{a.queue_name ?? DASH}</TableCell>}
                {col('extra') && <TableCell className="text-muted-foreground">{a.extra_queues ?? DASH}</TableCell>}
                <TableCell>{call ? <CallTypeTag call={call} /> : DASH}</TableCell>
                <TableCell className="max-w-64 truncate">
                  {call ? (
                    <>
                      <span className="tabular-nums">{call.number}</span>
                      {call.leadName && <span className="text-muted-foreground"> · {call.leadName}</span>}
                    </>
                  ) : (
                    (a.active_call_number ?? DASH)
                  )}
                </TableCell>
                {col('today') && (
                  <TableCell className="text-sm tabular-nums">
                    {a.today ? (
                      <>
                        {a.today.calls} calls · talk {formatSeconds(a.today.talkSeconds)}
                        {a.today.avgHandleSeconds !== null && <> · AHT {formatSeconds(a.today.avgHandleSeconds)}</>}
                      </>
                    ) : (
                      DASH
                    )}
                  </TableCell>
                )}
                {col('login') && (
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {a.login_at ? formatTime(a.login_at) : DASH}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function LiveAgentsPage() {
  const qc = useQueryClient();
  const agents = useLiveAgents();
  const { can } = useAccess();

  // Instant refresh on any status change or call event; the query's own
  // interval is only the safety net.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: dashboardKeys.liveAgents });
    void qc.invalidateQueries({ queryKey: dashboardKeys.floor });
  };
  useRealtime('agent.status', refresh);
  useRealtime('call.event', refresh);

  // --- filters ---
  const [status, setStatusState] = useState<StatusFilter>(savedFilter);
  const setStatus = (f: StatusFilter) => {
    setStatusState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* private mode */
    }
  };
  const [columns, setColumns] = useState<Set<OptionalColumn>>(savedColumns);
  const toggleColumn = (c: OptionalColumn) => {
    const next = new Set(columns);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setColumns(next);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify([...next]));
    } catch {
      /* private mode */
    }
  };
  const [q, setQ] = useState('');
  const [queue, setQueue] = useState('');
  const [campaign, setCampaign] = useState('');
  const all = agents.data ?? [];
  const queues = [
    ...new Set(
      all.flatMap((a) => [a.queue_name, ...(a.extra_queues ?? '').split(', ')]).filter((x): x is string => !!x),
    ),
  ].sort();
  const campaigns = [...new Set(all.map((a) => a.campaign_name).filter((x): x is string => !!x))].sort();
  const term = q.trim().toLowerCase();
  const shown = all.filter(
    (a) =>
      matchesStatus(a, status) &&
      (!term || a.username.toLowerCase().includes(term) || (a.extension_name ?? '').includes(term)) &&
      (!queue || a.queue_name === queue || (a.extra_queues ?? '').split(', ').includes(queue)) &&
      (!campaign || a.campaign_name === campaign),
  );

  // --- monitoring ---
  const monitorModes = (['listen', 'whisper', 'barge'] as const).filter((m) => can('live', m));
  // The agent whose side panel is open (kept while filters hide them).
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = all.find((a) => a.id === selectedId) ?? null;

  // --- force logout ---
  const canLogout = can('live', 'logout');
  const [loggingOut, setLoggingOut] = useState<LiveAgent | null>(null);
  const logout = useMutation({
    mutationFn: (id: number) => post(`/admin/live-agents/${id}/logout`),
    meta: { errorInline: true },
    onSuccess: () => {
      toast.success(`${loggingOut?.username} logged out`);
      setLoggingOut(null);
      void refresh();
    },
  });

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Live agents"
          description="Who is doing what right now. Time = how long in the current status: idle when Available, talk time on a call. Updates live."
          actions={
            <>
              <ColumnsMenu shown={columns} onToggle={toggleColumn} />
              <Button variant="outline" onClick={() => agents.refetch()} disabled={agents.isFetching}>
                <RefreshCw className={agents.isFetching ? 'animate-spin' : undefined} /> Refresh
              </Button>
            </>
          }
        />
        <MonitorStrip openAgentId={selected?.id ?? null} onOpen={setSelectedId} />
        {agents.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : agents.error ? (
          <ErrorState message={agents.error.message} onRetry={() => agents.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState icon={Users} title="No agents found">
            Create agent accounts under Users; they show here once they exist.
          </EmptyState>
        ) : (
          <>
            <FloorBar />
            <Counts agents={all} value={status} onChange={setStatus} />
            <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search agent"
                  placeholder="Agent or extension"
                  className="pl-9"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <Select aria-label="Filter by campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">All campaigns</option>
                {campaigns.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
                <option value="">All queues</option>
                {queues.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                {shown.length === 0 ? (
                  <EmptyState icon={Users} title={status === 'loggedin' ? 'No agent is logged in' : 'No agent matches'}>
                    {status === 'loggedin' && 'Choose "All agents" to see everyone.'}
                  </EmptyState>
                ) : (
                  <AgentsTable
                    agents={shown}
                    columns={columns}
                    canMonitor={monitorModes.length > 0}
                    selectedId={selected?.id ?? null}
                    onOpen={(id) => setSelectedId(id === selectedId ? null : id)}
                  />
                )}
              </div>
              {selected && (
                <AgentPanel
                  key={selected.id}
                  agent={selected}
                  callType={selected.call ? <CallTypeTag call={selected.call} /> : null}
                  monitorModes={monitorModes}
                  onLogout={canLogout ? setLoggingOut : undefined}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={!!loggingOut}
        onOpenChange={(v) => {
          if (!v) {
            setLoggingOut(null);
            logout.reset();
          }
        }}
        title={`Force logout ${loggingOut?.username}?`}
        description="They leave their queue at once and their screen goes back to the login page. Not possible during a call. The audit log records who did it."
        confirmLabel="Force logout"
        destructive
        pending={logout.isPending}
        error={logout.error?.message}
        onConfirm={() => loggingOut && logout.mutate(loggingOut.id)}
      />
    </Card>
  );
}
