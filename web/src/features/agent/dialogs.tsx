import { useEffect, useState } from 'react';
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
import { useAgentDispositions, useAgentQueues, type Disposition } from './api';
import { useController } from './AgentProvider';
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
            queues.data.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => void controller.selectQueue({ id: q.id, name: q.name })}
                className="flex w-full cursor-pointer items-center justify-between rounded-md border px-4 py-3 text-left hover:border-primary hover:bg-accent/40"
              >
                <span className="font-semibold">{q.name}</span>
                <span className="text-xs text-muted-foreground">{q.campaign_name}</span>
              </button>
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Suggested callback time, for <input type="datetime-local">. */
const oneHourFromNow = () => toDateTimeLocal(Date.now() + 60 * 60 * 1000);

/** After every answered call: what happened? Callback outcomes ask for a time. */
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
    mutationFn: (v: { status: string; extra?: { callbackAt: string; callbackMine: boolean; note: string } }) =>
      controller.saveOutcome(target!, v.status, v.extra),
    meta: { errorInline: true },
  });

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
          <DialogTitle>Call outcome</DialogTitle>
          <DialogDescription>What happened on the call with {target?.name || target?.phone}?</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2 pb-5">
          {dispositions.isPending ? (
            <Skeleton className="h-24" />
          ) : dispositions.error ? (
            // The dialog can't be closed without an outcome, so never leave it empty.
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
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
