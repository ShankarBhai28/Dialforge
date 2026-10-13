// Reports: pick a report on the left, set the filters it uses, read the
// table (sortable, totals last), export the same thing as CSV. Every report
// has the same shape (columns + rows + totals), so one table shows them all.
// The chosen report is in the URL (?r=agents) so a link opens it.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, BarChart3, Download, Info, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Field, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { cn } from '@/lib/utils';
import { useAccess } from '@/features/auth/access';
import {
  reportUrl,
  useReport,
  useReportCatalog,
  type Cell,
  type ReportCatalog,
  type ReportColumn,
  type ReportInfo,
  type ReportResult,
} from './api';
import {
  GROUP_LABELS,
  PRESETS,
  filterKeys,
  formatCell,
  groupOptions,
  presetRange,
  reportParams,
  type Filters,
} from './reportHelpers';

function FilterBar({
  report,
  catalog,
  filters,
  set,
}: {
  report: ReportInfo;
  catalog: ReportCatalog;
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
}) {
  const keys = filterKeys(report);
  const groups = groupOptions(report);
  const rangeBad = !report.noRange && (!filters.from || !filters.to || filters.from > filters.to);
  return (
    <div className="mb-4 space-y-3">
      {!report.noRange && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={filters.preset === p.key ? 'default' : 'outline'}
              aria-pressed={filters.preset === p.key}
              onClick={() => set(p.key === 'custom' ? { preset: 'custom' } : { preset: p.key, ...presetRange(p.key) })}
            >
              {p.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {!report.noRange && (
          <>
            <Field id="rep-from" label="From" className="w-full sm:w-40">
              <Input
                id="rep-from"
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(e) => set({ from: e.target.value, preset: 'custom' })}
                required
              />
            </Field>
            <Field id="rep-to" label="To" className="w-full sm:w-40">
              <Input
                id="rep-to"
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(e) => set({ to: e.target.value, preset: 'custom' })}
                required
              />
            </Field>
          </>
        )}
        {keys.includes('campaign') && (
          <Field id="rep-campaign" label="Campaign" className="w-full sm:w-48">
            <Select id="rep-campaign" value={filters.campaignId} onChange={(e) => set({ campaignId: e.target.value })}>
              <option value="">All campaigns</option>
              {catalog.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {keys.includes('agent') && (
          <Field id="rep-agent" label="Agent" className="w-full sm:w-44">
            <Select id="rep-agent" value={filters.agentId} onChange={(e) => set({ agentId: e.target.value })}>
              <option value="">All agents</option>
              {catalog.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {keys.includes('direction') && (
          <Field id="rep-direction" label="Direction" className="w-full sm:w-36">
            <Select id="rep-direction" value={filters.direction} onChange={(e) => set({ direction: e.target.value })}>
              <option value="">Both</option>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </Select>
          </Field>
        )}
        {keys.includes('answered') && (
          <Field id="rep-answered" label="Answered" className="w-full sm:w-36">
            <Select id="rep-answered" value={filters.answered} onChange={(e) => set({ answered: e.target.value })}>
              <option value="">All calls</option>
              <option value="yes">Answered</option>
              <option value="no">Not answered</option>
            </Select>
          </Field>
        )}
        {keys.includes('outcome') && (
          <Field id="rep-outcome" label="Outcome" className="w-full sm:w-44">
            <Select id="rep-outcome" value={filters.outcome} onChange={(e) => set({ outcome: e.target.value })}>
              <option value="">Any outcome</option>
              {catalog.outcomes.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {keys.includes('number') && (
          <Field id="rep-number" label="Number" className="w-full sm:w-40">
            <Input
              id="rep-number"
              inputMode="tel"
              placeholder="any part"
              value={filters.number}
              onChange={(e) => set({ number: e.target.value })}
            />
          </Field>
        )}
        {groups && (
          <Field id="rep-group" label="Group by" className="w-full sm:w-36">
            <Select
              id="rep-group"
              value={groups.includes(filters.groupBy) ? filters.groupBy : groups[0]}
              onChange={(e) => set({ groupBy: e.target.value })}
            >
              {groups.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABELS[g] ?? g}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {keys.includes('sla') && (
          <Field id="rep-sla" label="Service level (s)" className="w-full sm:w-36">
            <Input
              id="rep-sla"
              type="number"
              inputMode="numeric"
              min={1}
              max={600}
              value={filters.slaSeconds}
              onChange={(e) => set({ slaSeconds: e.target.value })}
            />
          </Field>
        )}
      </div>
      {rangeBad && (
        <p className="text-sm text-destructive">
          {filters.from && filters.to ? '"From" must be on or before "To".' : 'Pick both dates.'}
        </p>
      )}
    </div>
  );
}

// --- the table ---
const isNumeric = (c: ReportColumn) => ['number', 'decimal', 'seconds', 'percent', 'id'].includes(c.type ?? '');
const warn = (c: ReportColumn, v: Cell) =>
  typeof v === 'number' &&
  ((c.warnAbove !== undefined && v > c.warnAbove) || (c.warnBelow !== undefined && v < c.warnBelow));

function ResultTable({ result }: { result: ReportResult }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const dir = sort.desc ? -1 : 1;
    return [...result.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1; // empty cells last either way
      if (y === null || y === undefined) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [result.rows, sort]);

  const onSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, desc: false } : s.desc ? null : { key, desc: true }));

  return (
    <Table aria-label={result.title}>
      <TableHeader>
        <TableRow>
          {result.columns.map((c) => (
            <TableHead
              key={c.key}
              className={isNumeric(c) ? 'text-right' : undefined}
              aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
            >
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground"
                onClick={() => onSort(c.key)}
              >
                {c.label}
                {sort?.key === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
              </button>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {result.columns.map((c) => (
              <TableCell
                key={c.key}
                className={cn(
                  'whitespace-nowrap',
                  isNumeric(c) && 'text-right tabular-nums',
                  warn(c, r[c.key]) && 'font-semibold text-destructive',
                )}
              >
                {formatCell(r[c.key], c.type)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {result.totals && (
          <TableRow className="bg-muted/60 font-semibold hover:bg-muted/60" data-testid="totals">
            {result.columns.map((c) => {
              const v = result.totals![c.key];
              return (
                <TableCell
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap',
                    isNumeric(c) && 'text-right tabular-nums',
                    warn(c, v ?? null) && 'text-destructive',
                  )}
                >
                  {v === undefined || v === null ? '' : formatCell(v, c.type)}
                </TableCell>
              );
            })}
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** Waits until typing stops before searching. */
function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const START_FILTERS = (): Filters => ({
  preset: 'today',
  ...presetRange('today'),
  campaignId: '',
  agentId: '',
  direction: '',
  answered: '',
  outcome: '',
  number: '',
  groupBy: '',
  slaSeconds: '20',
});

function ReportView({
  report,
  catalog,
  filters,
  set,
}: {
  report: ReportInfo;
  catalog: ReportCatalog;
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
}) {
  const canExport = useAccess().can('reports', 'export');
  const number = useDebounced(filters.number);
  const params = reportParams(report, filters, number);
  const valid = report.noRange || (!!filters.from && !!filters.to && filters.from <= filters.to);
  const q = useReport(report.key, params, valid);

  return (
    <section aria-labelledby="report-title" className="min-w-0">
      <SectionHeader
        title={<span id="report-title">{report.title}</span>}
        description={report.description}
        actions={
          <>
            <Button variant="outline" onClick={() => q.refetch()} disabled={!valid}>
              <RefreshCw /> Refresh
            </Button>
            {canExport &&
              (valid ? (
                <Button variant="outline" asChild>
                  {/* A plain link: the server sends the file. */}
                  <a href={reportUrl(report.key, params, true)} target="_blank" rel="noopener noreferrer">
                    <Download /> Export CSV
                  </a>
                </Button>
              ) : (
                <Button variant="outline" disabled>
                  <Download /> Export CSV
                </Button>
              ))}
          </>
        }
      />
      <FilterBar report={report} catalog={catalog} filters={filters} set={set} />
      {!valid ? null : q.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : q.data.rows.length === 0 ? (
        <EmptyState icon={BarChart3} title={report.noRange ? 'Nothing to show yet.' : 'Nothing in this range.'} />
      ) : (
        <div className={q.isPlaceholderData ? 'opacity-60' : undefined}>
          {q.data.meta && q.data.meta.total > q.data.meta.shown && (
            <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Info className="size-4" /> Showing the newest {q.data.meta.shown.toLocaleString('en-IN')} of{' '}
              {q.data.meta.total.toLocaleString('en-IN')} calls - Export CSV for all of them.
            </p>
          )}
          <ResultTable key={q.data.report} result={q.data} />
          {q.data.notes?.map((n) => (
            <p key={n} className="mt-2 text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReportsPage() {
  const catalog = useReportCatalog();
  const [search, setSearch] = useSearchParams();
  const reports = catalog.data?.reports ?? [];
  const current = reports.find((r) => r.key === search.get('r')) ?? reports[0];
  const choose = (key: string) => setSearch({ r: key }, { replace: true });
  // Shared by all reports: switching report keeps the dates and filters.
  const [filters, setFilters] = useState(START_FILTERS);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Reports"
          description={catalog.data ? `Dates and hours are ${catalog.data.timezone} time.` : undefined}
        />
        {catalog.isPending ? (
          <Skeleton className="h-40" />
        ) : catalog.error ? (
          <ErrorState message={catalog.error.message} onRetry={() => catalog.refetch()} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <Field id="rep-pick" label="Report" className="lg:hidden">
              <Select id="rep-pick" value={current?.key} onChange={(e) => choose(e.target.value)}>
                {reports.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title}
                  </option>
                ))}
              </Select>
            </Field>
            <nav aria-label="Reports" className="hidden lg:block">
              <ul className="space-y-0.5">
                {reports.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => choose(r.key)}
                      aria-current={r.key === current?.key ? 'page' : undefined}
                      className={cn(
                        'w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm hover:bg-muted',
                        r.key === current?.key && 'bg-muted font-semibold text-foreground',
                      )}
                    >
                      {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {current && <ReportView report={current} catalog={catalog.data} filters={filters} set={set} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
