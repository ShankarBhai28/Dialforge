// Audit Log: who changed what, when, and what it was before (GET /admin/audit).
// Every admin change, login / logout and automatic action is a row; a row
// opens to show the fields that changed and what was sent.
import { Fragment, useState } from 'react';
import { ChevronRight, History, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Pager, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { changedFields, NO_AUDIT_FILTERS, useAudit, type AuditFilters, type AuditRow } from './api';

const NONE = <span className="text-muted-foreground">—</span>;
const show = (v: unknown) =>
  v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function Result({ status }: { status: number | null }) {
  if (status === null) return NONE;
  if (status < 400) return <StatusPill tone="green">OK</StatusPill>;
  return (
    <StatusPill tone={status === 403 ? 'amber' : 'red'}>{status === 403 ? 'Refused' : `Failed ${status}`}</StatusPill>
  );
}

function Details({ row }: { row: AuditRow }) {
  const changes = changedFields(row.before_json, row.after_json);
  return (
    <div className="grid gap-3 text-sm">
      {changes.length > 0 && (
        <div>
          <p className="mb-1 font-semibold">Changes</p>
          <table className="text-xs">
            <tbody>
              {changes.map(([field, before, after]) => (
                <tr key={field}>
                  <td className="pr-3 font-medium text-muted-foreground">{field}</td>
                  <td className="pr-2 text-destructive line-through">{show(before)}</td>
                  <td className="text-status-available">{show(after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {row.request_json && (
        <div>
          <p className="mb-1 font-semibold">Sent</p>
          <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify(row.request_json, null, 2)}
          </pre>
        </div>
      )}
      {!changes.length && !row.request_json && <p className="text-muted-foreground">No details recorded.</p>}
      {row.ip && <p className="text-xs text-muted-foreground">From {row.ip}</p>}
    </div>
  );
}

export function AuditPage() {
  const [form, setForm] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const q = useDebouncedValue(form.q.trim(), 300);
  const filters: AuditFilters = { ...form, q };
  const filtered = Object.values(filters).some((v) => v !== '' && v !== false);
  const filtersKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ key: filtersKey, page: 1 });
  const page = paging.key === filtersKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filtersKey, page: p });
  const [open, setOpen] = useState<number | null>(null);

  const audit = useAudit(filters, page);
  const set = (k: Exclude<keyof AuditFilters, 'failed'>) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Audit log"
          description="Every change made on the admin side, every login and logout, and automatic actions - who, when, and what it was before."
          actions={
            <Button variant="outline" onClick={() => audit.refetch()} disabled={audit.isFetching}>
              <RefreshCw className={audit.isFetching ? 'animate-spin' : undefined} /> Refresh
            </Button>
          }
        />
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search user"
              placeholder="User"
              className="pl-9"
              value={form.q}
              onChange={set('q')}
            />
          </div>
          <Select aria-label="Filter by action" value={form.action} onChange={set('action')}>
            <option value="">All actions</option>
            {audit.data?.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by record" value={form.entity} onChange={set('entity')}>
            <option value="">All records</option>
            {audit.data?.entities.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            aria-label="From date"
            value={form.from}
            max={form.to || undefined}
            onChange={set('from')}
          />
          <Input type="date" aria-label="To date" value={form.to} min={form.from || undefined} onChange={set('to')} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.failed} onChange={(e) => setForm((f) => ({ ...f, failed: e.target.checked }))} />
            Refused / failed only
          </label>
        </div>
        {audit.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : audit.error ? (
          <ErrorState message={audit.error.message} onRetry={() => audit.refetch()} />
        ) : audit.data.rows.length === 0 ? (
          <EmptyState icon={History} title={filtered ? 'Nothing matches these filters' : 'Nothing recorded yet'} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>When</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.data.rows.map((r) => {
                  const isOpen = open === r.id;
                  return (
                    <Fragment key={r.id}>
                      <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : r.id)}>
                        <TableCell>
                          <button
                            type="button"
                            aria-label={`${isOpen ? 'Hide' : 'Show'} details of #${r.id}`}
                            aria-expanded={isOpen}
                            className="flex cursor-pointer"
                          >
                            <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                          </button>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(r.at)}</TableCell>
                        <TableCell className="font-semibold">{r.username ?? NONE}</TableCell>
                        <TableCell className="font-mono text-xs">{r.action}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.entity ? `${r.entity}${r.entity_id ? ` #${r.entity_id}` : ''}` : NONE}
                        </TableCell>
                        <TableCell>
                          <Result status={r.status} />
                        </TableCell>
                        <TableCell className="max-w-80 truncate text-sm" title={r.summary ?? undefined}>
                          {r.summary ?? NONE}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={6} className="bg-muted/20">
                            <Details row={r} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            <Pager page={page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
