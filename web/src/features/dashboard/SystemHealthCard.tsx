// System health (Super Admin): database, Asterisk, the dialer engine, trunk,
// services, disk, memory and the nightly backup - the same checks the server
// alerts on. Refreshes every minute and at once when something changes.
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { get } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

export type HealthStatus = 'ok' | 'warn' | 'fail';
export type SystemHealth = {
  at: string;
  overall: HealthStatus;
  checks: { key: string; label: string; status: HealthStatus; detail: string }[];
};

const healthKey = ['admin', 'system', 'health'] as const;
const DOT: Record<HealthStatus, string> = {
  ok: 'bg-status-available',
  warn: 'bg-status-break',
  fail: 'bg-destructive',
};
const SUMMARY: Record<HealthStatus, string> = {
  ok: 'Everything is working.',
  warn: 'Working, with something to look at.',
  fail: 'Something is not working.',
};

export function SystemHealthCard() {
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: healthKey,
    queryFn: () => get<SystemHealth>('/admin/system/health'),
    refetchInterval: 60000,
  });
  useRealtime('system.health', (m) => qc.setQueryData(healthKey, m.data as SystemHealth));
  const h = health.data;
  // Problems first.
  const order = { fail: 0, warn: 1, ok: 2 } as const;
  const checks = [...(h?.checks ?? [])].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            {h && <span className={cn('size-2.5 rounded-full', DOT[h.overall])} aria-hidden />}
            System health
          </CardTitle>
          <CardDescription>
            {h
              ? `${SUMMARY[h.overall]} Checked ${formatTime(h.at)}.`
              : 'Database, Asterisk, dialer, trunk, disk, backups.'}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => health.refetch()} disabled={health.isFetching}>
          <RefreshCw className={health.isFetching ? 'animate-spin' : undefined} /> Check now
        </Button>
      </CardHeader>
      <CardContent>
        {health.isPending ? (
          <Skeleton className="h-24" />
        ) : health.error ? (
          <ErrorState message={health.error.message} onRetry={() => health.refetch()} />
        ) : (
          <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2" aria-label="Health checks">
            {checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[c.status])} aria-label={c.status} />
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className={cn('ml-1.5', c.status === 'ok' ? 'text-muted-foreground' : 'font-medium')}>
                    {c.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
