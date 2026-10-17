// DID Numbers: which queue (line) an inbound number routes to.
// Reference screen for Stage 3 - list, create, edit in a dialog, delete with confirm.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Hash, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { ConfirmDialog, EmptyState, Field, FormError, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useQueues } from '@/features/queues/api';
import { useDeleteDid, useDids, useSaveDid, type Did } from './api';
import { useCan } from '@/features/auth/access';

function DidDialog({
  did,
  open,
  onOpenChange,
}: {
  did: Did | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queues = useQueues();
  const save = useSaveDid();
  const [number, setNumber] = useState(did?.number ?? '');
  const [queueId, setQueueId] = useState(did?.queue_id ? String(did.queue_id) : '');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      { id: did?.id, number: number.trim(), queueId: queueId ? Number(queueId) : null },
      {
        onSuccess: () => {
          toast.success(did ? 'Number updated' : 'Number added');
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{did ? `Edit ${did.number}` : 'Add DID number'}</DialogTitle>
            <DialogDescription>
              Inbound calls to this number wait in this queue. Agents of every campaign that has the queue take them.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="did-number" label="Number" hint="Exactly as the trunk sends it, e.g. 8065098690.">
              <Input
                id="did-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                disabled={!!did}
                required
                autoFocus={!did}
                inputMode="tel"
              />
            </Field>
            <Field id="did-queue" label="Queue">
              <Select id="did-queue" value={queueId} onChange={(e) => setQueueId(e.target.value)}>
                <option value="">— Not mapped —</option>
                {/* keep the saved queue selectable while the list loads */}
                {!queues.data && did?.queue_id && <option value={did.queue_id}>{did.queue_name}</option>}
                {queues.data?.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
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
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NumbersPage() {
  const can = useCan('numbers');
  const dids = useDids();
  const remove = useDeleteDid();
  // `editing`: null = closed, 'new' = add, Did = edit that one.
  const [editing, setEditing] = useState<Did | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Did | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="DID numbers"
          description="Which queue an inbound number routes to. Campaigns that have the queue take its calls."
          actions={
            can('create') && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> Add number
              </Button>
            )
          }
        />

        {dids.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : dids.error ? (
          <ErrorState message={dids.error.message} onRetry={() => dids.refetch()} />
        ) : dids.data.length === 0 ? (
          <EmptyState icon={Hash} title="No numbers yet">
            Add the DID numbers your trunk delivers, and pick the queue each one goes to.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>Campaigns</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dids.data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-semibold tabular-nums">{d.number}</TableCell>
                  <TableCell>
                    {d.queue_name ?? <StatusPill tone="amber">Not mapped - calls use the fallback campaign</StatusPill>}
                  </TableCell>
                  <TableCell>
                    {d.campaign_names ??
                      (d.queue_name ? <StatusPill tone="amber">No campaign takes this queue</StatusPill> : '—')}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {can('edit') && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(d)} aria-label={`Edit ${d.number}`}>
                        <Pencil /> Edit
                      </Button>
                    )}
                    {can('delete') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(d)}
                        aria-label={`Delete ${d.number}`}
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
      </CardContent>

      {editing && (
        <DidDialog
          // a fresh dialog (and form state) per number
          key={editing === 'new' ? 'new' : editing.id}
          did={editing === 'new' ? null : editing}
          open
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete ${deleting?.number}?`}
        description="Inbound calls to this number will no longer be routed to a queue."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Number deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
