// Call Log: the latest calls across every agent (GET /calls).
import { useQueryClient } from '@tanstack/react-query';
import { PhoneCall, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime, formatTime } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { formatSeconds } from '@/lib/utils';
import { CALL_LOG_LIMIT, callLogKeys, useCalls, type CallRow } from './api';

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
  const calls = useCalls();

  // New and finished calls show up without pressing Refresh.
  useRealtime('call.event', () => qc.invalidateQueries({ queryKey: callLogKeys.all }));

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Call log"
          description={`All calls across every agent - the latest ${CALL_LOG_LIMIT}, newest first.`}
          actions={
            <Button variant="outline" onClick={() => calls.refetch()} disabled={calls.isFetching}>
              <RefreshCw className={calls.isFetching ? 'animate-spin' : undefined} /> Refresh
            </Button>
          }
        />
        {calls.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : calls.error ? (
          <ErrorState message={calls.error.message} onRetry={() => calls.refetch()} />
        ) : calls.data.length === 0 ? (
          <EmptyState icon={PhoneCall} title="No calls yet">
            Calls appear here as soon as an agent or the dialer places one.
          </EmptyState>
        ) : (
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
              {calls.data.map((c) => {
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
        )}
      </CardContent>
    </Card>
  );
}
