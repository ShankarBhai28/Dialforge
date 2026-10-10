// Reports: campaign, agent, call and hourly performance, each with its own
// date range and a CSV export of exactly what the table shows.
import { useState, type ReactNode } from 'react';
import { BarChart3, Download, RefreshCw } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, Field, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useCampaigns } from '@/features/campaigns/api';
import { formatDateTime, toDateInput } from '@/lib/format';
import { formatSeconds } from '@/lib/utils';
import { reportUrl, useReport, type ReportKind } from './api';
import { useAccess } from '@/features/auth/access';

type Range = { from: string; to: string };
type CallFilters = Range & { campaignId: string; disposition: string };

const CALL_LIMIT = 500; // the route's LIMIT
const dash = <span className="text-muted-foreground">—</span>;

/** Filter row: the inputs, then Refresh + Export CSV on the right. */
function Toolbar({
  children,
  kind,
  params,
  valid,
  onRefresh,
}: {
  children: ReactNode;
  kind: ReportKind;
  params: Record<string, string>;
  valid: boolean;
  onRefresh: () => void;
}) {
  const canExport = useAccess().can('reports', 'export');
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      {children}
      <div className="flex gap-2 sm:ml-auto">
        <Button variant="outline" onClick={onRefresh} disabled={!valid}>
          <RefreshCw /> Refresh
        </Button>
        {!canExport ? null : valid ? (
          <Button variant="outline" asChild>
            {/* A plain link, like the classic window.open: the server sends the file. */}
            <a href={reportUrl(kind, params, true)} target="_blank" rel="noopener noreferrer">
              <Download /> Export CSV
            </a>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            <Download /> Export CSV
          </Button>
        )}
      </div>
    </div>
  );
}

function RangeInputs({ id, value, onChange }: { id: string; value: Range; onChange: (v: Range) => void }) {
  return (
    <>
      <Field id={`${id}-from`} label="From" className="w-full sm:w-40">
        <Input
          id={`${id}-from`}
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          required
        />
      </Field>
      <Field id={`${id}-to`} label="To" className="w-full sm:w-40">
        <Input
          id={`${id}-to`}
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          required
        />
      </Field>
    </>
  );
}

const rangeOk = (r: Range) => !!r.from && !!r.to && r.from <= r.to;

function RangeHint({ range }: { range: Range }) {
  if (rangeOk(range)) return null;
  return (
    <p className="mb-4 text-sm text-destructive">
      {range.from && range.to ? '"From" must be on or before "To".' : 'Pick both dates.'}
    </p>
  );
}

/** Loading / error / empty around a report table. */
function ReportBody<T>({
  query,
  valid,
  empty,
  children,
}: {
  query: UseQueryResult<T[]>;
  valid: boolean;
  empty: string;
  children: (rows: T[]) => ReactNode;
}) {
  if (!valid) return null;
  if (query.isPending)
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  if (query.error) return <ErrorState message={query.error.message} onRetry={() => query.refetch()} />;
  if (query.data.length === 0) return <EmptyState icon={BarChart3} title={empty} />;
  return <div className={query.isPlaceholderData ? 'opacity-60' : undefined}>{children(query.data)}</div>;
}

