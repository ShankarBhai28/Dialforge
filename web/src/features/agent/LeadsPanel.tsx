// Left column: the campaign's leads (search, add, open, call) and the
// agent's callbacks.
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FormError, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { post } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import {
  agentKeys,
  dispositionLabel,
  isDncStatus,
  useAgentCallbacks,
  useAgentDispositions,
  useAgentLeads,
  type Lead,
} from './api';
import { useController } from './AgentProvider';

export function LeadStatusChip({ status }: { status: string }) {
  const { data: dispositions } = useAgentDispositions();
  const tone = status === 'new' ? 'blue' : isDncStatus(status, dispositions) ? 'red' : 'grey';
  return <StatusPill tone={tone}>{dispositionLabel(status, dispositions)}</StatusPill>;
}

function AddLead({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useMutation({
    mutationFn: () => post<Lead>('/leads', { name: name.trim() || null, phone: phone.trim() }),
    meta: { errorInline: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.leads });
      onDone();
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-2 rounded-md border bg-muted/40 p-2.5">
      <Input
        placeholder="Name (optional)"
        aria-label="Lead name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        placeholder="Phone / extension"
        aria-label="Lead phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        required
        autoFocus
        inputMode="tel"
      />
      <FormError message={add.error?.message} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={add.isPending}>
          Add lead
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LeadsList() {
  const leads = useAgentLeads();
  const { data: dispositions } = useAgentDispositions();
  const { controller, state } = useController();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const needle = q.trim().toLowerCase();
  const rows = (leads.data ?? []).filter(
    (l) => !needle || (l.name ?? '').toLowerCase().includes(needle) || String(l.phone).includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-2">
        <Input
          placeholder="Search name or number"
          aria-label="Search leads"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button variant="outline" onClick={() => setAdding((v) => !v)} aria-label="Add a lead">
          <Plus /> Add
        </Button>
      </div>
      {adding && <AddLead onDone={() => setAdding(false)} />}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {leads.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : leads.error ? (
          <ErrorState message={leads.error.message} onRetry={() => leads.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {needle ? 'No leads match.' : 'No leads yet - use + Add.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((lead) => (
              <li key={lead.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => controller.selectLead(lead)}
                  onKeyDown={(e) => e.key === 'Enter' && controller.selectLead(lead)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md border p-2.5 transition-colors hover:bg-muted/60',
                    state.workspace.lead?.id === lead.id && 'border-primary bg-accent/50',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{lead.name || 'No name'}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">{lead.phone}</span>
                      <LeadStatusChip status={lead.status} />
                    </div>
                  </div>
                  {!isDncStatus(lead.status, dispositions) && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Call ${lead.name || lead.phone}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void controller.callLead(lead, lead.phone);
                      }}
                    >
                      <Phone /> Call
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CallbacksList() {
  const callbacks = useAgentCallbacks();
  const { controller } = useController();
  const now = useNow(30_000);
  if (callbacks.isPending) return <Skeleton className="h-20" />;
  if (callbacks.error) return <ErrorState message={callbacks.error.message} onRetry={() => callbacks.refetch()} />;
  if (!callbacks.data.length)
    return <p className="py-8 text-center text-sm text-muted-foreground">No callbacks scheduled.</p>;
  return (
    <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
      {callbacks.data.map((cb) => {
        const due = new Date(cb.callback_at).getTime() <= now;
        return (
          <li key={cb.id} className="flex items-center gap-2 rounded-md border p-2.5">
            <div className="min-w-0 flex-1 text-sm">
              <div className={cn('text-xs', due ? 'font-bold text-destructive' : 'text-muted-foreground')}>
                {formatDateTime(cb.callback_at)}
                {due && ' (due)'}
                {!cb.user_id && ' · anyone'}
              </div>
              <div className="truncate font-semibold">
                {cb.name} <span className="font-normal tabular-nums">{cb.phone}</span>
              </div>
              {cb.note && <div className="truncate text-xs text-muted-foreground">{cb.note}</div>}
            </div>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Call back ${cb.name || cb.phone}`}
              onClick={() =>
                void controller.callLead(
                  { id: cb.lead_id, name: cb.name, phone: cb.phone, status: 'callback' },
                  cb.phone,
                )
              }
            >
              <Phone /> Call
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function LeadsPanel() {
  const leads = useAgentLeads();
  const callbacks = useAgentCallbacks();
  const now = useNow(30_000);
  const due = (callbacks.data ?? []).filter((c) => new Date(c.callback_at).getTime() <= now).length;
  return (
    <Tabs defaultValue="leads" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-full">
        <TabsTrigger value="leads" className="flex-1">
          Leads <span className="rounded-full bg-muted-foreground/15 px-1.5 text-xs">{leads.data?.length ?? 0}</span>
        </TabsTrigger>
        <TabsTrigger value="callbacks" className="flex-1">
          Callbacks{' '}
          <span
            className={cn('rounded-full px-1.5 text-xs', due ? 'bg-destructive text-white' : 'bg-muted-foreground/15')}
            title={due ? `${due} due now` : undefined}
          >
            {callbacks.data?.length ?? 0}
          </span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="leads" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <LeadsList />
      </TabsContent>
      <TabsContent value="callbacks" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <CallbacksList />
      </TabsContent>
    </Tabs>
  );
}
