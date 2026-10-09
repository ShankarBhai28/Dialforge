import { Badge } from '@/components/ui/badge';
import type { AgentStatus } from './api';

const STYLES: Record<string, { label: string; className: string }> = {
  talk: { label: 'On call', className: 'bg-status-talk/12 text-status-talk' },
  available: { label: 'Available', className: 'bg-status-available/12 text-status-available' },
  break: { label: 'Break', className: 'bg-status-break/12 text-status-break' },
  acw: { label: 'Wrap-up', className: 'bg-status-acw/12 text-status-acw' },
  offline: { label: 'Offline', className: 'bg-status-offline/15 text-muted-foreground' },
};

export function AgentStatusBadge({ status, onCall }: { status: AgentStatus; onCall?: boolean }) {
  const s = STYLES[onCall ? 'talk' : (status ?? 'offline')] ?? STYLES.offline;
  return (
    <Badge className={s.className}>
      <span className="size-1.5 rounded-full bg-current" />
      {s.label}
    </Badge>
  );
}
