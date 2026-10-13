// Live calls of one campaign: every number the dialer is working on right
// now (Dialing -> Ringing -> Waiting for an agent -> With an agent) with a
// running timer, Hang up for supervisors (right Dialer -> Hang up live
// calls), and the calls that just finished with their result.
import { useState } from 'react';
import { toast } from 'sonner';
import { PhoneOff, Radio, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { cn, formatSeconds } from '@/lib/utils';
import { useCan } from '@/features/auth/access';
import { useDialerLive, useHangup, type FinishedCall, type LiveCall, type LiveState } from './api';

const STATE: Record<LiveState, { label: string; dot: string; pill: string }> = {
  dialing: { label: 'Dialing', dot: 'bg-slate-400', pill: 'bg-muted text-muted-foreground' },
  ringing: { label: 'Ringing', dot: 'bg-sky-500 animate-pulse', pill: 'bg-sky-500/12 text-sky-700' },
  waiting: {
    label: 'Waiting for an agent',
    dot: 'bg-status-break animate-pulse',
    pill: 'bg-status-break/15 text-status-break',
  },
  connected: { label: 'With agent', dot: 'bg-status-available', pill: 'bg-status-available/12 text-status-available' },
};
const ORDER: LiveState[] = ['dialing', 'ringing', 'waiting', 'connected'];

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function StatePill({ call }: { call: LiveCall }) {
  const st = STATE[call.state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        st.pill,
      )}
    >
      <span className={cn('size-2 rounded-full', st.dot)} />
      {st.label}
      {call.state === 'connected' && call.agent ? ` - ${call.agent}` : ''}
    </span>
  );
}

const RESULT_TONE: Record<string, string> = {
  connected: 'bg-status-available/12 text-status-available',
  abandoned: 'bg-destructive/10 text-destructive',
  customer_hangup: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-status-break/15 text-status-break',
  machine: 'bg-violet-500/10 text-violet-700',
};

function Finished({ rows }: { rows: FinishedCall[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-sm font-bold">Just finished (last 30 min)</h3>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((f) => (
          <li
            key={f.id}
            className={cn(
              'rounded-md px-2 py-1 text-xs',
              RESULT_TONE[f.result ?? ''] ?? 'bg-muted text-muted-foreground',
            )}
            title={`Ended ${formatTime(f.endedAt)}`}
          >
            <span className="font-semibold">{f.leadName || f.phone}</span> · {f.resultLabel}
            {f.agent && ` (${f.agent}${f.talkSeconds ? `, ${formatSeconds(f.talkSeconds)}` : ''})`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveCallsCard({ campaign, onClose }: { campaign: { id: number; name: string }; onClose: () => void }) {
  const live = useDialerLive(campaign.id);
  const hangup = useHangup();
  const canHangup = useCan('dialer')('hangup');
  const now = useNow();
  const [confirm, setConfirm] = useState<LiveCall | null>(null);
  const counts = live.data?.counts;

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              <Radio className="size-4 text-status-available" /> Live calls - {campaign.name}
            </span>
          }
          description="Updates every 2 seconds. Ringing shows when the network reports it; some calls stay on Dialing until answered."
          actions={
            <Button variant="outline" size="sm" onClick={onClose}>
              <X /> Close
            </Button>
          }
        />
        {counts && (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Live counts">
            {ORDER.map((s) => (
              <div key={s} className={cn('rounded-md px-3 py-2', STATE[s].pill)}>
                <div className="text-xl font-bold tabular-nums">{counts[s]}</div>
                <div className="text-xs font-medium">{STATE[s].label}</div>
              </div>
            ))}
          </div>
        )}
        {live.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : live.error ? (
          <ErrorState message={live.error.message} onRetry={() => live.refetch()} />
        ) : live.data.live.length === 0 ? (
          <EmptyState icon={PhoneOff} title="No calls in progress.">
            While the campaign is running, every number being dialed shows here.
          </EmptyState>
        ) : (
          <Table aria-label="Calls in progress">
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>State</TableHead>
                <TableHead>In state</TableHead>
                <TableHead>Since dialed</TableHead>
                {canHangup && (
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.data.live.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-semibold">
                    {c.leadName || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="tabular-nums">{c.phone}</TableCell>
                  <TableCell>
                    <StatePill call={c} />
                  </TableCell>
                  <TableCell className="tabular-nums">{mmss(now - new Date(c.since).getTime())}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {mmss(now - new Date(c.startedAt).getTime())}
                  </TableCell>
                  {canHangup && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => {
                          hangup.reset();
                          setConfirm(c);
                        }}
                        aria-label={`Hang up ${c.phone}`}
                      >
                        <PhoneOff /> Hang up
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {live.data && <Finished rows={live.data.finished} />}
      </CardContent>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={`Hang up ${confirm?.leadName || confirm?.phone}?`}
        description={
          confirm?.state === 'connected'
            ? `This ends the customer's call with ${confirm.agent ?? 'the agent'} now. The agent then gives the outcome as usual.`
            : 'The call is cut and recorded as "Hung up by supervisor"; this lead is not dialed again for an hour.'
        }
        confirmLabel="Hang up"
        destructive
        pending={hangup.isPending}
        error={hangup.error?.message}
        onConfirm={() =>
          confirm &&
          hangup.mutate(confirm.id, {
            onSuccess: () => {
              toast.success(`Hung up ${confirm.leadName || confirm.phone}`);
              setConfirm(null);
            },
          })
        }
      />
    </Card>
  );
}
