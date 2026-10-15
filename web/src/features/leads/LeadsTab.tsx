// All leads, searched, filtered and paged on the server (GET /admin/leads):
// open one (its own page), edit, delete, tick many for bulk actions, and
// export what the filters show.
import { useState } from 'react';
import { Link } from 'react-router';
import { BookUser, Download, Pencil, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, Pager, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { useCampaigns } from '@/features/campaigns/api';
import {
  NO_LEAD_FILTERS,
  leadsExportUrl,
  useDeleteLead,
  useLeadAgents,
  useLeads,
  useLists,
  type BulkTarget,
  type Lead,
  type LeadFilters,
} from './api';
import { statusLabel } from './statuses';
import { useCan } from '@/features/auth/access';
import { toastDeleted } from '@/lib/deleted';
import { LeadDialog } from './LeadDialog';
import { BulkBar } from './BulkBar';

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

export function LeadsTab() {
  const can = useCan('leads');
  const campaigns = useCampaigns();
  const lists = useLists();
  const agents = useLeadAgents();
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

  // Ticked leads belong to one set of filters too; "all" = every lead matching them.
  const [picked, setPicked] = useState<{ key: string; ids: number[]; all: boolean }>({ key: '', ids: [], all: false });
  const ticked = picked.key === filtersKey ? picked : { key: filtersKey, ids: [] as number[], all: false };
  const clearTicks = () => setPicked({ key: filtersKey, ids: [], all: false });
  const canBulk = can('edit') || can('delete') || can('recycle');

  const leads = useLeads(filters, page);
  const rows = leads.data?.rows ?? [];
  const total = leads.data?.total ?? 0;
  const pageIds = rows.map((l) => l.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => ticked.all || ticked.ids.includes(id));

  function toggle(id: number) {
    const ids = ticked.ids.includes(id) ? ticked.ids.filter((x) => x !== id) : [...ticked.ids, id];
    setPicked({ key: filtersKey, ids, all: false });
  }
  function togglePage() {
    if (allOnPage)
      setPicked({
        key: filtersKey,
        ids: ticked.all ? [] : ticked.ids.filter((id) => !pageIds.includes(id)),
        all: false,
      });
    else setPicked({ key: filtersKey, ids: [...new Set([...ticked.ids, ...pageIds])], all: false });
  }
  const target: BulkTarget = ticked.all ? { all: true, filters } : { ids: ticked.ids };
  const tickedCount = ticked.all ? total : ticked.ids.length;

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
        description="Every lead across all campaigns, newest first. Click a lead to open it; tick leads to change many at once."
        actions={
          can('export') &&
          total > 0 && (
            <Button variant="outline" asChild>
              {/* A plain link: the server sends the file, with the same filters as the table. */}
              <a href={leadsExportUrl(filters)} target="_blank" rel="noopener noreferrer">
                <Download /> Export {filtered ? 'these' : 'all'} ({total.toLocaleString('en-IN')})
              </a>
            </Button>
          )
        }
      />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
        <Select
          aria-label="Filter by agent"
          value={form.assignedTo}
          onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}
        >
          <option value="">Given to: anyone</option>
          <option value="none">Not given to an agent</option>
          {agents.data?.map((u) => (
            <option key={u.id} value={u.id}>
              Given to {u.username}
              {!u.active && ' (inactive)'}
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
          {canBulk && tickedCount > 0 && (
            <BulkBar target={target} count={tickedCount} campaignId={form.campaignId} onClear={clearTicks} />
          )}
          <p className="mb-2 text-xs text-muted-foreground">
            {total.toLocaleString('en-IN')} {total === 1 ? 'lead' : 'leads'}
            {filtered && ' match these filters'}
            {canBulk && allOnPage && !ticked.all && total > rows.length && (
              <>
                {' · '}All {rows.length} on this page ticked.{' '}
                <button
                  type="button"
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                  onClick={() => setPicked({ key: filtersKey, ids: [], all: true })}
                >
                  Tick all {total.toLocaleString('en-IN')} {filtered ? 'matching' : 'leads'}
                </button>
              </>
            )}
            {ticked.all && ` · all ${total.toLocaleString('en-IN')} ticked`}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                {canBulk && (
                  <TableHead className="w-8">
                    <Checkbox aria-label="Tick every lead on this page" checked={allOnPage} onChange={togglePage} />
                  </TableHead>
                )}
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>List</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Given to</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canBulk ? 10 : 9} className="py-6 text-center text-muted-foreground">
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((l) => (
                  <TableRow key={l.id} data-state={ticked.all || ticked.ids.includes(l.id) ? 'selected' : undefined}>
                    {canBulk && (
                      <TableCell>
                        <Checkbox
                          aria-label={`Tick ${l.phone}`}
                          checked={ticked.all || ticked.ids.includes(l.id)}
                          disabled={ticked.all}
                          onChange={() => toggle(l.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-semibold">
                      <Link to={`/admin/leads/${l.id}`} className="hover:text-primary hover:underline">
                        {l.name || 'No name'}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Link to={`/admin/leads/${l.id}`} className="hover:text-primary hover:underline">
                        {l.phone}
                      </Link>
                    </TableCell>
                    <TableCell>{l.campaign_name ?? muted('Unassigned')}</TableCell>
                    <TableCell>{l.list_name ?? muted('—')}</TableCell>
                    <TableCell>{statusLabel(l.status)}</TableCell>
                    <TableCell>{l.assigned_to ?? muted('—')}</TableCell>
                    <TableCell className="tabular-nums">{l.attempts}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(l.created_at)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {can('edit') && (
                        <Button variant="ghost" size="sm" onClick={() => setEditing(l)} aria-label={`Edit ${l.phone}`}>
                          <Pencil /> Edit
                        </Button>
                      )}
                      {can('delete') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setDeleting(l)}
                          aria-label={`Delete ${l.phone}`}
                        >
                          <Trash2 /> Delete
                        </Button>
                      )}
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
        description="It's no longer dialed or shown; a pending callback is cancelled. Its past calls and answers are kept."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: (r) => {
              toastDeleted('Lead', r);
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
