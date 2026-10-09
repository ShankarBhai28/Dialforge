// The agent screen: connect a line, then work leads and calls. Fits the
// window (columns scroll on their own) on desktop; stacks on phones.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRealtime } from '@/lib/realtime';
import { useNow } from '@/lib/hooks';
import { agentKeys, useAgentStats } from './api';
import { AgentProvider, useController, usePhone } from './AgentProvider';
import { ConnectLine, useRememberLine } from './ConnectLine';
import { IncomingCallDialog, OutcomeDialog, QueuePickerDialog } from './dialogs';
import { callTimer, InCallPanel } from './InCallPanel';
import { LeadsPanel } from './LeadsPanel';
import { SidePanel } from './SidePanel';
import { Tiles, TopBar } from './TopBar';
import { Workspace } from './Workspace';
import type { UAFactory } from './softphone/softphone';

const PAGE_TITLE = 'Agent · DialForge';

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

export function AgentPage({ createUA }: { createUA?: UAFactory }) {
  useEffect(() => {
    document.title = PAGE_TITLE;
  }, []);
  return (
    <AgentProvider createUA={createUA}>
      <AgentScreen />
    </AgentProvider>
  );
}
