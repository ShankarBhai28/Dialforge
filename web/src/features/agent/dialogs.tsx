import { useEffect, useState } from 'react';
import { useNow } from '@/lib/hooks';
import { useMutation } from '@tanstack/react-query';
import { Phone, PhoneIncoming, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FormError } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { toDateTimeLocal } from '@/lib/format';
import { useAgentDispositions, useAgentQueues, type Disposition, useCampaignInfo } from './api';
import { useController } from './AgentProvider';
import { QueueChoices } from './QueueChoices';
import type { OutcomeTarget } from './controller';
import { startRingtone, stopRingtone } from './softphone/ringtone';

/** Accept / Reject for calls in campaigns without auto-answer. Rings and flashes the tab title. */
export function IncomingCallDialog() {
  const { controller, state } = useController();
  const incoming = state.incoming;

  useEffect(() => {
    if (!incoming) return;
    startRingtone();
    const original = document.title;
    let flip = false;
    const t = setInterval(() => {
      flip = !flip;
      document.title = flip ? `📞 Incoming call ${incoming.number}` : `${incoming.name || incoming.number} calling…`;
    }, 1000);
    return () => {
      clearInterval(t);
      stopRingtone();
      document.title = original;
    };
  }, [incoming]);

  return (
    <Dialog open={!!incoming} onOpenChange={() => {}}>
      <DialogContent
        size="sm"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <div className="flex size-14 animate-pulse items-center justify-center rounded-full bg-status-available/15 text-status-available">
            <PhoneIncoming className="size-7" />
          </div>
          <DialogTitle className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Incoming call
          </DialogTitle>
          <DialogDescription className="sr-only">Accept or reject the call</DialogDescription>
          {incoming?.name && <div className="text-base font-bold">{incoming.name}</div>}
          <div className="text-2xl font-extrabold tabular-nums">{incoming?.number}</div>
          <div className="mt-4 flex gap-4">
            <Button variant="destructive" size="lg" onClick={() => controller.reject()}>
              <PhoneOff /> Reject
            </Button>
            <Button
              size="lg"
              className="bg-status-available hover:bg-status-available/90"
              onClick={() => controller.accept()}
            >
              <Phone /> Accept
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Change queues…: the campaign rows again (main queue + which of its other queues). */
export function QueuePickerDialog() {
  const { controller, state } = useController();
  const queues = useAgentQueues(state.queuePickerOpen);
  return (
    <Dialog open={state.queuePickerOpen} onOpenChange={(v) => !v && controller.closeQueuePicker()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Select a queue</DialogTitle>
          <DialogDescription>Pick which queue you're working before going Available.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2 pb-5">
          {queues.isPending ? (
            <Skeleton className="h-12" />
          ) : queues.error ? (
            <ErrorState message={queues.error.message} onRetry={() => queues.refetch()} />
          ) : queues.data.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">
              No campaigns are assigned to your team yet - ask your admin to map one.
            </p>
          ) : (
            <QueueChoices
              queues={queues.data}
              lastQueueId={state.queue?.id ?? null}
              lastExtraIds={state.extraQueueIds}
              busyId={null}
              onGo={(c) => void controller.selectQueue(c.queue, c.extraQueueIds)}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Suggested callback time, for <input type="datetime-local">. */
const oneHourFromNow = () => toDateTimeLocal(Date.now() + 60 * 60 * 1000);

/**
 * After every answered call: the disposition. Callback dispositions ask for a
 * time. With auto disposition on (campaign), a countdown saves the campaign's
 * chosen disposition when the agent gives none in time; it pauses while the
 * agent is filling in a callback.
 */
export function OutcomeDialog() {
  const { controller, state } = useController();
  const target = state.outcomeFor;
  const dispositions = useAgentDispositions();
  const [callbackFor, setCallbackFor] = useState<Disposition | null>(null);
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  const [mine, setMine] = useState(true);
  const [forTarget, setForTarget] = useState<OutcomeTarget | null>(null);
  // A new outcome starts clean (adjusted during render).
  if (target !== forTarget) {
    setForTarget(target);
    setCallbackFor(null);
    setNote('');
    setMine(true);
  }
  const save = useMutation({
    mutationFn: (v: { status: string; extra?: { callbackAt?: string; callbackMine?: boolean; note?: string } }) =>
      controller.saveOutcome(target!, v.status, v.extra),
    meta: { errorInline: true },
  });

  // Each new popup: a fresh list (never offer one an admin just removed) and a
  // clean save state - the previous call's save must not stop this one's auto disposition.
  useEffect(() => {
    if (!target) return;
    save.reset();
    void dispositions.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new popup opens
  }, [target]);

  // Auto disposition: not for a disposition given later from the call log.
  const info = useCampaignInfo(!!target && !target.late);
  const auto = target && !target.late ? (info.data?.autoDispo ?? null) : null;
  const now = useNow();
  const [openedAt, setOpenedAt] = useState<{ for: OutcomeTarget | null; at: number }>({ for: null, at: 0 });
  if (target && openedAt.for !== target) setOpenedAt({ for: target, at: now }); // the page clock (ticks each second)
  const left = auto ? Math.max(0, Math.ceil(auto.seconds - (now - openedAt.at) / 1000)) : null;
  const autoDue = auto && left === 0 && !callbackFor && !save.isPending && !save.isSuccess && !save.isError;
  useEffect(() => {
    if (autoDue && auto) save.mutate({ status: auto.code, extra: { note: 'Auto disposition (none given in time)' } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the countdown reaches 0
  }, [autoDue]);

  function pick(d: Disposition) {
    if (d.is_callback) {
      setCallbackFor(d);
      setAt(oneHourFromNow());
      return;
    }
    save.mutate({ status: d.code });
  }
  function confirmCallback() {
    if (!callbackFor) return;
    if (!at) return;
    // Browser local time -> UTC for the server.
    save.mutate({
      status: callbackFor.code,
      extra: { callbackAt: new Date(at).toISOString(), callbackMine: mine, note: note.trim() },
    });
  }

  return (
    <Dialog open={!!target} onOpenChange={() => {}}>
      <DialogContent
        size="sm"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Disposition</DialogTitle>
          <DialogDescription>
            Choose the disposition for the call with {target?.name || target?.phone}.
          </DialogDescription>
          {auto && left !== null && (
            <div className="space-y-1">
              <p role="timer" className="text-sm font-medium text-status-break">
                {callbackFor
                  ? 'Auto disposition paused while you set the callback.'
                  : `Auto disposition in ${left}s: ${auto.label}`}
              </p>
              {!callbackFor && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-status-break transition-[width] duration-1000 ease-linear"
                    style={{ width: `${(left / auto.seconds) * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </DialogHeader>
        <DialogBody className="space-y-2 pb-5">
          {dispositions.isPending ? (
            <Skeleton className="h-24" />
          ) : dispositions.error ? (
            // The dialog can't be closed without a disposition, so never leave it empty.
            <ErrorState message={dispositions.error.message} onRetry={() => dispositions.refetch()} />
          ) : (
            (dispositions.data ?? []).map((d) => (
              <button
                key={d.code}
                type="button"
                disabled={save.isPending}
                onClick={() => pick(d)}
                className="flex w-full cursor-pointer items-center justify-between rounded-md border px-4 py-2.5 text-left text-sm font-semibold hover:border-primary hover:bg-accent/40 disabled:opacity-50"
                aria-pressed={callbackFor?.code === d.code}
              >
                {d.label}
                {auto && auto.code === d.code && (
                  <span className="text-xs font-normal text-status-break">saved automatically</span>
                )}
              </button>
            ))
          )}
          {callbackFor && (
            <div className="space-y-3 border-t pt-3">
              <p className="text-sm font-bold">Schedule callback</p>
              <Field id="cb-at" label="When">
                <Input id="cb-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
              </Field>
              <Field id="cb-note" label="Note (optional)">
                <Input id="cb-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only I should call back
              </label>
              <Button onClick={confirmCallback} disabled={save.isPending || !at} className="w-full">
                Confirm callback
              </Button>
            </div>
          )}
          <FormError message={save.error?.message} />
          {target?.late && (
            <Button variant="ghost" className="w-full" onClick={() => controller.cancelLateOutcome()}>
              Cancel
            </Button>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
