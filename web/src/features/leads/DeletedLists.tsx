// Deleted lists, with Restore (undo a delete). Restoring brings back the
// list and the leads deleted with it - same leads, attempts, status and
// history; numbers that are an active lead again stay deleted (no
// duplicates); the list comes back inactive so the dialer doesn't start on
// it by itself.
import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/features/auth/access';
import { useDeletedLists, useRestoreList, type DeletedList } from './api';

export function DeletedLists() {
  const can = useCan('leads');
  const [open, setOpen] = useState(false);
  const deleted = useDeletedLists(open);
  const restore = useRestoreList();
  const [confirm, setConfirm] = useState<DeletedList | null>(null);
  const comeBack = confirm ? confirm.leads - confirm.clashes : 0;

  return (
    <section className="mt-8" aria-label="Deleted lists">
      <Button variant="ghost" className="-ml-3" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown /> : <ChevronRight />} Deleted lists
      </Button>
      {open && (
        <div className="mt-2">
          <p className="mb-3 text-sm text-muted-foreground">
            Restore brings a list back with the leads deleted together with it (same leads, attempts and history).
            Numbers that are an active lead again stay deleted. The list comes back inactive.
          </p>
          {deleted.isPending ? (
            <Skeleton className="h-16" />
          ) : deleted.error ? (
            <ErrorState message={deleted.error.message} onRetry={() => deleted.refetch()} />
          ) : deleted.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deleted lists.</p>
          ) : (
            <Table aria-label="Deleted lists table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Deleted</TableHead>
                  <TableHead>Leads with it</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deleted.data.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-semibold">{l.name}</TableCell>
                    <TableCell>
                      {l.campaign ?? '—'}
                      {l.campaignDeleted && <span className="text-muted-foreground"> (deleted)</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(l.deletedAt)}
                      {l.deletedBy && <span className="text-muted-foreground"> by {l.deletedBy}</span>}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {l.leads}
                      {l.clashes > 0 && (
                        <span className="text-muted-foreground"> ({l.clashes} active again elsewhere)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {can('delete') &&
                        (l.campaignDeleted ? (
                          <span className="text-xs text-muted-foreground">campaign deleted</span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              restore.reset();
                              setConfirm(l);
                            }}
                            aria-label={`Restore ${l.name}`}
                          >
                            <RotateCcw /> Restore
                          </Button>
                        ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={`Restore list "${confirm?.name}"?`}
        description={
          confirm
            ? `${comeBack} lead${comeBack === 1 ? '' : 's'} come${comeBack === 1 ? 's' : ''} back with their history.` +
              (confirm.clashes
                ? ` ${confirm.clashes} stay${confirm.clashes === 1 ? 's' : ''} deleted - the number is an active lead in the campaign again.`
                : '') +
              ' The list comes back inactive: switch it on when it should be dialed. Callbacks cancelled by the delete stay cancelled.'
            : ''
        }
        confirmLabel="Restore"
        pending={restore.isPending}
        error={restore.error?.message}
        onConfirm={() =>
          confirm &&
          restore.mutate(confirm.id, {
            onSuccess: (r) => {
              toast.success(`List "${confirm.name}" restored`, { description: r.notes.join(' · ') });
              setConfirm(null);
            },
          })
        }
      />
    </section>
  );
}
