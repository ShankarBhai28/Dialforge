import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { toDateInput } from '@/lib/format';
import { ReportsPage } from './ReportsPage';
import { formatCell, presetRange } from './reportHelpers';
import type { ReportCatalog, ReportResult } from './api';

const today = toDateInput();
const CATALOG: ReportCatalog = {
  timezone: 'Asia/Kolkata',
  reports: [
    {
      key: 'cdr',
      title: 'Call Detail (CDR)',
      description: 'Every call.',
      filters: ['campaign', 'agent', 'direction', 'answered', 'outcome', 'number'],
    },
    { key: 'agents', title: 'Agent Performance', description: 'Per agent.', filters: ['agent', 'campaign'] },
    {
      key: 'predictive',
      title: 'Predictive Dialer',
      description: 'Pacing.',
      filters: ['campaign', { key: 'groupBy', options: ['campaign', 'hour'] }],
    },
    { key: 'lists', title: 'List Penetration', description: 'Lists now.', filters: ['campaign'], noRange: true },
  ],
  campaigns: [{ id: 3, name: 'Sales' }],
  agents: [{ id: 7, username: 'agent04' }],
  outcomes: [{ code: 'interested', label: 'Interested' }],
};
const result = (over: Partial<ReportResult>): ReportResult => ({
  report: 'cdr',
  title: 'Call Detail (CDR)',
  from: today,
  to: today,
  timezone: 'Asia/Kolkata',
  columns: [],
  rows: [],
  totals: null,
  ...over,
});
const CDR = result({
  columns: [
    { key: 'id', label: 'Call', type: 'id' },
    { key: 'start', label: 'Start', type: 'datetime' },
    { key: 'agent', label: 'Agent' },
    { key: 'talk_seconds', label: 'Talk', type: 'seconds' },
    { key: 'outcome', label: 'Outcome' },
  ],
  rows: [
    { id: 71, start: '2026-10-13 15:37:25', agent: 'agent04', talk_seconds: 125, outcome: 'Interested' },
    { id: 70, start: '2026-10-13 15:30:00', agent: 'zed', talk_seconds: 30, outcome: null },
  ],
  totals: { id: '2 calls', talk_seconds: 155 },
  meta: { total: 1500, shown: 2, limit: 1000 },
});
const PREDICTIVE = result({
  report: 'predictive',
  title: 'Predictive Dialer',
  columns: [
    { key: 'name', label: 'Campaign' },
    { key: 'attempts', label: 'Dial attempts', type: 'number' },
    { key: 'drop_rate', label: 'Drop %', type: 'percent', warnAbove: 3 },
  ],
  rows: [{ name: 'Sales', attempts: 1200, drop_rate: 4.5 }],
  totals: { name: 'Total', attempts: 1200, drop_rate: 4.5 },
  notes: ['Keep it under 3 %.'],
});

