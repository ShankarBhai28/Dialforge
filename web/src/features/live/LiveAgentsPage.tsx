// Live Agents: every agent's current status, queue and active call.
// Same data as the Dashboard's live table (GET /admin/live-agents), so the
// query, its cache key and the status badge are reused from features/dashboard.
// - Filters: status (default: logged-in agents only), name / extension, queue.
// - Call monitoring (listen / whisper / barge) through the supervisor's
//   monitoring line - see features/monitor.
// - Force logout takes a stuck or absent agent offline (not during a call).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LogOut, RefreshCw, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { post } from '@/lib/api';
import { ERROR_TOAST } from '@/lib/toast';
import { useAccess } from '@/features/auth/access';
import { ErrorState } from '@/components/ErrorState';
import { formatTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { cn, formatSeconds } from '@/lib/utils';
import { dashboardKeys, useLiveAgents, type LiveAgent } from '@/features/dashboard/api';
import { AgentStatusBadge } from '@/features/dashboard/AgentStatusBadge';
import { MODE_INFO, MonitorBar } from '@/features/monitor/MonitorBar';
import { startMonitor, useMonitorLine, type MonitorMode } from '@/features/monitor/monitorLine';

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

function AgentsTable({
  agents,
  monitorModes,
  onMonitor,
  onLogout,
}: {
  agents: LiveAgent[];
  monitorModes: MonitorMode[];
  onMonitor: (a: LiveAgent, mode: MonitorMode) => void;
  onLogout?: (a: LiveAgent) => void;
}) {
  const now = useNow();
  const line = useMonitorLine();
  const actions = monitorModes.length > 0 || !!onLogout;
  const lineReady = line.status === 'connected' && !line.session;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Extension</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Queue</TableHead>
          <TableHead>Since</TableHead>
          <TableHead>Active call</TableHead>
          {actions && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => {
          const since = a.started_at ? (now - new Date(a.started_at).getTime()) / 1000 : null;
          const monitoredHere = line.session?.agentId === a.id;
          return (
            <TableRow key={a.id} className={monitoredHere ? 'bg-status-available/5' : undefined}>
              <TableCell className="font-semibold">{a.username}</TableCell>
              <TableCell>{a.extension_name ?? '—'}</TableCell>
              <TableCell className="whitespace-nowrap">
                {/* A status the badge doesn't know is shown as-is, like the classic page. */}
                {a.status && !KNOWN.has(a.status) && !a.active_call_number ? (
                  <StatusPill tone="grey">{a.status}</StatusPill>
                ) : (
                  <AgentStatusBadge status={a.status} onCall={!!a.active_call_number} />
                )}
                {a.reason && <span className="ml-2 text-xs text-muted-foreground">{a.reason}</span>}
              </TableCell>
              <TableCell>{a.queue_name ?? '—'}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {a.status && a.started_at ? (
                  <>
                    {formatTime(a.started_at)}
                    {since !== null && <span className="ml-2 text-muted-foreground">({formatSeconds(since)})</span>}
                  </>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell className="tabular-nums">{a.active_call_number ?? '—'}</TableCell>
              {actions && (
                <TableCell className="text-right whitespace-nowrap">
                  {a.active_call_number &&
                    monitorModes.map((m) => {
                      const Icon = MODE_INFO[m].icon;
                      return (
                        <Button
                          key={m}
                          variant="ghost"
                          size="sm"
                          disabled={!lineReady}
                          title={lineReady ? MODE_INFO[m].hint : 'Connect your monitoring line first (above)'}
                          onClick={() => onMonitor(a, m)}
                          aria-label={`${MODE_INFO[m].label} ${a.username}`}
                        >
                          <Icon /> {MODE_INFO[m].label}
                        </Button>
                      );
                    })}
                  {onLogout && a.status && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => onLogout(a)}
                      aria-label={`Force logout ${a.username}`}
                    >
                      <LogOut /> Force logout
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function LiveAgentsPage() {
  const qc = useQueryClient();
  const agents = useLiveAgents();
  const { can } = useAccess();

  // Instant refresh on any status change or call event; the query's own
  // interval is only the safety net.
  const refresh = () => qc.invalidateQueries({ queryKey: dashboardKeys.liveAgents });
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
  const [q, setQ] = useState('');
  const [queue, setQueue] = useState('');
  const all = agents.data ?? [];
  const queues = [...new Set(all.map((a) => a.queue_name).filter((x): x is string => !!x))].sort();
  const term = q.trim().toLowerCase();
  const shown = all.filter(
    (a) =>
      matchesStatus(a, status) &&
      (!term || a.username.toLowerCase().includes(term) || (a.extension_name ?? '').includes(term)) &&
      (!queue || a.queue_name === queue),
  );

  // --- monitoring ---
  const monitorModes = (['listen', 'whisper', 'barge'] as const).filter((m) => can('live', m));
  const onMonitor = (a: LiveAgent, mode: MonitorMode) =>
    startMonitor(a.id, a.username, mode).catch((err: Error) => toast.error(err.message, ERROR_TOAST));

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
          description="Real-time status and active calls. Updates the moment an agent changes status."
          actions={
            <Button variant="outline" onClick={() => agents.refetch()} disabled={agents.isFetching}>
              <RefreshCw className={agents.isFetching ? 'animate-spin' : undefined} /> Refresh
            </Button>
          }
        />
        <MonitorBar />
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
            <Counts agents={all} value={status} onChange={setStatus} />
            <div className="mb-4 grid gap-2 sm:grid-cols-3">
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
              <Select aria-label="Filter by queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
                <option value="">All queues</option>
                {queues.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            {shown.length === 0 ? (
              <EmptyState icon={Users} title={status === 'loggedin' ? 'No agent is logged in' : 'No agent matches'}>
                {status === 'loggedin' && 'Choose "All agents" to see everyone.'}
              </EmptyState>
            ) : (
              <AgentsTable
                agents={shown}
                monitorModes={monitorModes}
                onMonitor={onMonitor}
                onLogout={canLogout ? setLoggingOut : undefined}
              />
            )}
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
