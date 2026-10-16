// One list in numbers (Lists -> click a list): how far it got, how it
// performed, by status, and every upload into it.
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState } from '@/components/ErrorState';
import { StatusPill } from '@/components/common';
import { formatDateTime } from '@/lib/format';
import { formatSeconds } from '@/lib/utils';
import { useListStats, type LeadList } from './api';
import { statusLabel } from './statuses';

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

const CHECKS: Record<string, string> = {
  none: 'no duplicate check',
  file: 'within the file',
  list: 'within this list',
  campaign: 'within the campaign',
  all: 'everywhere',
};

export function ListDetails({ list, onOpenChange }: { list: LeadList; onOpenChange: (open: boolean) => void }) {
  const stats = useListStats(list.id);
  const s = stats.data;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{list.name}</DialogTitle>
          <DialogDescription>
            {list.campaign_name ?? 'No campaign'}
            {s?.list.source ? ` · Source: ${s.list.source}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid max-h-[75vh] gap-5 overflow-y-auto">
          {stats.isPending ? (
            <Skeleton className="h-60" />
          ) : stats.error ? (
            <ErrorState message={stats.error.message} onRetry={() => stats.refetch()} />
          ) : (
            s && (
              <>
                <section aria-label="Progress" className="grid gap-2">
                  <h3 className="text-sm font-bold">Progress</h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Tile label="Leads" value={s.leads.total.toLocaleString('en-IN')} />
                    <Tile
                      label="Called"
                      value={pct(s.leads.called, s.leads.total)}
                      hint={`${s.leads.called} called · ${s.leads.fresh} never`}
                    />
                    <Tile
                      label="Reached"
                      value={pct(s.leads.reached, s.leads.called)}
                      hint={`${s.leads.reached} talked to an agent`}
                    />
                    <Tile
                      label="Success"
                      value={pct(s.leads.success, s.leads.reached)}
                      hint={`${s.leads.success} of those reached`}
                    />
                    <Tile label="Dialable now" value={s.leads.dialable} />
                    <Tile label="Waiting (retry / callback)" value={s.leads.scheduled} />
                    <Tile label="Done" value={s.leads.done} hint={`final or ${s.list.maxAttempts} attempts used`} />
                    <Tile
                      label="Calls"
                      value={s.calls.total}
                      hint={`${s.calls.connected} connected · talk ${formatSeconds(s.calls.talkSeconds)}`}
                    />
                  </div>
                  {s.calls.lastCallAt && (
                    <p className="text-xs text-muted-foreground">Last call {formatDateTime(s.calls.lastCallAt)}</p>
                  )}
                </section>

                <section aria-label="By status" className="grid gap-2">
                  <h3 className="text-sm font-bold">By status</h3>
                  {s.byStatus.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No leads in this list.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {s.byStatus.map((x) => (
                        <StatusPill key={x.status} tone={x.success ? 'green' : 'grey'}>
                          {x.label ?? statusLabel(x.status)} · {x.count}
                        </StatusPill>
                      ))}
                    </div>
                  )}
                </section>

                <section aria-label="Uploads" className="grid gap-2">
                  <h3 className="text-sm font-bold">Uploads</h3>
                  {s.imports.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No uploads recorded for this list yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>When</TableHead>
                            <TableHead>By</TableHead>
                            <TableHead>File</TableHead>
                            <TableHead>Rows</TableHead>
                            <TableHead>Added</TableHead>
                            <TableHead>Updated</TableHead>
                            <TableHead>Skipped</TableHead>
                            <TableHead>Duplicate check</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {s.imports.map((i) => (
                            <TableRow key={i.id}>
                              <TableCell className="whitespace-nowrap">{formatDateTime(i.at)}</TableCell>
                              <TableCell>{i.by ?? '—'}</TableCell>
                              <TableCell className="max-w-48 truncate" title={i.fileName ?? undefined}>
                                {i.fileName ?? '—'}
                              </TableCell>
                              <TableCell className="tabular-nums">{i.total}</TableCell>
                              <TableCell className="tabular-nums">{i.imported}</TableCell>
                              <TableCell className="tabular-nums">{i.updated}</TableCell>
                              <TableCell className="tabular-nums">{i.skipped}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {CHECKS[i.duplicateCheck ?? ''] ?? i.duplicateCheck ?? '—'}
                                {i.onDuplicate === 'update' && ' · updated existing'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </section>
              </>
            )
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
