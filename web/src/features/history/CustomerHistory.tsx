// Customer history of one lead: a summary (calls, who spoke to them last,
// last outcome, callback due), the latest form answers, and a timeline of
// every call, outcome, form, callback and edit - newest first. The agent
// screen shows it for the live call / preview / clicked lead; admins open
// it from Leads (with recordings to play when their role allows).
import { useState, type ReactNode } from 'react';
import {
  CalendarClock,
  FileText,
  History,
  Pencil,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  Plus,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { cn, formatSeconds } from '@/lib/utils';
import { useLeadHistory, type HistoryItem, type HistorySide, type LeadHistory } from './api';
import { RecordingPlayer } from '@/components/RecordingPlayer';

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

function Summary({ h }: { h: LeadHistory }) {
  const s = h.summary;
  if (!s.calls) return <p className="text-sm text-muted-foreground">No calls with this customer yet.</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <span>
        <b>{s.calls}</b> call{s.calls === 1 ? '' : 's'} · <b>{s.answered}</b> answered
        {s.talkSeconds > 0 && <> · talk {formatSeconds(s.talkSeconds)}</>}
      </span>
      {s.lastSpokeWith && (
        <span>
          Last spoke with <b>{s.lastSpokeWith}</b> on {formatDateTime(s.lastSpokeAt)}
        </span>
      )}
      {s.lastOutcome && (
        <span>
          Last outcome <b>{s.lastOutcome}</b>
        </span>
      )}
      {s.pendingCallback && (
        <span className="text-status-break">
          <CalendarClock className="mr-1 inline size-3.5" />
          Callback due {formatDateTime(s.pendingCallback.due)}
        </span>
      )}
    </div>
  );
}

