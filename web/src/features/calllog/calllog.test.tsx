import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CallLogPage } from './CallLogPage';

// GET /admin/calls rows: `calls.*` (all columns, after every migration) + joined names.
function call(over: Record<string, unknown>) {
  return {
    id: 1,
    tenant_id: 1,
    lead_id: null,
    extension_id: null,
    direction: 'outbound',
    from_extension: '1003',
    to_number: '9876543210',
    ari_channel_id: null,
    disposition: null,
    start_time: '2026-10-09T05:00:00.000Z',
    answer_time: null,
    end_time: null,
    campaign_id: 1,
    auto_answer: 0,
    agent_channel: null,
    transfer_ext: null,
    channel_name: null,
    dial_attempt_id: null,
    campaign_name: 'Sales',
    lead_name: null,
    ...over,
  };
}

const FIRST = 'GET /admin/calls?page=1&pageSize=50';
const paged = (rows: unknown[], total = rows.length, page = 1) => ({ body: { rows, total, page, pageSize: 50 } });

describe('Call Log', () => {
  it('lists calls with disposition and talk time', async () => {
    fakeApi({
      [FIRST]: paged([
        call({
          id: 2,
          to_number: '9000000002',
          disposition: 'ended',
          answer_time: '2026-10-09T05:00:10.000Z',
          end_time: '2026-10-09T05:02:15.000Z',
        }),
        call({ id: 1, to_number: '9000000001', from_extension: null }),
      ]),
    });
    renderPage(<CallLogPage />);
    const ended = (await screen.findByText('9000000002')).closest('tr')!;
    expect(within(ended).getByText('ended')).toBeInTheDocument();
    expect(within(ended).getByText('2m 05s')).toBeInTheDocument();
    const unanswered = screen.getByText('9000000001').closest('tr')!;
    expect(within(unanswered).getByText('no answer')).toBeInTheDocument();
  });

  it('reloads on Refresh', async () => {
    const calls = fakeApi({ [FIRST]: paged([call({})]) });
    renderPage(<CallLogPage />);
    await screen.findByText('9876543210');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(calls.filter((c) => c.key === FIRST)).toHaveLength(2));
  });

  it('shows an empty state', async () => {
    fakeApi({ [FIRST]: paged([]) });
    renderPage(<CallLogPage />);
    expect(await screen.findByText('No calls yet')).toBeInTheDocument();
  });

  it('sends the filters to the server and goes back to page 1', async () => {
    const calls = fakeApi({
      [FIRST]: paged([call({ id: 1, to_number: '9000000001' })], 120),
      'GET /admin/calls?page=2&pageSize=50': paged([call({ id: 2, to_number: '9000000002' })], 120, 2),
      'GET /admin/calls?disposition=none&page=1&pageSize=50': paged([call({ id: 3, to_number: '9000000003' })]),
      'GET /admin/calls?q=98&disposition=none&from=2026-10-01&to=2026-10-09&page=1&pageSize=50': paged([]),
    });
    renderPage(<CallLogPage />);
    await screen.findByText('9000000001');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('9000000002')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Filter by disposition'), 'Not answered');
    expect(await screen.findByText('9000000003')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('From date'), '2026-10-01');
    await userEvent.type(screen.getByLabelText('To date'), '2026-10-09');
    await userEvent.type(screen.getByLabelText('Search number'), '+98');
    expect(await screen.findByText('No calls match these filters')).toBeInTheDocument();
    // every request after a filter change asks for page 1
    expect(calls.filter((c) => c.key.includes('disposition=') && !c.key.includes('page=1&'))).toHaveLength(0);
  });

  it('asks the server for the next page', async () => {
    const calls = fakeApi({
      [FIRST]: paged([call({ id: 1, to_number: '9000000001' })], 51),
      'GET /admin/calls?page=2&pageSize=50': paged([call({ id: 2, to_number: '9000000002' })], 51, 2),
    });
    renderPage(<CallLogPage />);
    await screen.findByText('9000000001');
    expect(screen.getByText('1–50 of 51')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('9000000002')).toBeInTheDocument();
    expect(screen.queryByText('9000000001')).not.toBeInTheDocument();
    expect(screen.getByText('51–51 of 51')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /admin/calls?page=2&pageSize=50')).toBe(true);
  });

  it("shows the server's error", async () => {
    fakeApi({ [FIRST]: { status: 401, body: { error: 'not logged in' } } });
    renderPage(<CallLogPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not logged in');
  });
});
