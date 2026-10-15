// One lead in full (Leads -> click a lead): who they are, where they stand
// in the dialer, their form answers, and every call / outcome / callback /
// change below. A deleted lead still opens, read-only.
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { toastDeleted } from '@/lib/deleted';
import { useCan } from '@/features/auth/access';
import { CustomerHistory } from '@/features/history/CustomerHistory';
import { useDeleteLead, useLeadDetail, type LeadDetail } from './api';
import { LeadDialog } from './LeadDialog';
import { statusLabel } from './statuses';

const none = <span className="text-muted-foreground">—</span>;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

/** Where the lead stands for the dialer, in plain words. */
function dialState(l: LeadDetail): { tone: 'green' | 'grey' | 'amber' | 'red' | 'blue'; text: string } {
  if (l.deleted_at) return { tone: 'red', text: 'Deleted' };
  if (l.on_dnc || l.status === 'do_not_call') return { tone: 'red', text: 'Do Not Call' };
  if (l.assigned_to) return { tone: 'blue', text: `Given to ${l.assigned_to}` };
  if (l.is_final) return { tone: 'grey', text: 'Done - no more calls' };
  if (!l.campaign_id) return { tone: 'grey', text: 'Not in a campaign' };
  if (l.list_active === 0) return { tone: 'amber', text: 'List inactive' };
  if (l.next_call_at && new Date(l.next_call_at) > new Date())
    return { tone: 'amber', text: `Next call ${formatDateTime(l.next_call_at)}` };
  return { tone: 'green', text: 'Dialable now' };
}

export function LeadDetailPage() {
  const id = Number(useParams().id);
  const lead = useLeadDetail(id);
  const can = useCan('leads');
  const remove = useDeleteLead();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (lead.isPending) return <Skeleton className="h-64" />;
  if (lead.error) return <ErrorState message={lead.error.message} onRetry={() => lead.refetch()} />;
  const l = lead.data;
  const state = dialState(l);
  const answers = Object.entries(l.custom_data ?? {}).filter(([, v]) => v !== '' && v != null);
  const labelOf = (key: string) => l.form_fields.find((f) => f.key === key)?.label ?? key;

  return (
    <div className="grid gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin/leads">
            <ArrowLeft /> All leads
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-5 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold break-words">{l.name || 'No name'}</h2>
              <p className="text-lg tabular-nums">{l.phone}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StatusPill tone={state.tone}>{state.text}</StatusPill>
                <StatusPill tone="grey">{statusLabel(l.status)}</StatusPill>
                {l.callback_at && <StatusPill tone="blue">Callback {formatDateTime(l.callback_at)}</StatusPill>}
              </div>
            </div>
            {!l.deleted_at && (
              <div className="flex flex-wrap gap-2">
                {can('edit') && (
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    <Pencil /> Edit
                  </Button>
                )}
                {can('delete') && (
                  <Button variant="outline" className="text-destructive" onClick={() => setDeleting(true)}>
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
            )}
          </div>

          {l.deleted_at && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              Deleted {formatDateTime(l.deleted_at)}
              {l.deleted_by_name && ` by ${l.deleted_by_name}`}. It isn't dialled any more; its history is kept below.
            </p>
          )}

          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Campaign">{l.campaign_name ?? none}</Fact>
            <Fact label="List">
              {l.list_name ?? none}
              {l.list_active === 0 && <span className="text-muted-foreground"> (inactive)</span>}
            </Fact>
            <Fact label="Given to agent">
              {l.assigned_to ?? <span className="text-muted-foreground">Nobody (shared)</span>}
            </Fact>
            <Fact label="Alt phone">{l.alt_phone ?? none}</Fact>
            <Fact label="Attempts">
              <span className="tabular-nums">{l.attempts}</span>
            </Fact>
            <Fact label="Last call">{l.last_attempt_at ? formatDateTime(l.last_attempt_at) : none}</Fact>
            <Fact label="Next call">{l.next_call_at ? formatDateTime(l.next_call_at) : none}</Fact>
            <Fact label="Priority">
              <span className="tabular-nums">{l.priority}</span>
            </Fact>
            <Fact label="On the DNC list">{l.on_dnc ? 'Yes' : 'No'}</Fact>
            <Fact label="Created">{formatDateTime(l.created_at)}</Fact>
            <Fact label="Last changed by">{l.updated_by_name ?? none}</Fact>
            <Fact label="Lead ID">
              <span className="tabular-nums">{l.id}</span>
            </Fact>
          </dl>

          {answers.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-sm font-bold">Form answers</h3>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {answers.map(([k, v]) => (
                  <Fact key={k} label={labelOf(k)}>
                    {Array.isArray(v) ? v.join(', ') : String(v)}
                  </Fact>
                ))}
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 pt-5">
          <div>
            <h3 className="text-base font-bold">History</h3>
            <p className="text-sm text-muted-foreground">
              Every call, outcome, form, callback and change - newest first.
            </p>
          </div>
          <CustomerHistory side="admin" leadId={l.id} />
        </CardContent>
      </Card>

      {editing && <LeadDialog lead={l} onOpenChange={(v) => !v && setEditing(false)} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(false);
            remove.reset();
          }
        }}
        title={`Delete lead "${l.phone}"?`}
        description="It's no longer dialled or shown; a pending callback is cancelled. Its past calls and answers are kept."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          remove.mutate(l.id, {
            onSuccess: (r) => {
              toastDeleted('Lead', r);
              navigate('/admin/leads');
            },
          })
        }
      />
    </div>
  );
}