function CampaignReport({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  const valid = rangeOk(range);
  const q = useReport('campaigns', range, valid);
  return (
    <>
      <Toolbar kind="campaigns" params={range} valid={valid} onRefresh={() => q.refetch()}>
        <RangeInputs id="campaign" value={range} onChange={setRange} />
      </Toolbar>
      <RangeHint range={range} />
      <ReportBody query={q} valid={valid} empty="No campaigns yet.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Answered</TableHead>
                <TableHead className="text-right">Not answered</TableHead>
                <TableHead className="text-right">Abandoned</TableHead>
                <TableHead className="text-right">Answer rate</TableHead>
                <TableHead className="text-right">Avg talk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {rows.map((r) => (
                <TableRow key={r.campaign_id}>
                  <TableCell className="font-semibold">{r.campaign_name}</TableCell>
                  <TableCell className="text-right">{r.total_leads}</TableCell>
                  <TableCell className="text-right">{r.total_calls}</TableCell>
                  <TableCell className="text-right">{r.answered}</TableCell>
                  <TableCell className="text-right">{r.not_answered}</TableCell>
                  <TableCell className="text-right">{r.abandoned}</TableCell>
                  <TableCell className="text-right">{r.answer_rate}%</TableCell>
                  <TableCell className="text-right">{formatSeconds(r.avg_talk_seconds)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ReportBody>
    </>
  );
}

function AgentReport({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  const valid = rangeOk(range);
  const q = useReport('agents', range, valid);
  return (
    <>
      <Toolbar kind="agents" params={range} valid={valid} onRefresh={() => q.refetch()}>
        <RangeInputs id="agent" value={range} onChange={setRange} />
      </Toolbar>
      <RangeHint range={range} />
      <ReportBody query={q} valid={valid} empty="No agents yet.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Login time</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Answered</TableHead>
                <TableHead className="text-right">Talk time</TableHead>
                <TableHead className="text-right">Avg talk</TableHead>
                <TableHead className="text-right">Callbacks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {rows.map((r) => (
                <TableRow key={r.user_id}>
                  <TableCell className="font-semibold">{r.username}</TableCell>
                  <TableCell className="text-right">{formatSeconds(r.login_seconds)}</TableCell>
                  <TableCell className="text-right">{r.total_calls}</TableCell>
                  <TableCell className="text-right">{r.answered_calls}</TableCell>
                  <TableCell className="text-right">{formatSeconds(r.talk_seconds)}</TableCell>
                  <TableCell className="text-right">{formatSeconds(r.avg_talk_seconds)}</TableCell>
                  <TableCell className="text-right">{r.callbacks_set}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ReportBody>
    </>
  );
}

function CallReport({ filters, setFilters }: { filters: CallFilters; setFilters: (f: CallFilters) => void }) {
  const campaigns = useCampaigns();
  const valid = rangeOk(filters);
  const q = useReport('calls', filters, valid);
  return (
    <>
      <Toolbar kind="calls" params={filters} valid={valid} onRefresh={() => q.refetch()}>
        <RangeInputs id="call" value={filters} onChange={(r) => setFilters({ ...filters, ...r })} />
        <Field id="call-campaign" label="Campaign" className="w-full sm:w-48">
          <Select
            id="call-campaign"
            value={filters.campaignId}
            onChange={(e) => setFilters({ ...filters, campaignId: e.target.value })}
          >
            <option value="">All campaigns</option>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="call-disposition" label="Disposition" className="w-full sm:w-40">
          <Select
            id="call-disposition"
            value={filters.disposition}
            onChange={(e) => setFilters({ ...filters, disposition: e.target.value })}
          >
            <option value="">All dispositions</option>
            <option value="ended">Ended</option>
            <option value="abandoned">Abandoned</option>
          </Select>
        </Field>
      </Toolbar>
      <RangeHint range={filters} />
      <ReportBody query={q} valid={valid} empty="No calls match these filters.">
        {(rows) => (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Direction</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Answer</TableHead>
                  <TableHead>End</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.direction}</TableCell>
                    <TableCell className="tabular-nums">{c.from_extension ?? dash}</TableCell>
                    <TableCell className="tabular-nums">{c.to_number}</TableCell>
                    <TableCell>{c.campaign_name ?? dash}</TableCell>
                    <TableCell>{c.disposition ?? dash}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(c.start_time)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(c.answer_time)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(c.end_time)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length >= CALL_LIMIT && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the latest {CALL_LIMIT} calls - narrow the filters to see others.
              </p>
            )}
          </>
        )}
      </ReportBody>
    </>
  );
}

function HourlyReport({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const valid = !!date;
  const q = useReport('hourly', { date }, valid);
  return (
    <>
      <Toolbar kind="hourly" params={{ date }} valid={valid} onRefresh={() => q.refetch()}>
        <Field id="hourly-date" label="Date" className="w-full sm:w-40">
          <Input id="hourly-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </Toolbar>
      <ReportBody query={q} valid={valid} empty="No data for this day.">
        {(rows) => {
          // Bars are scaled to the busiest hour, like the classic chart.
          const max = Math.max(1, ...rows.map((r) => r.total_calls));
          const total = rows.reduce((s, r) => s + r.total_calls, 0);
          const answered = rows.reduce((s, r) => s + r.answered, 0);
          return (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <span>
                  <b>{total}</b> calls
                </span>
                <span>
                  <b>{answered}</b> answered ({total ? Math.round((answered / total) * 100) : 0}%)
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="inline-block size-2.5 rounded-sm bg-primary" /> Answered
                  <span className="ml-2 inline-block size-2.5 rounded-sm bg-status-break" /> Not answered
                </span>
              </div>
              <ul className="grid gap-1" aria-label="Calls by hour">
                {rows.map((r) => (
                  <li
                    key={r.hour}
                    className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[3.5rem_1fr_9rem]"
                  >
                    <span className="text-muted-foreground tabular-nums">{String(r.hour).padStart(2, '0')}:00</span>
                    <span className="flex h-3 overflow-hidden rounded-sm bg-muted">
                      <span className="bg-primary" style={{ width: `${(r.answered / max) * 100}%` }} />
                      <span
                        className="bg-status-break"
                        style={{ width: `${((r.total_calls - r.answered) / max) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">
                      {r.total_calls} calls · {r.answer_rate}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}

export function ReportsPage() {
  // Filters live here, so switching tabs keeps each tab's choices.
  const [tab, setTab] = useState('campaign');
  const [today] = useState(() => toDateInput());
  const [campaignRange, setCampaignRange] = useState<Range>({ from: today, to: today });
  const [agentRange, setAgentRange] = useState<Range>({ from: today, to: today });
  const [callFilters, setCallFilters] = useState<CallFilters>({
    from: today,
    to: today,
    campaignId: '',
    disposition: '',
  });
  const [hourlyDate, setHourlyDate] = useState(today);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader title="Reports" description="Campaign, agent, call, and hourly performance." />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="campaign">Campaign</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="call">Call</TabsTrigger>
            <TabsTrigger value="hourly">Hourly</TabsTrigger>
          </TabsList>
          <TabsContent value="campaign">
            <CampaignReport range={campaignRange} setRange={setCampaignRange} />
          </TabsContent>
          <TabsContent value="agent">
            <AgentReport range={agentRange} setRange={setAgentRange} />
          </TabsContent>
          <TabsContent value="call">
            <CallReport filters={callFilters} setFilters={setCallFilters} />
          </TabsContent>
          <TabsContent value="hourly">
            <HourlyReport date={hourlyDate} setDate={setHourlyDate} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
