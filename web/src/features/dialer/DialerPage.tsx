// Dialer: start / pause / stop auto-dialing per campaign, the engine's live
// numbers, today's results and the hopper (next leads to dial).
// The engine is the separate dialer-engine.js process; this screen only
// flips campaigns.dialer_state and reads what the engine last reported.
import { useState } from 'react';
import { toast } from 'sonner';
import { Inbox, Pause, Play, PhoneOff, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, FormError, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime, formatTime } from '@/lib/format';
import {
  HOPPER_LIMIT,
  useDialer,
  useDialerAction,
  useHopper,
  type DialerCampaign,
  type DialerEngine,
  type DialerToday,
} from './api';
import { useCanManage } from '@/features/auth/access';

const NONE = <span className="text-muted-foreground">—</span>;

// Industry definition: abandons over answered calls. Above 3 % is a problem.
const ABANDON_LIMIT_PCT = 3;

function EngineBadge({ engine }: { engine: DialerEngine | undefined }) {
  if (!engine) return <StatusPill tone="grey">Engine: checking…</StatusPill>;
  if (engine.alive) return <StatusPill tone="green">Engine: running</StatusPill>;
  if (engine.last_tick_at)
    return <StatusPill tone="red">Engine: DOWN (last seen {formatTime(engine.last_tick_at)})</StatusPill>;
  return <StatusPill tone="grey">Engine: never started</StatusPill>;
}

function StateBadge({ state }: { state: string }) {
  const tone = state === 'running' ? 'green' : state === 'paused' ? 'amber' : 'grey';
  return <StatusPill tone={tone}>{state}</StatusPill>;
}

function modeLabel(c: DialerCampaign) {
  if (c.dial_mode === 'progressive') return `progressive ${Number(c.dial_ratio)}:1`;
  if (c.dial_mode === 'predictive') return `predictive ≤${Number(c.max_dial_ratio)}:1`;
  return c.dial_mode;
}

/** Predictive only: what the engine has learned right now. */
function PredictiveNote({ c }: { c: DialerCampaign }) {
  if (c.dial_mode !== 'predictive' || c.current_ratio == null) return null;
  const parts = [`now ${Number(c.current_ratio)}:1`];
  if (c.answer_rate != null) parts.push(`answer ${Number(c.answer_rate).toFixed(0)}%`);
  if (c.abandon_pct != null) parts.push(`abandon ${Number(c.abandon_pct).toFixed(1)}%`);
  if (c.ratio_adjust != null) parts.push(`adjust ${Number(c.ratio_adjust)}`);
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {parts.join(' · ')}
      {c.pacing_note && <div>{c.pacing_note}</div>}
    </div>
  );
}

