// All leads, searched, filtered and paged on the server (GET /admin/leads),
// with edit and delete.
import { useState, type FormEvent } from 'react';
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
import { ConfirmDialog, EmptyState, Field, FormError, Pager, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { useCampaigns } from '@/features/campaigns/api';
import { useForms } from '@/features/forms/api';
import { FieldInput, fieldValues, type FieldValues } from '@/features/forms/FieldInput';
import {
  NO_LEAD_FILTERS,
  useDeleteLead,
  useDispositions,
  useLeads,
  useLists,
  useSaveLead,
  type Lead,
  type LeadFilters,
} from './api';
import { DEFAULT_DISPOSITIONS, statusLabel } from './statuses';

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

function LeadDialog({ lead, onOpenChange }: { lead: Lead; onOpenChange: (open: boolean) => void }) {
  const campaigns = useCampaigns();
  const lists = useLists();
  const save = useSaveLead();
  const [name, setName] = useState(lead.name ?? '');
  const [phone, setPhone] = useState(lead.phone);
  const [altPhone, setAltPhone] = useState(lead.alt_phone ?? '');
  const [priority, setPriority] = useState(String(lead.priority ?? 0));
  const [campaignId, setCampaignId] = useState(lead.campaign_id ? String(lead.campaign_id) : '');
  const [listId, setListId] = useState(lead.list_id ? String(lead.list_id) : '');
  const [status, setStatus] = useState(lead.status);
  const [customEdits, setCustomEdits] = useState<FieldValues>({});

  // The form fields of the campaign the lead is (being moved) in. Saved
  // values for other keys are kept by the server and listed read-only.
  const forms = useForms();
  const formId = campaigns.data?.find((c) => String(c.id) === campaignId)?.form_id;
  const form = formId ? forms.data?.find((f) => f.id === formId) : undefined;
  const fields = form?.fields ?? [];
  const saved = fieldValues(fields, lead.custom_data);
  const customValue = (key: string) => customEdits[key] ?? saved[key];
  const otherSaved = Object.entries(lead.custom_data ?? {}).filter(([k]) => !fields.some((f) => f.field_key === k));

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

  // A list belongs to one campaign, so a different campaign drops the list.
  function onCampaignChange(value: string) {
    setCampaignId(value);
    const l = lists.data?.find((x) => String(x.id) === listId);
    if (l && String(l.campaign_id) !== value) setListId('');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        id: lead.id,
        name: name.trim(),
        phone: phone.trim(),
        altPhone: altPhone.trim(),
        priority: Number(priority),
        // Only when the form is on screen; otherwise the saved values stay as they are.
        customData: fields.length
          ? Object.fromEntries(fields.map((f) => [f.field_key, customValue(f.field_key)]))
          : undefined,
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
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field id="lead-alt-phone" label="Alt phone" hint="Optional second number.">
                <Input
                  id="lead-alt-phone"
                  value={altPhone}
                  onChange={(e) => setAltPhone(e.target.value)}
                  inputMode="tel"
                />
              </Field>
              <Field id="lead-priority" label="Priority" hint="-100 to 100, higher first.">
                <Input
                  id="lead-priority"
                  type="number"
                  min={-100}
                  max={100}
                  step={1}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  required
                />
              </Field>
            </div>
            <Field id="lead-campaign" label="Campaign">
              <Select id="lead-campaign" value={campaignId} onChange={(e) => onCampaignChange(e.target.value)}>
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
            {fields.length > 0 && (
              <fieldset className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-semibold">Form: {form?.name}</legend>
                {fields.map((f) => (
                  <FieldInput
                    key={f.field_key}
                    f={f}
                    idPrefix="lead-ff"
                    optional
                    value={customValue(f.field_key)}
                    onChange={(v) => setCustomEdits((prev) => ({ ...prev, [f.field_key]: v }))}
                  />
                ))}
              </fieldset>
            )}
            {otherSaved.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Also saved (not on {form ? 'this' : "the campaign's"} form, kept as is):{' '}
                {otherSaved.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}
              </p>
            )}
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
  const campaigns = useCampaigns();
  const lists = useLists();
  const remove = useDeleteLead();
  const [editing, setEditing] = useState<Lead | null>(null);
  const [deleting, setDeleting] = useState<Lead | null>(null);
  const [form, setForm] = useState<LeadFilters>(NO_LEAD_FILTERS);

  // Only the search box is debounced; the selects apply at once.
  const q = useDebouncedValue(form.q.trim(), 300);
  const filters: LeadFilters = { ...form, q };
  const filtered = Object.values(form).some((v) => v.trim() !== '');
  // The page belongs to one set of filters: any filter change means page 1.
  const filtersKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ key: filtersKey, page: 1 });
  const page = paging.key === filtersKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filtersKey, page: p });

  const leads = useLeads(filters, page);
  const rows = leads.data?.rows ?? [];

  // Lists offered are those of the chosen campaign (a list belongs to one campaign).
  const listOptions = (lists.data ?? []).filter((l) => !form.campaignId || form.campaignId === String(l.campaign_id));
  // Statuses come from the server (within the chosen campaign); keep the
  // current choice visible even if the new campaign has none of it.
  const statuses = leads.data?.statuses ?? [];
  const statusOptions = form.status && !statuses.includes(form.status) ? [form.status, ...statuses] : statuses;

  return (
    <>
      <SectionHeader
        title="All leads"
        description="Every lead across all campaigns, newest first. Add leads by importing a file into a list."
      />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search name or phone"
            placeholder="Search name or phone"
            className="pl-9"
            value={form.q}
            onChange={(e) => setForm((f) => ({ ...f, q: e.target.value }))}
          />
        </div>
        <Select
          aria-label="Filter by campaign"
          value={form.campaignId}
          // A list from another campaign would match nothing, so the list choice resets.
          onChange={(e) => setForm((f) => ({ ...f, campaignId: e.target.value, listId: '' }))}
        >
          <option value="">All campaigns</option>
          <option value="none">Unassigned</option>
          {campaigns.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by list"
          value={form.listId}
          onChange={(e) => setForm((f) => ({ ...f, listId: e.target.value }))}
        >
          <option value="">All lists</option>
          {listOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          value={form.status}
          onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">All statuses</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      {leads.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : leads.error ? (
        <ErrorState message={leads.error.message} onRetry={() => leads.refetch()} />
      ) : leads.data.total === 0 && !filtered ? (
        <EmptyState icon={BookUser} title="No leads yet">
          Create a list, then import an .xlsx or .csv file into it.
        </EmptyState>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {leads.data.total.toLocaleString('en-IN')} {leads.data.total === 1 ? 'lead' : 'leads'}
            {filtered && ' match these filters'}
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
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((l) => (
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
          <Pager page={page} pageSize={leads.data.pageSize} total={leads.data.total} onPage={setPage} />
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
              // Deleting the last row of the last page: step back so the table isn't empty.
              if (rows.length === 1 && page > 1) setPage(page - 1);
            },
          })
        }
      />
    </>
  );
}
