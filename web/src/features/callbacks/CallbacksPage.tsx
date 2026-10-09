// Callbacks: everything agents scheduled from the Callback disposition.
// Filters run in the browser - the API returns the whole (capped) list.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, Field, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCallbacks, useCancelCallback, type Callback } from './api';

type StatusFilter = '' | 'pending' | 'overdue' | 'done' | 'cancelled';

const LIMIT = 300; // the route's LIMIT

const isOverdue = (c: Callback, now: number) => c.status === 'pending' && new Date(c.callback_at).getTime() < now;

const STATUS_TONE: Record<string, 'green' | 'grey' | 'blue'> = {
  pending: 'blue',
  done: 'green',
  cancelled: 'grey',
};

export function CallbacksPage() {
  const callbacks = useCallbacks();
  const cancel = useCancelCallback();
  const [status, setStatus] = useState<StatusFilter>('');
  const [campaign, setCampaign] = useState('');
  const [search, setSearch] = useState('');
  const [cancelling, setCancelling] = useState<Callback | null>(null);
  // "Overdue" is judged against the time the list was fetched, so rows
  // don't flip state mid-render.
  const now = callbacks.dataUpdatedAt;

  const campaigns = useMemo(
    () => [...new Set((callbacks.data ?? []).map((c) => c.campaign_name).filter((n): n is string => !!n))].sort(),
    [callbacks.data],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (callbacks.data ?? []).filter((c) => {
      if (status === 'overdue' ? !isOverdue(c, now) : status && c.status !== status) return false;
      if (campaign && c.campaign_name !== campaign) return false;
      if (q && !`${c.name ?? ''} ${c.phone}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [callbacks.data, status, campaign, search, now]);

  const filtered = status !== '' || campaign !== '' || search.trim() !== '';

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Callbacks"
          description="Callbacks scheduled by agents from the Callback disposition."
          actions={
            <Button variant="outline" onClick={() => callbacks.refetch()}>
              <RefreshCw /> Refresh
            </Button>
          }
        />

        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
          <Field id="cb-status" label="Status">
            <Select id="cb-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field id="cb-campaign" label="Campaign">
            <Select id="cb-campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">All campaigns</option>
              {campaigns.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="cb-search" label="Lead">
            <Input
              id="cb-search"
              type="search"
              placeholder="Name or number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setStatus('');
                setCampaign('');
                setSearch('');
              }}
            >
              <X /> Clear filters
            </Button>
          )}
        </div>

        {callbacks.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : callbacks.error ? (
          <ErrorState message={callbacks.error.message} onRetry={() => callbacks.refetch()} />
        ) : callbacks.data.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No callbacks yet">
            They appear here when an agent saves a call with the Callback disposition.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No callbacks match these filters" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const overdue = isOverdue(c, now);
                return (
                  <TableRow key={c.id}>
                    <TableCell className={cn('whitespace-nowrap', overdue && 'font-bold text-destructive')}>
                      {formatDateTime(c.callback_at)}
                      {overdue && ' (overdue)'}
                    </TableCell>
                    <TableCell>
                      {c.name && <div className="font-semibold">{c.name}</div>}
                      <div className="tabular-nums">{c.phone}</div>
                    </TableCell>
                    <TableCell>{c.campaign_name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{c.assigned_to ?? 'Anyone'}</TableCell>
                    <TableCell className="max-w-64">
                      {c.note ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={overdue ? 'red' : (STATUS_TONE[c.status] ?? 'grey')}>{c.status}</StatusPill>
                    </TableCell>
                    <TableCell>{c.created_by_name}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {c.status === 'pending' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setCancelling(c)}
                          aria-label={`Cancel callback for ${c.phone}`}
                        >
                          <X /> Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {callbacks.data?.length === LIMIT && (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing the first {LIMIT} callbacks (pending first, soonest first).
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(v) => {
          if (!v) {
            setCancelling(null);
            cancel.reset();
          }
        }}
        title="Cancel this callback?"
        description={
          cancelling &&
          `${cancelling.name ? `${cancelling.name}, ` : ''}${cancelling.phone} - due ${formatDateTime(cancelling.callback_at)}.`
        }
        confirmLabel="Cancel callback"
        destructive
        pending={cancel.isPending}
        error={cancel.error?.message}
        onConfirm={() =>
          cancelling &&
          cancel.mutate(cancelling.id, {
            onSuccess: () => {
              toast.success('Callback cancelled');
              setCancelling(null);
            },
          })
        }
      />
    </Card>
  );
}