function Answers({ answers }: { answers: { label: string; value: string }[] }) {
  if (!answers.length) return null;
  return (
    <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-2 text-sm sm:grid-cols-2">
      {answers.map((a) => (
        <div key={a.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{a.label}</dt>
          <dd className="break-words">{a.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Marks what came from another lead with the same number (deleted, or in another campaign). */
function Earlier({ item }: { item: HistoryItem }) {
  const o = item.earlierLead;
  if (!o) return null;
  const text =
    // deleted unknown = an older reply, which only had deleted leads
    (o.deleted ?? true)
      ? `earlier lead${o.name ? ` ${o.name}` : ''} (deleted)`
      : o.campaign
        ? `other lead · ${o.campaign}`
        : 'other lead';
  return <Badge className="ml-1 bg-muted text-muted-foreground">{text}</Badge>;
}

/** "Field: from → to" lines. */
function Changes({ changes }: { changes: { field: string; from: unknown; to: unknown }[] }) {
  return (
    <ul className="mt-1 text-sm text-muted-foreground">
      {changes.map((c) => (
        <li key={c.field}>
          {c.field}: {show(c.from)} → <span className="text-foreground">{show(c.to)}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ icon, title, at, children }: { icon: ReactNode; title: ReactNode; at: string; children?: ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className="z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <div className="text-sm">{title}</div>
          <time className="text-xs whitespace-nowrap text-muted-foreground" dateTime={at}>
            {formatDateTime(at)}
          </time>
        </div>
        {children}
      </div>
    </li>
  );
}

function CallRow({
  item,
  playing,
  onPlay,
}: {
  item: Extract<HistoryItem, { type: 'call' }>;
  playing: boolean;
  onPlay: () => void;
}) {
  const answered = item.result === 'Answered';
  return (
    <Row
      at={item.at}
      icon={
        item.direction === 'inbound' ? <PhoneIncoming className="size-3.5" /> : <PhoneOutgoing className="size-3.5" />
      }
      title={
        <>
          <b>{item.direction === 'inbound' ? 'Inbound' : 'Outbound'} call</b>
          {item.agent && <> · {item.agent}</>} <Earlier item={item} />{' '}
          <Badge
            className={cn(
              'ml-1',
              answered ? 'bg-status-available/15 text-status-available' : 'bg-muted text-muted-foreground',
            )}
          >
            {item.result}
            {item.talkSeconds ? ` · ${formatSeconds(item.talkSeconds)}` : ''}
          </Badge>
        </>
      }
    >
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {item.outcome && (
          <span>
            Outcome <b className="text-foreground">{item.outcome}</b>
          </span>
        )}
        {item.callbackAt && <span>callback {formatDateTime(item.callbackAt)}</span>}
        {item.transferred && <span>transferred</span>}
        {item.recorded &&
          (item.recordingUrl ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={onPlay}
              aria-label={`Play recording of call ${item.callId}`}
            >
              {playing ? <X /> : <Play />} Recording
            </Button>
          ) : (
            <span>recorded</span>
          ))}
      </div>
      {item.note && <p className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-sm">“{item.note}”</p>}
      {playing && item.recordingUrl && (
        <RecordingPlayer
          src={item.recordingUrl}
          label={`Recording of call ${item.callId}`}
          seconds={item.talkSeconds}
          className="mt-2"
        />
      )}
    </Row>
  );
}

function Timeline({ items }: { items: HistoryItem[] }) {
  const [playing, setPlaying] = useState<number | null>(null);
  return (
    <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-3.5 before:w-px before:bg-border">
      {items.map((item, i) => {
        const key = `${item.type}-${i}`;
        switch (item.type) {
          case 'call':
            return (
              <CallRow
                key={key}
                item={item}
                playing={playing === item.callId}
                onPlay={() => setPlaying(playing === item.callId ? null : item.callId)}
              />
            );
          case 'outcome':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<Tag className="size-3.5" />}
                title={
                  <>
                    Outcome <b>{item.outcome}</b>
                    {item.agent && <> · {item.agent}</>}
                    <Earlier item={item} />
                  </>
                }
              >
                {item.note && <p className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-sm">“{item.note}”</p>}
              </Row>
            );
          case 'form':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<FileText className="size-3.5" />}
                title={
                  <>
                    <b>{item.form}</b> saved{item.agent && <> by {item.agent}</>}
                    <Earlier item={item} />
                  </>
                }
              >
                {/* What changed; saves from before that was kept show their answers. */}
                {item.changes ? (
                  item.changes.length ? (
                    <Changes changes={item.changes} />
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">No changes.</p>
                  )
                ) : (
                  <Answers answers={item.answers} />
                )}
              </Row>
            );
          case 'callback':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<CalendarClock className="size-3.5" />}
                title={
                  <>
                    Callback for <b>{formatDateTime(item.due)}</b>
                    {item.agent && <> set by {item.agent}</>}
                    {item.owner ? ` (for ${item.owner})` : ' (any agent)'}{' '}
                    <Badge className="ml-1 bg-muted text-muted-foreground">{item.status}</Badge>
                  </>
                }
              >
                {item.note && <p className="mt-1 text-sm text-muted-foreground">“{item.note}”</p>}
              </Row>
            );
          case 'edit':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<Pencil className="size-3.5" />}
                title={
                  <>
                    Details changed{item.agent && <> by {item.agent}</>}
                    {item.source && <span className="text-muted-foreground"> · {item.source}</span>}
                  </>
                }
              >
                <Changes changes={item.changes} />
              </Row>
            );
          case 'deleted':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<Trash2 className="size-3.5" />}
                title={
                  <>
                    Lead {item.earlierLead?.name ? <b>{item.earlierLead.name}</b> : ''} deleted
                    <span className="text-muted-foreground"> - the number came back as this lead later</span>
                  </>
                }
              />
            );
          case 'created':
            return (
              <Row
                key={key}
                at={item.at}
                icon={<Plus className="size-3.5" />}
                title={
                  <>
                    Lead added{item.campaign && <> to {item.campaign}</>}
                    {item.list && <> ({item.list})</>}
                    <Earlier item={item} />
                  </>
                }
              />
            );
        }
      })}
    </ol>
  );
}

/**
 * The history of a lead. `collapsible`: the agent screen shows the summary
 * and opens the full timeline on demand (the call itself needs the room).
 */
export function CustomerHistory({
  side,
  leadId,
  collapsible = false,
}: {
  side: HistorySide;
  leadId: number;
  collapsible?: boolean;
}) {
  const q = useLeadHistory(side, leadId);
  const [open, setOpen] = useState(!collapsible);
  if (q.isPending) return <Skeleton className="h-16" />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const h = q.data;
  return (
    <section aria-label="Customer history" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <History className="size-4" /> Customer history
        </h3>
        {collapsible && (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : `Show all (${h.timeline.length})`}
          </Button>
        )}
      </div>
      <Summary h={h} />
      {h.latestForm && (
        <div>
          <div className="text-xs text-muted-foreground">
            Last form: <b>{h.latestForm.form}</b>
            {h.latestForm.agent && <> by {h.latestForm.agent}</>} · {formatDateTime(h.latestForm.at)}
          </div>
          <Answers answers={h.latestForm.answers} />
        </div>
      )}
      {open && <Timeline items={h.timeline} />}
    </section>
  );
}
