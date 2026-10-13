// Right column: dialpad (call any number) and the agent's recent calls.
import { useState, type FormEvent } from 'react';
import { Delete, Phone, PhoneIncoming, PhoneOutgoing, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAgentCalls, type CallRow } from './api';
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

type Filter = 'all' | 'answered' | 'none';

// How a call ended when the agent gave no outcome (calls.disposition).
const RESULT: Record<string, string> = {
  abandoned: 'Dropped',
  customer_hangup: 'Caller hung up',
  machine: 'Machine',
  no_answer: 'No answer',
  busy: 'Busy',
  congestion: 'Network error',
  network_error: 'Network error',
  failed: 'Failed',
  agent_unanswered: 'Not answered',
};

const answered = (c: CallRow) => !!(c.agent_connect_time ?? c.answer_time);

/** The outcome the agent gave; else what happened to the call. */
function callStatus(c: CallRow) {
  if (c.outcome_label) return { text: c.outcome_label, good: true };
  if (!c.end_time) return { text: 'In progress', good: true };
  if (answered(c)) return { text: 'Answered - no outcome', good: true };
  return { text: (c.disposition && RESULT[c.disposition]) || 'No answer', good: false };
}

function CallHistory() {
  const { controller } = useController();
  const calls = useAgentCalls();
  const [filter, setFilter] = useState<Filter>('all');
  const [playing, setPlaying] = useState<number | null>(null);
  const rows = (calls.data ?? []).filter((c) =>
    filter === 'answered' ? answered(c) : filter === 'none' ? !answered(c) && !!c.end_time : true,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList className="w-full">
          <TabsTrigger value="all" className="flex-1">
            All
          </TabsTrigger>
          <TabsTrigger value="answered" className="flex-1">
            Answered
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
              const status = callStatus(c);
              const label = c.lead_name ? `${c.lead_name} · ${c.to_number}` : c.to_number;
              return (
                <li key={c.id} className="py-2">
                  <div className="flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      {c.lead_id ? (
                        // The customer's details, form and history open in the middle.
                        <button
                          type="button"
                          className="block max-w-full cursor-pointer truncate text-left text-sm font-semibold tabular-nums hover:text-primary hover:underline"
                          onClick={() => void controller.openLeadById(c.lead_id!)}
                          title="Open this customer"
                        >
                          {label}
                        </button>
                      ) : (
                        <div className="truncate text-sm font-semibold tabular-nums">{c.to_number}</div>
                      )}
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        <span>{formatDateTime(c.start_time)}</span>
                        <span className={cn(status.good ? 'text-status-available' : 'text-status-break')}>
                          {status.text}
                        </span>
                      </div>
                    </div>
                    {c.has_recording && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={`${playing === c.id ? 'Stop' : 'Play'} recording of ${c.to_number}`}
                        title="Recording"
                        onClick={() => setPlaying(playing === c.id ? null : c.id)}
                      >
                        {playing === c.id ? <Square /> : <Play />}
                      </Button>
                    )}
                    {c.to_number && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-status-available hover:bg-status-available/10"
                        aria-label={`Call ${c.to_number}`}
                        title={`Call ${c.to_number}`}
                        onClick={() => void controller.callLead(null, c.to_number)}
                      >
                        <Phone />
                      </Button>
                    )}
                  </div>
                  {playing === c.id && (
                    <audio
                      controls
                      autoPlay
                      src={`/agent/calls/${c.id}/recording`}
                      className="mt-1.5 h-9 w-full"
                      aria-label={`Recording of call ${c.id}`}
                    />
                  )}
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
