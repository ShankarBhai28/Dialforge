import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { toDateInput } from '@/lib/format';
import { ReportsPage } from './ReportsPage';

const today = toDateInput();
const CAMPAIGN_ROW = {
  campaign_id: 1,
  campaign_name: 'Sales',
  total_leads: 120,
  total_calls: 40,
  answered: 30,
  not_answered: 8,
  abandoned: 2,
  answer_rate: 75,
  avg_talk_seconds: 125,
};
const AGENT_ROW = {
  user_id: 7,
  username: 'agent04',
  login_seconds: 3900,
  total_calls: 12,
  answered_calls: 10,
  talk_seconds: 600,
  avg_talk_seconds: 50,
  callbacks_set: 3,
};
const CALL_ROW = {
  id: 55,
  direction: 'outbound',
  from_extension: '1003',
  to_number: '9876543210',
  disposition: 'abandoned',
  start_time: '2026-10-01T10:00:00Z',
  answer_time: null,
  end_time: '2026-10-01T10:01:00Z',
  campaign_name: 'Sales',
};

describe('Reports', () => {
  it("loads today's campaign report, then refetches when the range changes; CSV link follows", async () => {
    const calls = fakeApi({
      [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { body: [CAMPAIGN_ROW] },
      'GET /admin/reports/campaigns?from=2026-10-01&to=2026-10-05': { body: [{ ...CAMPAIGN_ROW, total_calls: 99 }] },
    });
    renderPage(<ReportsPage />);
    const row = (await screen.findByText('Sales')).closest('tr')!;
    expect(within(row).getByText('75%')).toBeInTheDocument();
    expect(within(row).getByText('2m 05s')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      `/admin/reports/campaigns?from=${today}&to=${today}&format=csv`,
    );

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    expect(await screen.findByText('99')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /admin/reports/campaigns?from=2026-10-01&to=2026-10-05')).toBe(true);
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      '/admin/reports/campaigns?from=2026-10-01&to=2026-10-05&format=csv',
    );
  });

  it('blocks a reversed range instead of querying it', async () => {
    const calls = fakeApi({ [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { body: [CAMPAIGN_ROW] } });
    renderPage(<ReportsPage />);
    await screen.findByText('Sales');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2099-01-01' } });
    expect(screen.getByText('"From" must be on or before "To".')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /export csv/i })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.key.includes('2099'))).toHaveLength(0);
  });

  it('shows the agent report', async () => {
    fakeApi({
      [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { body: [] },
      [`GET /admin/reports/agents?from=${today}&to=${today}`]: { body: [AGENT_ROW] },
    });
    renderPage(<ReportsPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    const row = (await screen.findByText('agent04')).closest('tr')!;
    expect(within(row).getByText('1h 05m')).toBeInTheDocument();
    expect(within(row).getByText('10m 00s')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      `/admin/reports/agents?from=${today}&to=${today}&format=csv`,
    );
  });

  it('filters the call report by campaign and disposition', async () => {
    const filtered = `GET /admin/reports/calls?from=${today}&to=${today}&campaignId=1&disposition=abandoned`;
    const calls = fakeApi({
      [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { body: [] },
      [`GET /admin/reports/calls?from=${today}&to=${today}`]: { body: [] },
      [filtered]: { body: [CALL_ROW] },
      'GET /admin/campaigns': { body: [{ id: 1, name: 'Sales', status: 'active' }] },
    });
    renderPage(<ReportsPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Call' }));
    expect(await screen.findByText('No calls match these filters.')).toBeInTheDocument();
    await screen.findByRole('option', { name: 'Sales' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Campaign' }), 'Sales');
    await userEvent.selectOptions(screen.getByLabelText('Disposition'), 'abandoned');
    expect(await screen.findByText('9876543210')).toBeInTheDocument();
    expect(calls.some((c) => c.key === filtered)).toBe(true);
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      `${filtered.slice(4)}&format=csv`,
    );
  });

  it('shows the hourly breakdown for a date', async () => {
    const hours = Array.from({ length: 24 }, (_, h) =>
      h === 10
        ? { hour: 10, total_calls: 8, answered: 6, answer_rate: 75 }
        : { hour: h, total_calls: 0, answered: 0, answer_rate: 0 },
    );
    fakeApi({
      [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { body: [] },
      [`GET /admin/reports/hourly?date=${today}`]: { body: hours },
      'GET /admin/reports/hourly?date=2026-10-01': { body: hours },
    });
    renderPage(<ReportsPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Hourly' }));
    expect(await screen.findByText('8 calls · 75%')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-01' } });
    expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute(
      'href',
      '/admin/reports/hourly?date=2026-10-01&format=csv',
    );
  });

  it("shows the server's error with retry", async () => {
    fakeApi({
      [`GET /admin/reports/campaigns?from=${today}&to=${today}`]: { status: 500, body: { error: 'report failed' } },
    });
    renderPage(<ReportsPage />);
    expect(await screen.findByText('report failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
