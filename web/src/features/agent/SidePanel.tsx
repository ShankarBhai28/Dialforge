// Right column: dialpad (call any number) and the agent's recent calls.
import { useState, type FormEvent } from 'react';
import { Delete, Phone, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAgentCalls } from './api';
import { useController } from './AgentProvider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function Dialpad() {
  const { controller } = useController();
  const [number, setNumber] = useState('');
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = number.trim();
    if (!n) return;
    void controller.callLead(null, n);
    setNumber('');
  }
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Input
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        placeholder="Enter number"
        aria-label="Number to dial"
        inputMode="tel"
        className="text-center text-lg font-semibold tracking-wider"
      />
      <div className="grid grid-cols-3 gap-1.5">
        {KEYS.map((k) => (
          <Button
            key={k}
            type="button"
            variant="outline"
            className="h-10 text-base"
            onClick={() => setNumber((v) => v + k)}
          >
            {k}
          </Button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Button type="button" variant="outline" aria-label="Backspace" onClick={() => setNumber((v) => v.slice(0, -1))}>
          <Delete />
        </Button>
        <Button type="submit" className="flex-1 bg-status-available hover:bg-status-available/90">
          <Phone /> Call
        </Button>
      </div>
    </form>
  );
}

type Filter = 'all' | 'ended' | 'none';

function CallHistory() {
  const calls = useAgentCalls();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = (calls.data ?? []).filter((c) =>
    filter === 'ended' ? c.disposition === 'ended' : filter === 'none' ? !c.disposition : true,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList className="w-full">
          <TabsTrigger value="all" className="flex-1">
            All
          </TabsTrigger>
          <TabsTrigger value="ended" className="flex-1">
            Completed
          </TabsTrigger>
          <TabsTrigger value="none" className="flex-1">
            No Answer
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {calls.isPending ? (
          <Skeleton className="h-24" />
        ) : calls.error ? (
          <ErrorState message={calls.error.message} onRetry={() => calls.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No calls yet</p>
        ) : (
          <ul className="divide-y">
            {rows.map((c) => {
              const Icon = c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
              return (
                <li key={c.id} className="flex items-center gap-2.5 py-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold tabular-nums">{c.to_number}</div>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>{formatDateTime(c.start_time)}</span>
                      <span className={cn(c.disposition === 'ended' ? 'text-status-available' : 'text-status-break')}>
                        {c.disposition || 'no answer'}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SidePanel() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Dialpad />
      <CallHistory />
    </div>
  );
}
