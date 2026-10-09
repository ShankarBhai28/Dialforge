// Shown for every answered call (bottom-right): who it is, live / on hold,
// a running timer, mute / hold / keypad, transfer and conference.
//
// Transfer: Blind = customer goes straight to the target, the agent is free
// at once. Warm = customer hears music while the agent talks to the target,
// then Complete (hand over), Merge (3-way) or Cancel. Conference = the target
// joins the live call. Targets: an agent, a queue (blind: the customer waits
// in it; warm/conference: a free agent from it) or any number.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Grid3x3, Mic, MicOff, Pause, PhoneForwarded, PhoneOff, Play, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/common';
import { get, post } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { agentKeys, useCallControl, type TransferTargets } from './api';
import { useController, usePhone } from './AgentProvider';

/** ms -> "mm:ss" or "h:mm:ss" */
export function callTimer(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Kind = 'transfer' | 'conference';
type Mode = 'blind' | 'warm';
type TargetType = 'agent' | 'queue' | 'number';

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string, string?][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md bg-muted p-0.5" role="radiogroup">
      {options.map(([v, label, title]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          title={title}
          onClick={() => onChange(v)}
          className={cn(
            'flex-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold',
            value === v ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TransferSection({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const { controller } = useController();
  const [mode, setMode] = useState<Mode>('blind');
  const [targetType, setTargetType] = useState<TargetType>('agent');
  const [picked, setPicked] = useState<string>('');
  const [number, setNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['agent', 'transfer-targets'],
    queryFn: () => get<TransferTargets>('/agent/transfer-targets'),
    staleTime: 0,
  });
  const realMode = kind === 'conference' ? 'conference' : mode;
  const start = useMutation({
    mutationFn: (body: { mode: string; targetType: TargetType; target: string }) =>
      post<{ status: string; to?: string }>('/agent/call/transfer', body),
    meta: { errorInline: true },
    onSuccess: (data) => {
      if (realMode === 'blind') controller.say(`Transferred to ${data.to ?? 'target'}`);
      void qc.invalidateQueries({ queryKey: agentKeys.control });
      onClose();
    },
  });

  function go() {
    setError(null);
    const target = targetType === 'number' ? number.trim() : picked;
    if (!target)
      return setError(
        targetType === 'number' ? 'Enter a number' : `Pick ${targetType === 'agent' ? 'an agent' : 'a queue'}`,
      );
    start.mutate({ mode: realMode, targetType, target });
  }

  const blindQueue = kind === 'transfer' && mode === 'blind';
  const t = targets.data ?? { agents: [], queues: [] };
  const rows =
    targetType === 'agent'
      ? t.agents.map((a) => ({
          value: String(a.userId),
          text: `${a.username} (ext ${a.ext})`,
          meta: a.status,
          off: a.status === 'on a call',
        }))
      : t.queues.map((q) => ({
          value: String(q.id),
          text: q.name,
          meta: `${q.freeAgents} free`,
          off: !blindQueue && q.freeAgents === 0,
        }));

  return (
    <div className="space-y-2 border-t p-3">
      <h4 className="text-sm font-bold">{kind === 'conference' ? 'Add to conference' : 'Transfer call'}</h4>
      {kind === 'transfer' && (
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            ['blind', 'Blind', "Customer goes straight to them; you're free right away"],
            ['warm', 'Warm', 'Customer on hold while you talk to them first'],
          ]}
        />
      )}
      <Segmented
        value={targetType}
        onChange={(v) => {
          setTargetType(v);
          setPicked('');
        }}
        options={[
          ['agent', 'Agent'],
          ['queue', 'Queue'],
          ['number', 'Number'],
        ]}
      />
      {targetType === 'number' ? (
        <Input
          autoFocus
          inputMode="tel"
          placeholder="Phone number or extension"
          aria-label="Number to transfer to"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      ) : targets.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {targetType === 'agent' ? 'No other agents logged in.' : 'No active queues.'}
        </p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto" role="radiogroup">
          {rows.map((r) => (
            <label
              key={r.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                r.off && 'cursor-default opacity-50',
              )}
            >
              <input
                type="radio"
                name="xfer-target"
                className="accent-primary"
                disabled={r.off}
                checked={picked === r.value}
                onChange={() => setPicked(r.value)}
              />
              <span className="flex-1">{r.text}</span>
              <span className="text-xs text-muted-foreground">{r.meta}</span>
            </label>
          ))}
        </div>
      )}
      <FormError message={error ?? start.error?.message} />
      <div className="flex gap-2">
        <Button size="sm" onClick={go} disabled={start.isPending}>
          {start.isPending ? 'Working…' : kind === 'conference' ? 'Add' : mode === 'warm' ? 'Call first' : 'Transfer'}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function ControlSection() {
  const qc = useQueryClient();
  const { line } = usePhone();
  const control = useCallControl(line.call?.phase === 'live');
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => post(`/agent/call/${path}`, body ?? {}),
    meta: { errorInline: true },
    onSettled: () => qc.invalidateQueries({ queryKey: agentKeys.control }),
  });
  const v = control.data;
  if (!v || !v.controlled || !v.parties.length) return null;
  const consult = v.parties.find((p) => p.role === 'warm');
  const members = v.parties.filter((p) => p.role !== 'warm');
  return (
    <div className="space-y-2 border-t p-3">
      <h4 className="text-sm font-bold">
        {consult
          ? consult.state === 'up'
            ? `Talking to ${consult.label} · customer on hold`
            : `Calling ${consult.label}… · customer on hold`
          : 'Conference'}
      </h4>
      {members.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-semibold',
              p.state === 'up'
                ? 'bg-status-available/12 text-status-available'
                : 'bg-status-break/12 text-status-break',
            )}
          >
            {p.state === 'up' ? 'In call' : 'Ringing'}
          </span>
          <span className="flex-1 truncate">{p.label}</span>
          <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'drop', body: { partyId: p.id } })}>
            {p.state === 'up' ? 'Drop' : 'Cancel'}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {consult ? (
          <>
            <Button size="sm" onClick={() => act.mutate({ path: 'complete' })}>
              Complete transfer
            </Button>
            {consult.state === 'up' && (
              <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'merge' })}>
                Merge (3-way)
              </Button>
            )}
            <Button size="sm" variant="destructive" onClick={() => act.mutate({ path: 'cancel' })}>
              Cancel
            </Button>
          </>
        ) : (
          members.some((p) => p.state === 'up') && (
            <Button
              size="sm"
              variant="outline"
              title="You leave; the others keep talking"
              onClick={() => act.mutate({ path: 'leave' })}
            >
              Leave conference
            </Button>
          )
        )}
      </div>
      <FormError message={act.error?.message} />
    </div>
  );
}

