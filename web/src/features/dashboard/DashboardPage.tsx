import { useQueryClient } from '@tanstack/react-query';
import { Clock, Headset, PhoneCall, Users, type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { useNow } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { formatSeconds } from '@/lib/utils';
import { dashboardKeys, useDashboardSummary, useLiveAgents, type LiveAgent } from './api';
import { AgentStatusBadge } from './AgentStatusBadge';

function StatTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number | undefined;
  icon: LucideIcon;
}) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <div className="flex size-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Icon className="size-5" />
      </div>
      <div>
        <div className="text-sm text-muted-foreground">{label}</div>
        {value === undefined ? (
          <Skeleton className="mt-1 h-7 w-14" />
        ) : (
          <div className="text-2xl font-extrabold tabular-nums">{value}</div>
        )}
      </div>
    </Card>
  );
}

function LiveAgentsTable({ agents }: { agents: LiveAgent[] }) {
  const now = useNow();
  if (!agents.length) return <p className="py-6 text-center text-sm text-muted-foreground">No agents yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <th className="py-2 pr-4">Agent</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Time</th>
            <th className="py-2 pr-4">Queue</th>
            <th className="py-2 pr-4">Extension</th>
            <th className="py-2">On call with</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const since = a.started_at ? (now - new Date(a.started_at).getTime()) / 1000 : null;
            return (
              <tr key={a.id} className="border-b last:border-0">
                <td className="py-2.5 pr-4 font-semibold">{a.username}</td>
                <td className="py-2.5 pr-4 whitespace-nowrap">
                  <AgentStatusBadge status={a.status} onCall={!!a.active_call_number} />
                  {a.reason && <span className="ml-2 text-xs text-muted-foreground">{a.reason}</span>}
                </td>
                <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">
                  {a.status && since !== null ? formatSeconds(since) : '—'}
                </td>
                <td className="py-2.5 pr-4">{a.queue_name ?? '—'}</td>
                <td className="py-2.5 pr-4">{a.extension_name ?? '—'}</td>
                <td className="py-2.5 tabular-nums">{a.active_call_number ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const qc = useQueryClient();
  const summary = useDashboardSummary();
  const agents = useLiveAgents();

  // Instant refresh when an agent changes status or a call event happens.
  useRealtime('agent.status', () => {
    qc.invalidateQueries({ queryKey: dashboardKeys.liveAgents });
    qc.invalidateQueries({ queryKey: dashboardKeys.summary });
  });
  useRealtime('call.event', () => {
    qc.invalidateQueries({ queryKey: dashboardKeys.liveAgents });
  });

  const s = summary.data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Agents" value={s?.totalAgents} icon={Users} />
        <StatTile label="Available now" value={s?.availableNow} icon={Headset} />
        <StatTile label="Calls today" value={s?.callsToday} icon={PhoneCall} />
        <StatTile label="Avg handle time" value={s && formatSeconds(s.avgHandleSeconds)} icon={Clock} />
      </div>
      {summary.error && <ErrorState message={summary.error.message} onRetry={() => summary.refetch()} />}

      <Card>
        <CardHeader>
          <CardTitle>Live agents</CardTitle>
          <CardDescription>Updates the moment an agent changes status.</CardDescription>
        </CardHeader>
        <CardContent>
          {agents.isPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : agents.error ? (
            <ErrorState message={agents.error.message} onRetry={() => agents.refetch()} />
          ) : (
            <LiveAgentsTable agents={agents.data} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
