// The agent screen: connect a line, then work leads and calls. Fits the
// window (columns scroll on their own) on desktop; stacks on phones.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRealtime } from '@/lib/realtime';
import { useNow } from '@/lib/hooks';
import { agentKeys, useAgentQueues, useAgentStats } from './api';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { cn } from '@/lib/utils';
import { AgentProvider, useController, usePhone } from './AgentProvider';
import { ConnectLine, useRememberLine } from './ConnectLine';
import { ExtraQueuesPicker, IncomingCallDialog, OutcomeDialog, QueuePickerDialog } from './dialogs';
import { callTimer, InCallPanel } from './InCallPanel';
import { LeadsPanel } from './LeadsPanel';
import { SidePanel } from './SidePanel';
import { Tiles, TopBar } from './TopBar';
import { Workspace } from './Workspace';
import type { UAFactory } from './softphone/softphone';
import { useSingleTab } from './singleTab';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Button } from '@/components/ui/button';
import { CircleCheck, LoaderCircle, MonitorSmartphone, Play } from 'lucide-react';
import { APP_NAME } from '@/lib/brand';

const PAGE_TITLE = `Agent · ${APP_NAME}`;

/** The tab title shows a live call, so it's noticed from another tab. */
function useCallTitle() {
  const { line } = usePhone();
  const { state } = useController();
  const now = useNow();
  const call = line.call;
  let title = PAGE_TITLE;
  if (call?.phase === 'live' && state.call) {
    const started = state.call.talkStartedAt ?? call.answeredAt;
    const elapsed = state.call.ringingCustomer || !started ? '00:00' : callTimer(now - started);
    title = state.call.ringingCustomer
      ? `Ringing… - ${PAGE_TITLE}`
      : call.onHold
        ? `⏸ HOLD ${elapsed} - ${PAGE_TITLE}`
        : `● LIVE ${elapsed} - ${PAGE_TITLE}`;
  }
  useEffect(() => {
    if (!state.incoming) document.title = title;
  }, [title, state.incoming]);
}

/** Before the shift: pick the queue (campaign) and go Available. */
function StartShift() {
  const { controller, state } = useController();
  const { line } = usePhone();
  const queues = useAgentQueues(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [extras, setExtras] = useState<number[]>(state.extraQueueIds);
  async function start(q: { id: number; name: string }) {
    setBusy(q.id);
    try {
      await controller.selectQueue(q, extras);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-4 sm:items-center">
      <section aria-labelledby="start-title" className="w-full max-w-md rounded-lg bg-card p-6 shadow-card">
        <div className="mb-1 flex items-center gap-2 text-sm text-status-available">
          <CircleCheck className="size-4" /> Line {line.extension ?? ''} connected
        </div>
        <h1 id="start-title" className="text-lg font-bold">
          Start your shift
        </h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick the queue you&apos;re working and go Available. Your leads, dialpad and calls open then.
        </p>
        {state.message?.error && (
          <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.message.text}
          </p>
        )}
        {queues.isPending ? (
          <Skeleton className="h-24" />
        ) : queues.error ? (
          <ErrorState message={queues.error.message} onRetry={() => queues.refetch()} />
        ) : queues.data.length === 0 ? (
          <p className="rounded-md bg-muted px-3 py-3 text-center text-sm text-muted-foreground">
            No campaign is assigned to your team yet - ask your admin to map one.
          </p>
        ) : (
          <>
            <ExtraQueuesPicker queues={queues.data} value={extras} onChange={setExtras} />
            <ul className="space-y-2">
              {queues.data.map((q) => {
                const last = state.queue?.id === q.id;
                return (
                  <li key={q.id}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void start({ id: q.id, name: q.name })}
                      aria-label={`Go Available on ${q.name}`}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border px-4 py-3 text-left hover:border-primary hover:bg-accent/40 disabled:opacity-60',
                        last && 'border-primary bg-accent/30',
                      )}
                    >
                      <span>
                        <span className="block font-semibold">{q.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {q.campaign_name}
                          {last && ' · your last queue'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-status-available">
                        {busy === q.id ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                        Go Available
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function Workbench() {
  const qc = useQueryClient();
  const stats = useAgentStats();
  const { controller } = useController();
  useCallTitle();

  // Each stats poll may change what the agent can do next (preview leads).
  const data = stats.data;
  useEffect(() => {
    if (data) void controller.onStats(data);
  }, [data, controller]);

  // Status changes made by the server (automatic ACW after a call) show at once.
  useRealtime('agent.status', () => void qc.invalidateQueries({ queryKey: agentKeys.stats }));

  // Not logged into a queue yet: only the "start your shift" page. Leads,
  // dialpad and calls open once they're Available (the server refuses
  // their calls before that too). Break / wrap-up keep the workbench.
  const { state } = useController();
  if (stats.isPending) return <FullPageSpinner />;
  if ((!data?.currentStatus || data.currentStatus === 'offline') && !state.call) {
    return (
      <div className="flex h-full flex-col">
        <TopBar stats={data} />
        <StartShift />
        <QueuePickerDialog />
      </div>
    );
  }

  const panel = 'flex min-h-0 flex-col rounded-lg bg-card p-4 shadow-card';
  return (
    <div className="flex h-full flex-col">
      <TopBar stats={data} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:overflow-hidden">
        <Tiles stats={data} />
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr_minmax(15rem,19rem)]">
          <aside className={`${panel} max-lg:max-h-[32rem]`} aria-label="Leads and callbacks">
            <LeadsPanel />
          </aside>
          <main className="min-h-0 overflow-y-auto lg:pr-1" aria-label="Customer">
            <Workspace />
          </main>
          <aside className={`${panel} max-lg:max-h-[40rem]`} aria-label="Dialpad and recent calls">
            <SidePanel />
          </aside>
        </div>
      </div>
      <InCallPanel />
      <IncomingCallDialog />
      <QueuePickerDialog />
      <OutcomeDialog />
    </div>
  );
}

function AgentScreen() {
  const { line } = usePhone();
  useRememberLine();
  return line.reg === 'registered' ? <Workbench /> : <ConnectLine />;
}

/** This tab waits: the agent screen is working in another tab of this browser. */
function OtherTab({ onUseHere }: { onUseHere: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <MonitorSmartphone className="size-10 text-muted-foreground" />
      <p className="font-semibold">The agent screen is open in another tab.</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Only one tab can have your phone line. Use it there, or move it to this tab - the other one will stop.
      </p>
      <Button onClick={onUseHere}>Use here</Button>
    </div>
  );
}

export function AgentPage({ createUA }: { createUA?: UAFactory }) {
  useEffect(() => {
    document.title = PAGE_TITLE;
  }, []);
  const tab = useSingleTab();
  if (tab.state === 'checking') return <FullPageSpinner />;
  // Unmounting the provider below disconnects this tab's phone line.
  if (tab.state === 'blocked') return <OtherTab onUseHere={tab.takeOver} />;
  return (
    <AgentProvider createUA={createUA}>
      <AgentScreen />
    </AgentProvider>
  );
}