function TodayStats({ t }: { t: DialerToday | null }) {
  if (!t || !t.attempts) return <span className="text-muted-foreground">no calls</span>;
  const answered = Number(t.answered);
  const abandonPct = answered ? (100 * Number(t.abandoned)) / answered : 0;
  return (
    <div className="text-xs whitespace-nowrap">
      <div>
        {t.attempts} dialed · {answered} answered · {Number(t.connected)} to agent
      </div>
      <div>
        {Number(t.not_reached)} not reached
        {Number(t.machine) ? ` · ${Number(t.machine)} machine` : ''} ·{' '}
        <span className={abandonPct > ABANDON_LIMIT_PCT ? 'font-bold text-destructive' : undefined}>
          {Number(t.abandoned)} abandoned ({abandonPct.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
}

function HopperCard({ campaign, onClose }: { campaign: { id: number; name: string }; onClose: () => void }) {
  const hopper = useHopper(campaign.id);
  const n = hopper.data?.length ?? 0;
  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title={`Hopper - ${campaign.name}${hopper.data ? ` (${n}${n === HOPPER_LIMIT ? '+' : ''})` : ''}`}
          description="Next leads to dial, in pick order: locked first, then due callbacks, list priority, lead priority, fewest attempts."
          actions={
            <Button variant="outline" size="sm" onClick={onClose}>
              <X /> Close
            </Button>
          }
        />
        {hopper.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : hopper.error ? (
          <ErrorState message={hopper.error.message} onRetry={() => hopper.refetch()} />
        ) : n === 0 ? (
          <EmptyState icon={Inbox} title="Hopper is empty.">
            The engine refills it every few seconds while the campaign is running and has dialable leads.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>List</TableHead>
                <TableHead>Callback</TableHead>
                <TableHead>List prio</TableHead>
                <TableHead>Lead prio</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Queued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hopper.data.map((h, i) => (
                <TableRow key={h.id}>
                  <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell>{h.name ?? NONE}</TableCell>
                  <TableCell className="tabular-nums">{h.phone}</TableCell>
                  <TableCell>{h.list_name ?? NONE}</TableCell>
                  <TableCell>{h.is_callback ? `Yes${h.reserved_for ? ` (${h.reserved_for})` : ''}` : ''}</TableCell>
                  <TableCell className="tabular-nums">{h.list_priority}</TableCell>
                  <TableCell className="tabular-nums">{h.lead_priority}</TableCell>
                  <TableCell className="tabular-nums">{h.attempts}</TableCell>
                  <TableCell>
                    <StatusPill tone={h.status === 'locked' ? 'blue' : 'grey'}>{h.status}</StatusPill>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatTime(h.inserted_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type Confirming = { campaign: DialerCampaign; action: 'start' | 'stop' };

export function DialerPage() {
  const manages = useCanManage('dialer');
  const dialer = useDialer();
  const act = useDialerAction();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [hopperFor, setHopperFor] = useState<{ id: number; name: string } | null>(null);

  function run(c: DialerCampaign, action: 'start' | 'pause' | 'stop') {
    act.mutate(
      { id: c.id, action },
      {
        onSuccess: () => {
          toast.success(
            {
              start: `${c.name}: dialer started`,
              pause: `${c.name}: dialer paused`,
              stop: `${c.name}: dialer stopped`,
            }[action],
          );
          setConfirming(null);
        },
      },
    );
  }

  function ask(campaign: DialerCampaign, action: 'start' | 'stop') {
    act.reset();
    setConfirming({ campaign, action });
  }

  const c = confirming?.campaign;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5">
          <SectionHeader
            title="Dialer"
            description={
              <>
                Start / pause / stop auto-dialing per campaign. Preview: agents dial from the hopper. Progressive: the
                engine dials by itself (idle agents × ratio). Predictive: the engine adjusts the ratio itself to keep
                abandons under target. <b>Abandon %</b> = answered customers who got no agent.
              </>
            }
            actions={<EngineBadge engine={dialer.data?.engine} />}
          />

          {/* Pause has no confirm dialog, so its error shows here. */}
          {!confirming && act.error && (
            <div className="mb-4">
              <FormError message={act.error.message} />
            </div>
          )}

          {dialer.isPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : dialer.error ? (
            <ErrorState message={dialer.error.message} onRetry={() => dialer.refetch()} />
          ) : dialer.data.campaigns.length === 0 ? (
            <EmptyState icon={PhoneOff} title="No campaigns.">
              Create a campaign and give it a dial mode other than Manual to dial it from here.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Dialer</TableHead>
                  <TableHead>Idle agents</TableHead>
                  <TableHead>Hopper</TableHead>
                  <TableHead>Ringing / waiting</TableHead>
                  <TableHead>On calls</TableHead>
                  <TableHead>Today</TableHead>
                  <TableHead>Engine note</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dialer.data.campaigns.map((row) => {
                  // No dialer_status row yet = the engine hasn't looked at this campaign.
                  const seen = row.last_tick_at != null;
                  return (
                    <TableRow key={row.id} className="align-top">
                      <TableCell className="font-semibold">
                        {row.name}
                        {row.status !== 'active' && (
                          <span className="ml-1 font-normal text-muted-foreground">({row.status})</span>
                        )}
                        {row.queue_name && (
                          <div className="text-xs font-normal text-muted-foreground">Queue: {row.queue_name}</div>
                        )}
                      </TableCell>
                      <TableCell className="min-w-40">
                        {modeLabel(row)}
                        <PredictiveNote c={row} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <StateBadge state={row.dialer_state} />
                        {row.dialer_state_changed_at && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatDateTime(row.dialer_state_changed_at)}
                            {row.changed_by && ` by ${row.changed_by}`}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{seen ? row.idle_agents : NONE}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {seen ? (
                          <>
                            {row.hopper_ready} ready{row.hopper_locked ? ` / ${row.hopper_locked} locked` : ''}
                          </>
                        ) : (
                          NONE
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{seen ? row.in_flight : NONE}</TableCell>
                      <TableCell className="tabular-nums">
                        {seen ? (row.active_calls ?? 0) - (row.in_flight ?? 0) : NONE}
                      </TableCell>
                      <TableCell>
                        <TodayStats t={row.today} />
                      </TableCell>
                      <TableCell className="max-w-72 min-w-48 text-xs">{row.note ?? NONE}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {manages && row.dialer_state !== 'running' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => ask(row, 'start')}
                            aria-label={`Start ${row.name}`}
                          >
                            <Play /> Start
                          </Button>
                        )}
                        {manages && row.dialer_state === 'running' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={act.isPending}
                            onClick={() => {
                              act.reset();
                              run(row, 'pause');
                            }}
                            aria-label={`Pause ${row.name}`}
                          >
                            <Pause /> Pause
                          </Button>
                        )}
                        {manages && row.dialer_state !== 'stopped' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => ask(row, 'stop')}
                            aria-label={`Stop ${row.name}`}
                          >
                            <Square /> Stop
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setHopperFor({ id: row.id, name: row.name })}
                          aria-label={`Hopper ${row.name}`}
                        >
                          <Inbox /> Hopper
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {hopperFor && <HopperCard key={hopperFor.id} campaign={hopperFor} onClose={() => setHopperFor(null)} />}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(v) => {
          if (!v) {
            setConfirming(null);
            act.reset();
          }
        }}
        title={confirming?.action === 'start' ? `Start dialing ${c?.name}?` : `Stop ${c?.name}?`}
        description={
          confirming?.action === 'start'
            ? `This places real calls to this campaign's leads, starting right away (mode: ${c ? modeLabel(c) : ''}).`
            : 'No new calls will be placed and its hopper will be emptied.'
        }
        confirmLabel={confirming?.action === 'start' ? 'Start dialing' : 'Stop'}
        destructive={confirming?.action === 'stop'}
        pending={act.isPending}
        error={act.error?.message}
        onConfirm={() => confirming && run(confirming.campaign, confirming.action)}
      />
    </div>
  );
}
