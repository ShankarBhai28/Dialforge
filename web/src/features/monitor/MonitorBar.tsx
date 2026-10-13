// The supervisor's monitoring controls on Live Agents: connect the
// monitoring line, then - during a monitor - see who they're on and switch
// between Listen / Whisper / Barge, or stop.
import { Ear, Headphones, LoaderCircle, Megaphone, MessageSquare, PhoneOff, Plug, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAccess } from '@/features/auth/access';
import {
  connectMonitorLine,
  disconnectMonitorLine,
  stopMonitor,
  switchMode,
  useMonitorLine,
  type MonitorMode,
} from './monitorLine';

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

export function MonitorBar() {
  const { can } = useAccess();
  const line = useMonitorLine();
  const modes = (['listen', 'whisper', 'barge'] as const).filter((m) => can('live', m));
  if (!modes.length) return null;
  const s = line.session;

  return (
    <div
      role="region"
      aria-label="Call monitoring"
      className={cn(
        'mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm',
        s?.live ? 'border-status-available bg-status-available/5' : 'bg-muted/30',
      )}
    >
      <Headphones className="size-5 shrink-0 text-primary" />
      {s ? (
        <>
          <span className="font-semibold">
            {s.live ? `${MODE_INFO[s.mode].doing} ${s.agent}` : `Connecting to ${s.agent}…`}
          </span>
          {s.live && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Monitoring mode">
              {modes.map((m) => {
                const Icon = MODE_INFO[m].icon;
                return (
                  <Button
                    key={m}
                    size="sm"
                    variant={s.mode === m ? 'default' : 'outline'}
                    aria-pressed={s.mode === m}
                    title={MODE_INFO[m].hint}
                    onClick={() => switchMode(m)}
                  >
                    <Icon /> {MODE_INFO[m].label}
                  </Button>
                );
              })}
            </div>
          )}
          <Button size="sm" variant="destructive" className="ml-auto" onClick={stopMonitor}>
            <PhoneOff /> Stop
          </Button>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">
            {line.status === 'connected'
              ? `Monitoring line ${line.extension} connected - choose an agent on a call below.`
              : line.status === 'connecting'
                ? 'Connecting your monitoring line…'
                : 'Connect your monitoring line to listen, whisper or barge on calls.'}
          </span>
          {line.status === 'connected' ? (
            <Button size="sm" variant="outline" className="ml-auto" onClick={disconnectMonitorLine}>
              <Unplug /> Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => void connectMonitorLine()}
              disabled={line.status === 'connecting'}
            >
              {line.status === 'connecting' ? <LoaderCircle className="animate-spin" /> : <Plug />} Connect monitoring
              line
            </Button>
          )}
        </>
      )}
      {line.error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {line.error}
        </p>
      )}
    </div>
  );
}
