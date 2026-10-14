// Dashboard: what the client's licence allows and what's in use now.
import { BadgeCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDay, useLicence } from './api';

function Item({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function LicenceCard() {
  const { data: l } = useLicence();
  if (!l || l.state === 'none' || l.state === 'invalid') return null;
  const of = (used: number | null, max: number | null) =>
    max ? `${used ?? '–'} / ${max}` : `${used ?? '–'} (no limit)`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BadgeCheck className="size-5 text-primary" /> Licence{l.customer ? ` · ${l.customer}` : ''}
        </CardTitle>
        <CardDescription>Set by your VIZTEX provider. To change it, contact them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <Item label="Agent seats (extensions)" value={of(l.seatsUsed, l.seats)} hint="agents working at once" />
        <Item label="Phone lines in use" value={of(l.channelsInUse, l.channels)} hint="calls at once, in and out" />
        <Item
          label="Valid till"
          value={l.expires ? formatDay(l.expires) : 'No end date'}
          hint={
            l.state === 'expired'
              ? 'ended'
              : l.daysLeft != null
                ? `${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} left`
                : undefined
          }
        />
      </CardContent>
    </Card>
  );
}
