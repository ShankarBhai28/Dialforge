// The agent's call log (right column): search, period, a filter for what
// to look at (answered, not answered, needs an outcome, callbacks, ...),
// calls grouped by day. Each call shows who, when, how long and the
// outcome; actions: open the customer, give a missing outcome, play the
// recording, call back.
import { useMemo, useState } from 'react';
import {
  ClipboardCheck,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  RefreshCw,
  Search,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { formatDate, formatTime } from '@/lib/format';
import { cn, formatSeconds } from '@/lib/utils';
import { useAgentCalls, type CallPeriod, type CallRow } from './api';
import { useController } from './AgentProvider';

// --- what a call is ---
const answered = (c: CallRow) => !!(c.agent_connect_time ?? c.answer_time);
const live = (c: CallRow) => !c.end_time;
const needsOutcome = (c: CallRow) => answered(c) && !live(c) && !c.outcome;

const RESULT: Record<string, string> = {
  abandoned: 'Dropped',
  customer_hangup: 'Caller hung up',
  machine: 'Answering machine',
  no_answer: 'No answer',
  busy: 'Busy',
  congestion: 'Network error',
  network_error: 'Network error',
  failed: 'Failed',
  invalid: 'Invalid number',
  agent_unanswered: 'You missed it',
};

type Tone = 'good' | 'callback' | 'warn' | 'muted' | 'bad';
/** The chip on a call: the outcome given, else what happened. */
export function callChip(c: CallRow): { text: string; tone: Tone } {
  if (live(c)) return { text: 'In progress', tone: 'good' };
  if (c.outcome_label) return { text: c.outcome_label, tone: c.is_callback ? 'callback' : 'good' };
  if (answered(c)) return { text: 'Needs outcome', tone: 'warn' };
  const text = (c.disposition && RESULT[c.disposition]) || 'No answer';
  return {
    text,
    tone: ['abandoned', 'failed', 'congestion', 'network_error', 'invalid'].includes(c.disposition ?? '')
      ? 'bad'
      : 'muted',
  };
}
const TONE: Record<Tone, string> = {
  good: 'bg-status-available/12 text-status-available',
  callback: 'bg-status-break/15 text-status-break',
  warn: 'border border-status-break/50 text-status-break',
  muted: 'bg-muted text-muted-foreground',
  bad: 'bg-destructive/10 text-destructive',
};

// --- filters ---
type Filter = 'all' | 'answered' | 'not_answered' | 'needs_outcome' | 'callbacks' | 'inbound' | 'outbound' | 'recorded';
const FILTERS: { key: Filter; label: string; test: (c: CallRow) => boolean }[] = [
  { key: 'all', label: 'All calls', test: () => true },
  { key: 'answered', label: 'Answered', test: answered },
  { key: 'not_answered', label: 'Not answered', test: (c) => !answered(c) && !live(c) },
  { key: 'needs_outcome', label: 'Needs outcome', test: needsOutcome },
  { key: 'callbacks', label: 'Callbacks set', test: (c) => !!c.is_callback },
  { key: 'inbound', label: 'Inbound', test: (c) => c.direction === 'inbound' },
  { key: 'outbound', label: 'Outbound', test: (c) => c.direction !== 'inbound' },
  { key: 'recorded', label: 'Recorded', test: (c) => !!c.has_recording },
];
const PERIODS: { key: CallPeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

/** A per-browser preference (period / filter), kept across reloads. */
function useRemembered<T extends string>(key: string, initial: T, allowed: readonly T[]) {
  const [v, setV] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      return saved && allowed.includes(saved) ? saved : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* private mode */
    }
  };
  return [v, set] as const;
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return formatDate(d);
}