export function InCallPanel() {
  const { phone, line } = usePhone();
  const { controller, state } = useController();
  const { data: control } = useCallControl(line.call?.phase === 'live');
  const now = useNow();
  const [xfer, setXfer] = useState<Kind | null>(null);
  const [keypad, setKeypad] = useState(false);
  const [dtmf, setDtmf] = useState('');
  const [prevCallId, setPrevCallId] = useState<number | null>(null);

  const call = line.call;
  const info = state.call;
  // A new call starts with closed sections (adjusted during render).
  if ((call?.id ?? null) !== prevCallId) {
    setPrevCallId(call?.id ?? null);
    setXfer(null);
    setKeypad(false);
    setDtmf('');
  }
  if (!call || call.phase !== 'live' || !info) return null;

  const customerOnHold = !!control && control.controlled && control.customerOnHold;
  const phase = info.ringingCustomer ? 'ringing' : call.onHold ? 'hold' : 'live';
  const started = info.talkStartedAt ?? call.answeredAt;
  const elapsed = info.ringingCustomer || !started ? '00:00' : callTimer(now - started);
  const headCls = { ringing: 'bg-status-break', hold: 'bg-status-break', live: 'bg-status-available' }[phase];
  const stateText =
    phase === 'ringing'
      ? 'Ringing customer…'
      : call.onHold
        ? 'On hold'
        : customerOnHold
          ? 'Live · customer on hold'
          : 'Live call';

  const btn = 'flex h-auto flex-col gap-1 py-2 text-xs';
  return (
    <section
      aria-label="Current call"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl bg-card shadow-2xl ring-1 ring-black/5"
    >
      <div className={cn('flex items-center justify-between px-4 py-2 text-sm font-semibold text-white', headCls)}>
        <span className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full bg-white', phase === 'live' && 'animate-pulse')} />
          {stateText}
        </span>
        <span className="tabular-nums">{elapsed}</span>
      </div>
      <div className="px-4 pt-3 pb-2">
        {info.name && <div className="truncate font-bold">{info.name}</div>}
        <div className="text-xl font-extrabold tabular-nums">{info.number || '—'}</div>
        <div className="text-xs text-muted-foreground">
          {[info.kind, state.queue?.name].filter(Boolean).join(' · ')}
        </div>
        {call.muted && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">
            You are muted - the customer can't hear you
          </p>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1.5 px-3 pb-3">
        <Button variant={call.muted ? 'destructive' : 'outline'} className={btn} onClick={() => phone.toggleMute()}>
          {call.muted ? <MicOff /> : <Mic />} {call.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="outline"
          className={cn(btn, call.onHold && 'border-status-break text-status-break')}
          disabled={call.holdPending}
          onClick={() => phone.toggleHold()}
        >
          {call.onHold ? <Play /> : <Pause />} {call.onHold ? 'Resume' : 'Hold'}
        </Button>
        <Button variant={keypad ? 'default' : 'outline'} className={btn} onClick={() => setKeypad((v) => !v)}>
          <Grid3x3 /> Keypad
        </Button>
        <Button
          variant={xfer === 'transfer' ? 'default' : 'outline'}
          className={btn}
          onClick={() => setXfer(xfer === 'transfer' ? null : 'transfer')}
        >
          <PhoneForwarded /> Transfer
        </Button>
        <Button
          variant={xfer === 'conference' ? 'default' : 'outline'}
          className={btn}
          onClick={() => setXfer(xfer === 'conference' ? null : 'conference')}
        >
          <UsersRound /> Conference
        </Button>
        <Button variant="destructive" className={btn} onClick={() => controller.hangup()}>
          <PhoneOff /> Hang up
        </Button>
      </div>
      {keypad && (
        <div className="border-t p-3">
          <div className="grid grid-cols-3 gap-1.5">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => (
              <Button
                key={d}
                variant="outline"
                size="sm"
                onClick={() => {
                  phone.sendDTMF(d);
                  setDtmf((v) => (v + d).slice(-30));
                }}
              >
                {d}
              </Button>
            ))}
          </div>
          {dtmf && <p className="mt-2 text-xs text-muted-foreground">Sent: {dtmf}</p>}
        </div>
      )}
      {xfer && <TransferSection key={xfer} kind={xfer} onClose={() => setXfer(null)} />}
      <ControlSection />
    </section>
  );
}
