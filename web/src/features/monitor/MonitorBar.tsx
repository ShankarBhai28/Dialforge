// Monitoring modes (shared by the Live Agents side panel), and the strip that
// keeps a running monitor in view when its agent's panel isn't open:
// who you're on, Open (their panel) and Stop.
import { Ear, Headphones, Megaphone, MessageSquare, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { stopMonitor, useMonitorLine, type MonitorMode } from './monitorLine';

export const MODE_INFO: Record<MonitorMode, { label: string; doing: string; hint: string; icon: typeof Ear }> = {
  listen: { label: 'Listen', doing: 'Listening to', hint: 'Hear the call; nobody hears you', icon: Ear },
  whisper: {
    label: 'Whisper',
    doing: 'Whispering to',
    hint: 'Only the agent hears you (coaching)',
    icon: MessageSquare,
  },
  barge: { label: 'Barge', doing: 'Barged in on', hint: 'Agent and customer both hear you', icon: Megaphone },
};

export function MonitorStrip({ openAgentId, onOpen }: { openAgentId: number | null; onOpen: (id: number) => void }) {
  const { session: s } = useMonitorLine();
  if (!s || s.agentId === openAgentId) return null;
  return (
    <div
      role="region"
      aria-label="Call monitoring"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-status-available bg-status-available/5 px-4 py-2.5 text-sm"
    >
      <Headphones className="size-5 shrink-0 text-status-available" />
      <span className="font-semibold">
        {s.live ? `${MODE_INFO[s.mode].doing} ${s.agent}` : `Connecting to ${s.agent}…`}
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => onOpen(s.agentId)}>
        Open
      </Button>
      <Button size="sm" variant="destructive" onClick={stopMonitor}>
        <PhoneOff /> Stop
      </Button>
    </div>
  );
}