function CallItem({ c, playing, onPlay }: { c: CallRow; playing: boolean; onPlay: () => void }) {
  const { controller, state } = useController();
  const chip = callChip(c);
  const Icon = !answered(c) && !live(c) ? PhoneMissed : c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
  const title = c.lead_name || c.to_number;
  return (
    <li className="rounded-md px-2 py-2 hover:bg-muted/60">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            !answered(c) && !live(c)
              ? 'bg-destructive/10 text-destructive'
              : c.direction === 'inbound'
                ? 'bg-primary/10 text-primary'
                : 'bg-status-available/12 text-status-available',
          )}
          title={c.direction === 'inbound' ? 'Inbound' : 'Outbound'}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            {c.lead_id ? (
              // The customer's details, form and history open in the middle.
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate text-left text-sm font-semibold hover:text-primary hover:underline"
                onClick={() => void controller.openLeadById(c.lead_id!)}
                aria-label={`Open ${title}`}
                title="Open this customer"
              >
                {title}
              </button>
            ) : (
              <span className="min-w-0 truncate text-sm font-semibold tabular-nums">{title}</span>
            )}
            <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={c.start_time}>
              {formatTime(c.start_time)}
            </time>
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {c.lead_name && <span className="tabular-nums">{c.to_number}</span>}
            {c.lead_name && c.talk_seconds ? <span aria-hidden>·</span> : null}
            {c.talk_seconds ? <span>talked {formatSeconds(c.talk_seconds)}</span> : null}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <span className={cn('truncate rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE[chip.tone])}>
              {chip.text}
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              {needsOutcome(c) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-status-break"
                  aria-label={`Give outcome for ${c.to_number}`}
                  title="Give outcome"
                  disabled={!!state.call}
                  onClick={() =>
                    controller.giveOutcomeLater({
                      leadId: c.lead_id ?? null,
                      callId: c.id,
                      name: c.lead_name ?? null,
                      phone: c.to_number,
                    })
                  }
                >
                  <ClipboardCheck />
                </Button>
              )}
              {c.has_recording && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`${playing ? 'Stop' : 'Play'} recording of ${c.to_number}`}
                  title="Recording"
                  onClick={onPlay}
                >
                  {playing ? <Square /> : <Play />}
                </Button>
              )}
              {c.to_number && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-status-available hover:bg-status-available/10"
                  aria-label={`Call ${c.to_number}`}
                  title={`Call ${c.to_number}`}
                  disabled={!!state.call}
                  onClick={() => void controller.callLead(null, c.to_number)}
                >
                  <Phone />
                </Button>
              )}
            </span>
          </div>
        </div>
      </div>
      {playing && (
        <audio
          controls
          autoPlay
          src={`/agent/calls/${c.id}/recording`}
          className="mt-2 h-9 w-full"
          aria-label={`Recording of call ${c.id}`}
        />
      )}
    </li>
  );
}

export function CallLog() {
  const [period, setPeriod] = useRemembered<CallPeriod>(
    'df-calllog-period',
    'today',
    PERIODS.map((p) => p.key),
  );
  const [filter, setFilter] = useRemembered<Filter>(
    'df-calllog-filter',
    'all',
    FILTERS.map((f) => f.key),
  );
  const [search, setSearch] = useState('');
  const [playing, setPlaying] = useState<number | null>(null);
  const calls = useAgentCalls(period);
  const all = useMemo(() => calls.data ?? [], [calls.data]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, all.filter(f.test).length])), [all]);
  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return all.filter(
      (c) =>
        test(c) &&
        (!q ||
          (c.lead_name ?? '').toLowerCase().includes(q) ||
          (digits.length > 0 && c.to_number.replace(/\D/g, '').includes(digits))),
    );
  }, [all, filter, search]);
  const groups = useMemo(() => {
    const out: { label: string; calls: CallRow[] }[] = [];
    for (const c of rows) {
      const label = dayLabel(c.start_time);
      if (out.at(-1)?.label === label) out.at(-1)!.calls.push(c);
      else out.push({ label, calls: [c] });
    }
    return out;
  }, [rows]);

  const talk = all.reduce((s, c) => s + (c.talk_seconds ?? 0), 0);
  return (
    <section aria-label="Call log" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">Call log</h3>
          <p className="text-xs text-muted-foreground">
            {all.length} call{all.length === 1 ? '' : 's'} · {counts.answered} answered
            {talk > 0 && ` · ${formatSeconds(talk)} talk`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Refresh call log"
          onClick={() => void calls.refetch()}
        >
          <RefreshCw className={cn(calls.isFetching && 'animate-spin')} />
        </Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or number"
          aria-label="Search calls"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          aria-label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as CallPeriod)}
          className="h-8 px-2 text-xs"
        >
          {PERIODS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Show"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className={cn('h-8 px-2 text-xs', filter === 'needs_outcome' && 'text-status-break')}
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label} ({counts[f.key] ?? 0})
            </option>
          ))}
        </Select>
      </div>
      {counts.needs_outcome > 0 && filter !== 'needs_outcome' && (
        <button
          type="button"
          onClick={() => setFilter('needs_outcome')}
          className="cursor-pointer rounded-md border border-status-break/40 bg-status-break/10 px-2 py-1 text-left text-xs text-status-break"
        >
          {counts.needs_outcome} answered call{counts.needs_outcome === 1 ? '' : 's'} without an outcome - show
        </button>
      )}
      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
        {calls.isPending ? (
          <Skeleton className="mx-2 h-24" />
        ) : calls.error ? (
          <ErrorState message={calls.error.message} onRetry={() => calls.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {all.length === 0 ? 'No calls in this period' : 'No calls match'}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <div className="sticky top-0 z-10 bg-card px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {g.label}
              </div>
              <ul>
                {g.calls.map((c) => (
                  <CallItem
                    key={c.id}
                    c={c}
                    playing={playing === c.id}
                    onPlay={() => setPlaying(playing === c.id ? null : c.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
