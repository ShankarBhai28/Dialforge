// Live calls of one campaign: every number the dialer is working on right
// now (Dialing -> Ringing -> Waiting for an agent -> With an agent) with a
// running timer, Hang up for supervisors (right Dialer -> Hang up live
// calls); a second tab lists the calls that finished in the last 30 minutes,
// filterable by result.
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PhoneOff, Radio, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

/** One chip per result in the list; a picked result whose calls have aged out falls back to All. */
function resultGroups(rows: FinishedCall[]) {
  const groups = new Map<string, { label: string; n: number }>();
  for (const f of rows) {
    const key = f.result ?? '';
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { label: f.resultLabel, n: 1 });
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g }));
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium',
        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

function Finished({ rows }: { rows: FinishedCall[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (!rows.length)
    return (
      <EmptyState icon={PhoneOff} title="No calls finished in the last 30 minutes.">
        Each call shows here with its result once it ends.
      </EmptyState>
    );
  const groups = resultGroups(rows);
  const result = groups.some((g) => g.key === picked) ? picked : null;
  const shown = result === null ? rows : rows.filter((f) => (f.result ?? '') === result);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by result">
        <Chip on={result === null} onClick={() => setPicked(null)}>
          All <span className="tabular-nums opacity-80">{rows.length}</span>
        </Chip>
        {groups.map((g) => (
          <Chip key={g.key} on={result === g.key} onClick={() => setPicked(g.key)}>
            {g.label} <span className="tabular-nums opacity-80">{g.n}</span>
          </Chip>
        ))}
      </div>
      <Table aria-label="Finished calls">
        <TableHeader>
          <TableRow>
            <TableHead>Ended</TableHead>
            <TableHead>Lead</TableHead>
            <TableHead>Number</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Talk time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((f) => (
            <TableRow key={f.id}>
              <TableCell className="text-muted-foreground tabular-nums">{formatTime(f.endedAt)}</TableCell>
              <TableCell className="font-semibold">{f.leadName || DASH}</TableCell>
              <TableCell className="tabular-nums">{f.phone}</TableCell>
              <TableCell>
                <span
                  className={cn(
                    'inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
                    RESULT_TONE[f.result ?? ''] ?? 'bg-muted text-muted-foreground',
                  )}
                >
                  {f.resultLabel}
                </span>
              </TableCell>
              <TableCell>{f.agent ?? DASH}</TableCell>
              <TableCell className="tabular-nums">{f.talkSeconds ? formatSeconds(f.talkSeconds) : DASH}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-xs text-muted-foreground">Newest first. Older calls are in Reports.</p>
    </>
  );
}

function CountBadge({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="rounded-full bg-muted px-2 text-xs tabular-nums">{n}</span>;
}

export function LiveCallsCard({ campaign, onClose }: { campaign: { id: number; name: string }; onClose: () => void }) {
  const live = useDialerLive(campaign.id);
  const hangup = useHangup();
  const canHangup = useCan('dialer')('hangup');
  const now = useNow();
  const [confirm, setConfirm] = useState<LiveCall | null>(null);
  const [tab, setTab] = useState<'live' | 'finished'>('live');
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
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'live' | 'finished')}>
            <TabsList>
              <TabsTrigger value="live">
                In progress <CountBadge n={live.data.live.length} />
              </TabsTrigger>
              <TabsTrigger value="finished">
                Finished · last 30 min <CountBadge n={live.data.finished.length} />
              </TabsTrigger>
            </TabsList>
            <TabsContent value="live">
              <InProgress
                calls={live.data.live}
                now={now}
                canHangup={canHangup}
                onHangup={(c) => {
                  hangup.reset();
                  setConfirm(c);
                }}
              />
            </TabsContent>
            <TabsContent value="finished">
              <Finished rows={live.data.finished} />
            </TabsContent>
          </Tabs>
        )}
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

function InProgress({
  calls,
  now,
  canHangup,
  onHangup,
}: {
  calls: LiveCall[];
  now: number;
  canHangup: boolean;
  onHangup: (c: LiveCall) => void;
}) {
  return calls.length === 0 ? (
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
        {calls.map((c) => (
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
                  onClick={() => onHangup(c)}
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
  );
}
