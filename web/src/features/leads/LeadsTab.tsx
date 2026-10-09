// All leads (latest 200 from the server), filtered in the browser, with edit
// and delete.
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BookUser, Pencil, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, Field, FormError, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useCampaigns } from '@/features/campaigns/api';
import { useDeleteLead, useDispositions, useLeads, useLists, useSaveLead, type Lead } from './api';
import { DEFAULT_DISPOSITIONS, statusLabel } from './statuses';

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

function LeadDialog({ lead, onOpenChange }: { lead: Lead; onOpenChange: (open: boolean) => void }) {
  const campaigns = useCampaigns();
  const lists = useLists();
  const save = useSaveLead();
  const [name, setName] = useState(lead.name ?? '');
  const [phone, setPhone] = useState(lead.phone);
  const [campaignId, setCampaignId] = useState(lead.campaign_id ? String(lead.campaign_id) : '');
  const [listId, setListId] = useState(lead.list_id ? String(lead.list_id) : '');
  const [status, setStatus] = useState(lead.status);

  // The server checks status against the chosen campaign's dispositions
  // (or the defaults when unassigned), so offer exactly those.
  const dispositions = useDispositions(campaignId ? Number(campaignId) : null);
  const choices = campaignId ? (dispositions.data ?? []) : DEFAULT_DISPOSITIONS;
  const statusOptions = [{ code: 'new', label: 'New' }, ...choices];
  if (!statusOptions.some((o) => o.code === status)) statusOptions.push({ code: status, label: statusLabel(status) });

  // Picking a list moves the lead to that list's campaign too.
  function onListChange(value: string) {
    setListId(value);
    const l = lists.data?.find((x) => String(x.id) === value);
    if (l) setCampaignId(String(l.campaign_id));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        id: lead.id,
        name: name.trim(),
        phone: phone.trim(),
        campaignId: campaignId ? Number(campaignId) : null,
        listId: listId ? Number(listId) : null,
        status,
      },
      {
        onSuccess: () => {
          toast.success('Lead saved');
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Edit lead {lead.phone}</DialogTitle>
            <DialogDescription>Changing the list also moves the lead to that list's campaign.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="lead-name" label="Name">
              <Input id="lead-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="lead-phone" label="Phone" hint="7-15 digits, optional leading +.">
              <Input
                id="lead-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                required
              />
            </Field>
            <Field id="lead-campaign" label="Campaign">
              <Select id="lead-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">Unassigned</option>
                {campaigns.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="lead-list" label="List">
              <Select id="lead-list" value={listId} onChange={(e) => onListChange(e.target.value)}>
                <option value="">No list</option>
                {lists.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.campaign_name ?? 'no campaign'})
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="lead-status" label="Status" hint="The campaign's own dispositions.">
              <Select id="lead-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {statusOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <FormError message={save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LeadsTab() {
  const leads = useLeads();
  const remove = useDeleteLead();
  const [editing, setEditing] = useState<Lead | null>(null);
  const [deleting, setDeleting] = useState<Lead | null>(null);
  const [search, setSearch] = useState('');
  const [campaign, setCampaign] = useState('');
  const [list, setList] = useState('');
  const [status, setStatus] = useState('');

  // Filter choices come from the leads actually loaded.
  const options = useMemo(() => {
    const rows = leads.data ?? [];
    const uniq = <T,>(pairs: [string, T][]) => [...new Map(pairs).entries()];
    return {
      campaigns: uniq(rows.map((l) => [String(l.campaign_id ?? ''), l.campaign_name ?? 'Unassigned'])),
      lists: uniq(rows.filter((l) => l.list_id).map((l) => [String(l.list_id), l.list_name ?? `#${l.list_id}`])),
      statuses: [...new Set(rows.map((l) => l.status))],
    };
  }, [leads.data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (leads.data ?? []).filter(
      (l) =>
        (!q || l.phone.includes(q) || (l.name ?? '').toLowerCase().includes(q)) &&
        (campaign === '' || String(l.campaign_id ?? '') === campaign.slice(1)) &&
        (list === '' || String(l.list_id) === list) &&
        (status === '' || l.status === status),
    );
  }, [leads.data, search, campaign, list, status]);

  return (
    <>
      <SectionHeader
        title="All leads"
        description="The latest 200 leads across every campaign. Add leads by importing a file into a list."
      />
      {leads.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : leads.error ? (
        <ErrorState message={leads.error.message} onRetry={() => leads.refetch()} />
      ) : leads.data.length === 0 ? (
        <EmptyState icon={BookUser} title="No leads yet">
          Create a list, then import an .xlsx or .csv file into it.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search name or phone"
                placeholder="Search name or phone"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {/* "c" prefix: an empty campaign id (Unassigned) must differ from "all" */}
            <Select aria-label="Filter by campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">All campaigns</option>
              {options.campaigns.map(([id, label]) => (
                <option key={id} value={`c${id}`}>
                  {label}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by list" value={list} onChange={(e) => setList(e.target.value)}>
              <option value="">All lists</option>
              {options.lists.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {options.statuses.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </Select>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Showing {shown.length} of {leads.data.length}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>List</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-semibold">{l.name || muted('—')}</TableCell>
                    <TableCell className="tabular-nums">{l.phone}</TableCell>
                    <TableCell>{l.campaign_name ?? muted('Unassigned')}</TableCell>
                    <TableCell>{l.list_name ?? muted('—')}</TableCell>
                    <TableCell>{statusLabel(l.status)}</TableCell>
                    <TableCell className="tabular-nums">{l.attempts}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(l.created_at)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(l)} aria-label={`Edit ${l.phone}`}>
                        <Pencil /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(l)}
                        aria-label={`Delete ${l.phone}`}
                      >
                        <Trash2 /> Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </>
      )}

      {editing && <LeadDialog key={editing.id} lead={editing} onOpenChange={(v) => !v && setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete lead "${deleting?.phone}"?`}
        description="Leads with call records, form responses or callbacks can't be deleted."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Lead deleted');
              setDeleting(null);
            },
          })
        }
      />
    </>
  );
}
