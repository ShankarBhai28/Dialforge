// Middle column: status line, the preview lead (preview campaigns), and the
// open customer - details + the campaign's form.
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ClipboardList, Phone, SkipForward, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormError } from '@/components/common';
import { post } from '@/lib/api';
import { cn } from '@/lib/utils';
import { dispositionLabel, isDncStatus, useAgentDispositions, useAgentForm, type AgentForm, type Lead } from './api';
import { FieldInput, fieldValues, type FieldValues } from '@/features/forms/FieldInput';
import { useController, usePhone } from './AgentProvider';
import { LeadStatusChip } from './LeadsPanel';

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

function PreviewCard() {
  const { controller, state } = useController();
  const { data: form } = useAgentForm();
  const { data: dispositions } = useAgentDispositions();
  const { preview, previewBusy } = state;
  const lead = preview.lead;
  const [left, setLeft] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const [countingFor, setCountingFor] = useState<number | null>(null);

  // A new lead restarts the optional auto-dial countdown (adjusted during render).
  const leadId = lead?.id ?? null;
  if (leadId !== countingFor) {
    setCountingFor(leadId);
    setStopped(false);
    setLeft(leadId && preview.autodialSec ? preview.autodialSec : null);
  }
  useEffect(() => {
    if (left === null || stopped) return;
    if (left <= 0) {
      void controller.previewDial();
      return;
    }
    const t = setTimeout(() => setLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [left, stopped, controller]);

  if (!preview.enabled) return null;
  const labels = Object.fromEntries((form?.fields ?? []).map((f) => [f.field_key, f.label]));
  return (
    <Card className="border-l-4 border-primary">
      <CardHeader>
        <CardTitle>Preview - Next Lead</CardTitle>
      </CardHeader>
      <CardContent>
        {!lead ? (
          <p className="text-sm text-muted-foreground">
            {previewBusy ? 'Getting the next lead…' : preview.blocker || 'Waiting for the next lead…'}
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-lg font-bold">{lead.name || 'Unknown name'}</div>
              <div className="text-sm tabular-nums">
                {lead.phone}
                {lead.alt_phone && ` · alt ${lead.alt_phone}`}
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>List: {lead.list_name || '—'}</span>
              <span>Attempts so far: {lead.attempts ?? 0}</span>
              <span>Last outcome: {dispositionLabel(lead.status, dispositions)}</span>
              {lead.is_callback && (
                <span className="font-bold text-status-break">
                  Callback{lead.callback_note ? `: ${lead.callback_note}` : ''}
                </span>
              )}
            </div>
            {lead.custom_data && Object.keys(lead.custom_data).length > 0 && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-2.5 text-sm">
                {Object.entries(lead.custom_data).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-muted-foreground">{labels[k] ?? k}</dt>
                    <dd>{show(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void controller.previewDial()} disabled={previewBusy}>
                <Phone /> Dial
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setStopped(true);
                  void controller.previewSkip();
                }}
                disabled={previewBusy}
              >
                <SkipForward /> Skip
              </Button>
              {left !== null && !stopped && (
                <span className="text-sm text-muted-foreground">
                  Auto-dial in {left}s ·{' '}
                  <button
                    type="button"
                    className="cursor-pointer text-primary underline"
                    onClick={() => setStopped(true)}
                  >
                    stop
                  </button>
                </span>
              )}
              {stopped && left !== null && <span className="text-sm text-muted-foreground">Auto-dial stopped</span>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeadDetail({
  lead,
  contextText,
  formKeys,
}: {
  lead: Lead | null;
  contextText: string;
  formKeys: Set<string>;
}) {
  const { controller, state } = useController();
  const { data: dispositions } = useAgentDispositions();
  const l = lead ?? { name: contextText, phone: '' };
  const extra = Object.entries(lead?.custom_data ?? {}).filter(
    ([k, v]) => !formKeys.has(k) && v !== null && v !== undefined && v !== '',
  );
  const canCall = !!lead && !!lead.phone && !isDncStatus(lead.status, dispositions) && !state.call;
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <UserRound className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">{l.name || 'No name'}</div>
            <div className="tabular-nums text-muted-foreground">{l.phone}</div>
          </div>
          {canCall && (
            <Button size="sm" onClick={() => void controller.callLead(lead, lead.phone)}>
              <Phone /> Call
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => controller.closeWorkspace()} aria-label="Close lead">
            <X />
          </Button>
        </div>
        {lead && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {lead.status && (
              <span className="flex items-center gap-1.5">
                Status <LeadStatusChip status={lead.status} />
              </span>
            )}
            {lead.attempts != null && <span>Attempts {lead.attempts}</span>}
            {lead.list_name && <span>List {lead.list_name}</span>}
            {lead.alt_phone && <span>Alt {lead.alt_phone}</span>}
          </div>
        )}
        {extra.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-2.5 text-sm">
            {extra.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd>{show(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function AgentFormCard({ form }: { form: AgentForm }) {
  const { controller, state } = useController();
  const ws = state.workspace;
  const [values, setValues] = useState<FieldValues>(() => fieldValues(form.fields, ws.lead?.custom_data));
  const save = useMutation({
    mutationFn: () => post('/agent/form-responses', { leadId: ws.lead?.id ?? null, callId: ws.callId, data: values }),
    meta: { errorInline: true },
    onSuccess: () => controller.formSaved(),
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" /> {form.name}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {ws.contextText
            ? `Saving against: ${ws.contextText}`
            : 'Not linked to a lead - answers will be saved without one.'}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {form.fields.map((f) => (
              <FieldInput
                key={f.field_key}
                f={f}
                value={values[f.field_key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.field_key]: v }))}
              />
            ))}
          </div>
          <FormError message={save.error?.message} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              Save Form
            </Button>
            <Button type="button" variant="outline" onClick={() => controller.closeWorkspace()}>
              Clear
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function Workspace() {
  const { state, controller } = useController();
  const { line } = usePhone();
  const { data: form } = useAgentForm();
  const ws = state.workspace;
  const open = !!ws.lead || !!line.call || ws.blankOpen || !!ws.contextText;
  const formKeys = new Set((form?.fields ?? []).map((f) => f.field_key));
  return (
    <div className="space-y-4">
      {state.message && (
        <p
          role="status"
          className={cn('text-sm font-medium', state.message.error ? 'text-destructive' : 'text-status-available')}
        >
          {state.message.text}
        </p>
      )}
      <PreviewCard />
      {!open ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-10 text-center">
          <UserRound className="size-8 text-muted-foreground/60" />
          <p className="font-semibold">No customer selected</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Click a lead on the left, or take a call - the customer's details and form open here.
          </p>
          <Button variant="outline" size="sm" onClick={() => controller.openBlankForm()}>
            Open form without a lead
          </Button>
        </div>
      ) : (
        <>
          {(ws.lead || ws.contextText) && (
            <LeadDetail lead={ws.lead} contextText={ws.contextText} formKeys={formKeys} />
          )}
          {form ? (
            <AgentFormCard key={ws.formVersion} form={form} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This campaign has no form - pick the outcome when the call ends.
            </p>
          )}
        </>
      )}
    </div>
  );
}
