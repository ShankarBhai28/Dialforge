// Lists: named batches of leads within a campaign. Create/edit in a dialog,
// delete (blocked by the server while leads remain), recycle, import.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ListPlus, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
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
import { ConfirmDialog, EmptyState, Field, FormError, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useCampaigns } from '@/features/campaigns/api';
import { useDeleteList, useLists, useSaveList, type LeadList } from './api';
import { RecycleDialog } from './RecycleDialog';
import { useCanManage } from '@/features/auth/access';

function ListDialog({ list, onOpenChange }: { list: LeadList | null; onOpenChange: (open: boolean) => void }) {
  const campaigns = useCampaigns();
  const save = useSaveList();
  const [name, setName] = useState(list?.name ?? '');
  const [campaignId, setCampaignId] = useState(list ? String(list.campaign_id) : '');
  const [priority, setPriority] = useState(list ? String(list.priority) : '');
  const [isActive, setIsActive] = useState(list ? !!list.is_active : true);
  const [localError, setLocalError] = useState<string | null>(null);

  // A new list defaults to the first campaign, like the classic dropdown.
  const effectiveCampaign = campaignId || (campaigns.data?.[0] ? String(campaigns.data[0].id) : '');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.reset();
    if (!name.trim()) return setLocalError('List name is required');
    if (!effectiveCampaign) return setLocalError('Create a campaign first');
    const p = priority.trim() === '' ? 0 : Number(priority);
    if (!Number.isInteger(p) || p < -100 || p > 100) return setLocalError('priority must be a whole number -100..100');
    setLocalError(null);
    save.mutate(
      { id: list?.id, name: name.trim(), campaignId: Number(effectiveCampaign), priority: p, isActive },
      {
        onSuccess: () => {
          toast.success(list ? 'List saved' : `Created list: ${name.trim()}`);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>{list ? `Edit ${list.name}` : 'Create list'}</DialogTitle>
            <DialogDescription>
              A list is a named batch of leads within a campaign (e.g. "October cold list") - an import always lands in
              one of these, not loose into the campaign.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="list-name" label="List name">
              <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field id="list-campaign" label="Campaign">
              <Select id="list-campaign" value={effectiveCampaign} onChange={(e) => setCampaignId(e.target.value)}>
                {!campaigns.data?.length && <option value="">No campaigns yet</option>}
                {campaigns.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="list-priority" label="Priority" hint="-100 to 100. Higher priority lists are dialed first.">
              <Input
                id="list-priority"
                type="number"
                min={-100}
                max={100}
                placeholder="0"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </Field>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active for dialer
            </label>
            <FormError message={localError ?? save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {list ? 'Save changes' : 'Create list'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ListsTab({ onImport }: { onImport: (listId: number) => void }) {
  const manages = useCanManage('leads');
  const lists = useLists();
  const remove = useDeleteList();
  const [editing, setEditing] = useState<LeadList | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LeadList | null>(null);
  const [recycling, setRecycling] = useState<LeadList | null>(null);

  return (
    <>
      <SectionHeader
        title="Lists"
        description="Inactive lists are skipped by the dialer; higher priority lists are dialed first."
        actions={
          manages && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Create list
            </Button>
          )
        }
      />
      {lists.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : lists.error ? (
        <ErrorState message={lists.error.message} onRetry={() => lists.refetch()} />
      ) : lists.data.length === 0 ? (
        <EmptyState icon={ListPlus} title="No lists yet">
          Create a list, then import leads into it.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead title="Can be dialed now: not final, attempts left, retry time reached">
                Dialable now
              </TableHead>
              <TableHead>Dialer</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lists.data.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-semibold">{l.name}</TableCell>
                <TableCell>{l.campaign_name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="tabular-nums">{l.lead_count}</TableCell>
                <TableCell className="tabular-nums">{l.dialable_count}</TableCell>
                <TableCell>
                  {l.is_active ? (
                    <StatusPill tone="green">Active</StatusPill>
                  ) : (
                    <StatusPill tone="grey">Inactive</StatusPill>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{l.priority}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(l.created_at)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {manages && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                      <Pencil /> Edit
                    </Button>
                  )}
                  {manages && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onImport(l.id)}
                      aria-label={`Import into ${l.name}`}
                    >
                      <Upload /> Import
                    </Button>
                  )}
                  {manages && (
                    <Button variant="ghost" size="sm" onClick={() => setRecycling(l)} aria-label={`Recycle ${l.name}`}>
                      <RotateCcw /> Recycle
                    </Button>
                  )}
                  {manages && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(l)}
                      aria-label={`Delete ${l.name}`}
                    >
                      <Trash2 /> Delete
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing && (
        <ListDialog
          key={editing === 'new' ? 'new' : editing.id}
          list={editing === 'new' ? null : editing}
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
      {recycling && (
        <RecycleDialog key={recycling.id} list={recycling} onOpenChange={(v) => !v && setRecycling(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete list "${deleting?.name}"?`}
        description="Only an empty list can be deleted - reassign or remove its leads first."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('List deleted');
              setDeleting(null);
            },
          })
        }
      />
    </>
  );
}
