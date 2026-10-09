import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CallLogPage } from './CallLogPage';

// `SELECT * FROM calls` rows (all columns, after every migration).
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
    ...over,
  };
}

describe('Call Log', () => {
  it('lists calls with disposition and talk time', async () => {
    fakeApi({
      'GET /calls': {
        body: [
          call({
            id: 2,
            to_number: '9000000002',
            disposition: 'ended',
            answer_time: '2026-10-09T05:00:10.000Z',
            end_time: '2026-10-09T05:02:15.000Z',
          }),
          call({ id: 1, to_number: '9000000001', from_extension: null }),
        ],
      },
    });
    renderPage(<CallLogPage />);
    const ended = (await screen.findByText('9000000002')).closest('tr')!;
    expect(within(ended).getByText('ended')).toBeInTheDocument();
    expect(within(ended).getByText('2m 05s')).toBeInTheDocument();
    const unanswered = screen.getByText('9000000001').closest('tr')!;
    expect(within(unanswered).getByText('no answer')).toBeInTheDocument();
  });

  it('reloads on Refresh', async () => {
    const calls = fakeApi({ 'GET /calls': { body: [call({})] } });
    renderPage(<CallLogPage />);
    await screen.findByText('9876543210');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(calls.filter((c) => c.key === 'GET /calls')).toHaveLength(2));
  });

  it('shows an empty state', async () => {
    fakeApi({ 'GET /calls': { body: [] } });
    renderPage(<CallLogPage />);
    expect(await screen.findByText('No calls yet')).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    fakeApi({ 'GET /calls': { status: 401, body: { error: 'not logged in' } } });
    renderPage(<CallLogPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not logged in');
  });
});
