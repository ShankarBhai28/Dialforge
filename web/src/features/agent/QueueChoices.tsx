// Going Available: one row per campaign of the agent's teams - its main queue
// (always taken) and, when the campaign has more queues, which of them to
// take too (all ticked by default; fixed when the campaign says "agents take
// all queues"). Used by "Start your shift" and the queue picker.
import { useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentQueue } from './api';

export type QueueChoice = { queue: { id: number; name: string }; extraQueueIds: number[] };

function QueueRow({
  q,
  last,
  initial,
  busy,
  disabled,
  onGo,
}: {
  q: AgentQueue;
  last: boolean;
  initial: number[];
  busy: boolean;
  disabled: boolean;
  onGo: (choice: QueueChoice) => void;
}) {
  const extras = q.extra_queues ?? [];
  const [ticked, setTicked] = useState<number[]>(initial);
  const toggle = (id: number) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  return (
    <li className={cn('overflow-hidden rounded-md border', last && 'border-primary bg-accent/30')}>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onGo({ queue: { id: q.id, name: q.name }, extraQueueIds: q.take_all ? extras.map((x) => x.id) : ticked })
        }
        aria-label={`Go Available on ${q.name}`}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40 disabled:opacity-60"
      >
        <span>
          <span className="block font-semibold">{q.name}</span>
          <span className="block text-xs text-muted-foreground">
            {q.campaign_name}
            {last && ' · your last queue'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-status-available">
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
          Go Available
        </span>
      </button>
      {extras.length > 0 &&
        (q.take_all ? (
          <p className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            Also takes: {extras.map((x) => x.name).join(', ')}
          </p>
        ) : (
          <fieldset className="border-t bg-muted/30 px-4 py-2" aria-label={`Also take with ${q.name}`}>
            <legend className="sr-only">Also take with {q.name}</legend>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Also take:</span>
              {extras.map((x) => (
                <label key={x.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={ticked.includes(x.id)}
                    onChange={() => toggle(x.id)}
                  />
                  {x.name}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
    </li>
  );
}

export function QueueChoices({
  queues,
  lastQueueId,
  lastExtraIds,
  busyId,
  onGo,
}: {
  queues: AgentQueue[];
  lastQueueId: number | null;
  /** The shift's ticks (kept for the queue last worked; other campaigns start all ticked). */
  lastExtraIds: number[] | null;
  busyId: number | null;
  onGo: (choice: QueueChoice) => void;
}) {
  return (
    <ul className="space-y-2">
      {queues.map((q) => {
        const last = lastQueueId === q.id;
        const all = (q.extra_queues ?? []).map((x) => x.id);
        return (
          <QueueRow
            key={q.id}
            q={q}
            last={last}
            initial={last && lastExtraIds ? all.filter((id) => lastExtraIds.includes(id)) : all}
            busy={busyId === q.id}
            disabled={busyId !== null}
            onGo={onGo}
          />
        );
      })}
    </ul>
  );
}
