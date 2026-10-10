// Live Agents: every agent's current status, queue and active call.
// Same data as the Dashboard's live table (GET /admin/live-agents), so the
// query, its cache key and the status badge are reused from features/dashboard.
// Force logout takes a stuck or absent agent offline (not during a call).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LogOut, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { post } from '@/lib/api';
import { useAccess } from '@/features/auth/access';
import { ErrorState } from '@/components/ErrorState';
import { formatTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { formatSeconds } from '@/lib/utils';
import { dashboardKeys, useLiveAgents, type LiveAgent } from '@/features/dashboard/api';
import { AgentStatusBadge } from '@/features/dashboard/AgentStatusBadge';

const KNOWN = new Set(['available', 'break', 'acw']);

/** Bucket an agent the same way the badge does: a live call beats the status. */
function bucket(a: LiveAgent) {
  if (a.active_call_number) return 'talk';
  return a.status ?? 'offline';
}

function Counts({ agents }: { agents: LiveAgent[] }) {
  const n = (k: string) => agents.filter((a) => bucket(a) === k).length;
  const items = [
    { label: 'Available', value: n('available'), tone: 'green' },
    { label: 'On call', value: n('talk'), tone: 'blue' },
    { label: 'Break', value: n('break'), tone: 'amber' },
    { label: 'Wrap-up', value: n('acw'), tone: 'amber' },
    { label: 'Offline', value: n('offline'), tone: 'grey' },
  ] as const;
  return (
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Agents by status">
      {items.map((i) => (
        <StatusPill key={i.label} tone={i.tone}>
          {i.label}: {i.value}
        </StatusPill>
      ))}
    </div>
  );
}

function AgentsTable({ agents, onLogout }: { agents: LiveAgent[]; onLogout?: (a: LiveAgent) => void }) {
  const now = useNow();
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
          {onLogout && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => {
          const since = a.started_at ? (now - new Date(a.started_at).getTime()) / 1000 : null;
          return (
            <TableRow key={a.id}>
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
              {onLogout && (
                <TableCell className="text-right">
                  {a.status && (
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

  // Instant refresh on any status change or call event; the query's own
  // interval is only the safety net.
  const refresh = () => qc.invalidateQueries({ queryKey: dashboardKeys.liveAgents });
  useRealtime('agent.status', refresh);
  useRealtime('call.event', refresh);

  const canLogout = useAccess().can('live', 'logout');
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
        {agents.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : agents.error ? (
          <ErrorState message={agents.error.message} onRetry={() => agents.refetch()} />
        ) : agents.data.length === 0 ? (
          <EmptyState icon={Users} title="No agents found">
            Create agent accounts under Users; they show here once they exist.
          </EmptyState>
        ) : (
          <>
            <Counts agents={agents.data} />
            <AgentsTable agents={agents.data} onLogout={canLogout ? setLoggingOut : undefined} />
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
