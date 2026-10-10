// DNC list: numbers that must never be called. Bulk add + search + remove.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PhoneOff, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, Field, FormError, Pager, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { useAddDnc, useDnc, useRemoveDnc, type DncAddResult, type DncNumber } from './api';
import { useCan } from '@/features/auth/access';

const n = (x: number) => x.toLocaleString('en-IN');

function AddNumbers() {
  const add = useAddDnc();
  const [phones, setPhones] = useState('');
  const [result, setResult] = useState<DncAddResult | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    add.mutate(phones, {
      onSuccess: (r) => {
        setResult(r);
        setPhones('');
        toast.success(`Added ${r.added} to DNC`);
      },
    });
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={onSubmit} className="grid gap-3">
          <SectionHeader title="Add numbers" className="mb-0" />
          <Field
            id="dnc-input"
            label="Numbers"
            hint="One per line or comma-separated. Stored normalised: +91 / 0 prefixes and spaces are removed, so every format of the same number matches."
          >
            <Textarea id="dnc-input" rows={4} value={phones} onChange={(e) => setPhones(e.target.value)} />
          </Field>
          <FormError message={add.error?.message} />
          {result && (
            <p role="status" className="text-sm font-semibold text-status-available">
              Added {result.added}, already listed {result.existing}, invalid {result.invalid}.
            </p>
          )}
          <div>
            <Button type="submit" disabled={add.isPending || !phones.trim()}>
              <Plus /> Add to DNC
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function DncPage() {
  const can = useCan('dnc');
  const [search, setSearch] = useState('');
  // Wait for a pause in typing before asking the server.
  const q = useDebouncedValue(search.trim(), 300);
  // The page belongs to one search: a new search starts at page 1.
  const [paging, setPaging] = useState({ q, page: 1 });
  const page = paging.q === q ? paging.page : 1;
  const setPage = (p: number) => setPaging({ q, page: p });

  const dnc = useDnc(q, page);
  const remove = useRemoveDnc();
  const [removing, setRemoving] = useState<DncNumber | null>(null);

  const rows = dnc.data?.rows ?? [];

  return (
    <div className="grid gap-4">
      {can('create') && <AddNumbers />}
      <Card>
        <CardContent className="pt-5">
          <SectionHeader
            title={dnc.data ? `${n(dnc.data.all)} numbers${q ? ` (${n(dnc.data.total)} matching)` : ''}` : 'Numbers'}
            description="Numbers that must never be called - click-to-call and the dialer refuse them."
            actions={
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search number"
                  placeholder="Search number"
                  className="pl-9"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            }
          />

          {dnc.isPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : dnc.error ? (
            <ErrorState message={dnc.error.message} onRetry={() => dnc.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState icon={PhoneOff} title={q ? 'No numbers match' : 'No numbers'}>
              {q ? 'Try fewer digits.' : 'Numbers added here, or marked Do Not Call by agents, show up in this list.'}
            </EmptyState>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Added by</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-semibold tabular-nums">{r.phone}</TableCell>
                      <TableCell>{r.source}</TableCell>
                      <TableCell>{r.created_by_name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {can('delete') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setRemoving(r)}
                            aria-label={`Remove ${r.phone}`}
                          >
                            <Trash2 /> Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pager page={page} pageSize={dnc.data.pageSize} total={dnc.data.total} onPage={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => {
          if (!v) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title={`Remove ${removing?.phone} from the DNC list?`}
        description="It can be called again (unless a lead with it is still marked Do Not Call)."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success('Number removed from DNC');
              setRemoving(null);
              // Removing the last row of the last page: step back so the table isn't empty.
              if (rows.length === 1 && page > 1) setPage(page - 1);
            },
          })
        }
      />
    </div>
  );
}
