// Call Log: every call across every agent (GET /admin/calls), filtered and
// paged on the server.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PhoneCall, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Pager, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime, formatTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { formatSeconds } from '@/lib/utils';
import { callLogKeys, NO_CALL_FILTERS, useCalls, type CallFilters, type CallRow } from './api';

const NONE = <span className="text-muted-foreground">—</span>;

function Disposition({ call }: { call: CallRow }) {
  // Same reading as the classic page: only 'ended' is a completed call, and no
  // disposition means it wasn't answered (or hasn't ended yet).
  if (call.disposition === 'ended') return <StatusPill tone="green">ended</StatusPill>;
  if (call.disposition === 'abandoned') return <StatusPill tone="red">abandoned</StatusPill>;
  return <StatusPill tone="grey">{call.disposition || 'no answer'}</StatusPill>;
}

function talkTime(c: CallRow) {
  if (!c.answer_time || !c.end_time) return null;
  return (new Date(c.end_time).getTime() - new Date(c.answer_time).getTime()) / 1000;
}

export function CallLogPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<CallFilters>(NO_CALL_FILTERS);
  // Only the number box is debounced; the selects and dates apply at once.
  const q = useDebouncedValue(form.q.replace(/\D/g, ''), 300);
  const filters: CallFilters = { ...form, q };
  const filtered = Object.values(filters).some((v) => v !== '');

  // The page belongs to one set of filters: any filter change means page 1.
  const filtersKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ key: filtersKey, page: 1 });
  const page = paging.key === filtersKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filtersKey, page: p });

  const calls = useCalls(filters, page);
  const set = (k: keyof CallFilters) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // New and finished calls show up without pressing Refresh.
  useRealtime('call.event', () => qc.invalidateQueries({ queryKey: callLogKeys.all }));

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Call log"
          description="All calls across every agent, newest first."
          actions={
            <Button variant="outline" onClick={() => calls.refetch()} disabled={calls.isFetching}>
              <RefreshCw className={calls.isFetching ? 'animate-spin' : undefined} /> Refresh
            </Button>
          }
        />
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              inputMode="tel"
              aria-label="Search number"
              placeholder="Search number"
              className="pl-9"
              value={form.q}
              onChange={set('q')}
            />
          </div>
          <Select aria-label="Filter by direction" value={form.direction} onChange={set('direction')}>
            <option value="">All directions</option>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
          </Select>
          <Select aria-label="Filter by disposition" value={form.disposition} onChange={set('disposition')}>
            <option value="">All dispositions</option>
            <option value="ended">Ended</option>
            <option value="abandoned">Abandoned</option>
            {/* no disposition on the row = never answered (or still live) */}
            <option value="none">Not answered</option>
          </Select>
          <Input
            type="date"
            aria-label="From date"
            value={form.from}
            max={form.to || undefined}
            onChange={set('from')}
          />
          <Input type="date" aria-label="To date" value={form.to} min={form.from || undefined} onChange={set('to')} />
        </div>
        {calls.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : calls.error ? (
          <ErrorState message={calls.error.message} onRetry={() => calls.refetch()} />
        ) : calls.data.rows.length === 0 ? (
          filtered ? (
            <EmptyState icon={PhoneCall} title="No calls match these filters" />
          ) : (
            <EmptyState icon={PhoneCall} title="No calls yet">
              Calls appear here as soon as an agent or the dialer places one.
            </EmptyState>
          )
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Answer</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead>Talk time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.data.rows.map((c) => {
                  const talk = talkTime(c);
                  return (
                    <TableRow key={c.id}>
                      {/* Dialer calls have no agent extension until one picks up. */}
                      <TableCell className="font-semibold tabular-nums">{c.from_extension ?? NONE}</TableCell>
                      <TableCell className="tabular-nums">{c.to_number}</TableCell>
                      <TableCell className="capitalize">{c.direction}</TableCell>
                      <TableCell>
                        <Disposition call={c} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(c.start_time)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {c.answer_time ? formatTime(c.answer_time) : NONE}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{c.end_time ? formatTime(c.end_time) : NONE}</TableCell>
                      <TableCell className="tabular-nums">{talk === null ? NONE : formatSeconds(talk)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pager page={page} pageSize={calls.data.pageSize} total={calls.data.total} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