describe('Reports', () => {
  it('opens the first report for today: formatted cells, totals, newest-N note, CSV link', async () => {
    fakeApi({
      'GET /admin/reports': { body: CATALOG },
      [`GET /admin/reports/cdr?from=${today}&to=${today}`]: { body: CDR },
    });
    renderPage(<ReportsPage />);
    const table = await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    const row = within(table).getByText('agent04').closest('tr')!;
    expect(within(row).getByText('2m 05s')).toBeInTheDocument();
    expect(within(row).getByText('2026-10-13 · 15:37:25')).toBeInTheDocument();
    expect(within(screen.getByTestId('totals')).getByText('2 calls')).toBeInTheDocument();
    expect(within(screen.getByTestId('totals')).getByText('2m 35s')).toBeInTheDocument();
    expect(screen.getByText(/showing the newest 2 of 1,500 calls/i)).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Kolkata time/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      `/admin/reports/cdr?from=${today}&to=${today}&format=csv`,
    );
  });

  it('filters go into the query; switching report keeps the dates; drop rate over 3 % is red', async () => {
    const calls = fakeApi({
      'GET /admin/reports': { body: CATALOG },
      [`GET /admin/reports/cdr?from=${today}&to=${today}`]: { body: CDR },
      'GET /admin/reports/cdr?from=2026-10-01&to=2026-10-05': { body: CDR },
      'GET /admin/reports/cdr?from=2026-10-01&to=2026-10-05&campaignId=3&direction=inbound': { body: CDR },
      'GET /admin/reports/predictive?from=2026-10-01&to=2026-10-05&campaignId=3&groupBy=campaign': {
        body: PREDICTIVE,
      },
      'GET /admin/reports/predictive?from=2026-10-01&to=2026-10-05&campaignId=3&groupBy=hour': {
        body: PREDICTIVE,
      },
    });
    renderPage(<ReportsPage />);
    await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'Sales');
    await userEvent.selectOptions(screen.getByLabelText('Direction'), 'Inbound');
    await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    expect(calls.some((c) => c.key.endsWith('campaignId=3&direction=inbound'))).toBe(true);

    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Reports' })).getByRole('button', { name: 'Predictive Dialer' }),
    );
    const table = await screen.findByRole('table', { name: 'Predictive Dialer' });
    expect(within(table).getAllByText('1,200')).toHaveLength(2); // row + totals
    expect(within(table).getAllByText('4.5%')[0]).toHaveClass('text-destructive');
    expect(screen.getByText('Keep it under 3 %.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Direction')).not.toBeInTheDocument(); // not a filter of this report
    await userEvent.selectOptions(screen.getByLabelText('Group by'), 'Hour');
    await screen.findByRole('table', { name: 'Predictive Dialer' });
    expect(calls.some((c) => c.key.endsWith('groupBy=hour'))).toBe(true);
  });

  it('a report about the current state has no dates; columns sort on click', async () => {
    fakeApi({
      'GET /admin/reports': { body: CATALOG },
      'GET /admin/reports/lists': {
        body: result({
          report: 'lists',
          title: 'List Penetration',
          columns: [
            { key: 'list', label: 'List' },
            { key: 'leads', label: 'Leads', type: 'number' },
          ],
          rows: [
            { list: 'A', leads: 5 },
            { list: 'B', leads: 50 },
          ],
        }),
      },
    });
    renderPage(<ReportsPage />, { url: '/?r=lists' });
    const table = await screen.findByRole('table', { name: 'List Penetration' });
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    const first = () => within(table).getAllByRole('row')[1];
    expect(within(first()).getByText('A')).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Leads' }));
    await userEvent.click(within(table).getByRole('button', { name: 'Leads' }));
    expect(within(first()).getByText('B')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Leads' })).toHaveAttribute('aria-sort', 'descending');
  });

  it('Call Detail: a recorded call has Play (inline player); without the right it just says Recorded', async () => {
    const withRec = result({
      columns: [
        { key: 'id', label: 'Call', type: 'id' },
        { key: 'recording', label: 'Recording', type: 'recording' },
      ],
      rows: [
        { id: 71, recording: 71 },
        { id: 70, recording: null },
      ],
    });
    fakeApi({
      'GET /admin/reports': { body: CATALOG },
      [`GET /admin/reports/cdr?from=${today}&to=${today}`]: { body: withRec },
    });
    renderPage(<ReportsPage />);
    const table = await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    expect(within(table).queryByText('Yes')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('button', { name: /play recording/i })).toHaveLength(1);
    await userEvent.click(within(table).getByRole('button', { name: 'Play recording of call 71' }));
    expect(within(table).getByLabelText('Recording of call 71')).toHaveAttribute('src', '/admin/calls/71/recording');
    await userEvent.click(within(table).getByRole('button', { name: 'Stop recording of call 71' }));
    expect(within(table).queryByLabelText('Recording of call 71')).not.toBeInTheDocument();
  });

  it('Call Detail without the right to play recordings: "Recorded", no player', async () => {
    fakeApi({
      'GET /auth/me': {
        body: {
          id: 9,
          username: 'tl',
          role: 'staff',
          roleName: 'TL',
          scope: 'all',
          teamCount: 0,
          permissions: { reports: ['view'] },
        },
      },
      'GET /admin/reports': { body: CATALOG },
      [`GET /admin/reports/cdr?from=${today}&to=${today}`]: {
        body: result({
          columns: [{ key: 'recording', label: 'Recording', type: 'recording' }],
          rows: [{ recording: 71 }],
        }),
      },
    });
    renderPage(<ReportsPage />);
    const table = await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    expect(within(table).getByText('Recorded')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /play recording/i })).not.toBeInTheDocument();
  });

  it('no Export CSV without that right', async () => {
    fakeApi({
      'GET /auth/me': {
        body: {
          id: 9,
          username: 'tl',
          role: 'staff',
          roleName: 'TL',
          scope: 'team',
          teamCount: 1,
          permissions: { reports: ['view'] },
        },
      },
      'GET /admin/reports': { body: CATALOG },
      [`GET /admin/reports/cdr?from=${today}&to=${today}`]: { body: CDR },
    });
    renderPage(<ReportsPage />);
    await screen.findByRole('table', { name: 'Call Detail (CDR)' });
    expect(screen.queryByRole('link', { name: /export csv/i })).not.toBeInTheDocument();
  });
});

describe('report helpers', () => {
  it('date presets count from the local day', () => {
    const now = new Date(2026, 2, 3, 10); // 3 March 2026
    expect(presetRange('today', now)).toEqual({ from: '2026-03-03', to: '2026-03-03' });
    expect(presetRange('yesterday', now)).toEqual({ from: '2026-03-02', to: '2026-03-02' });
    expect(presetRange('last7', now)).toEqual({ from: '2026-02-25', to: '2026-03-03' });
    expect(presetRange('thisMonth', now)).toEqual({ from: '2026-03-01', to: '2026-03-03' });
    expect(presetRange('lastMonth', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('cells are formatted by column type', () => {
    expect(formatCell(3725, 'seconds')).toBe('1h 02m');
    expect(formatCell(12.5, 'percent')).toBe('12.5%');
    expect(formatCell(123456, 'number')).toBe('1,23,456');
    expect(formatCell('x', 'text')).toBe('x');
  });
});
