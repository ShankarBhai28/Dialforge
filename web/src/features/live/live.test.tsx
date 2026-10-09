import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { LiveAgentsPage } from './LiveAgentsPage';

// Rows as GET /admin/live-agents returns them (users + open agent_status_log).
const AGENTS = [
  {
    id: 7,
    username: 'agent04',
    extension_name: '1003',
    status: 'available',
    reason: null,
    started_at: '2026-10-09T05:00:00.000Z',
    queue_name: 'Sales',
    active_call_number: '9876543210',
  },
  {
    id: 8,
    username: 'agent05',
    extension_name: '1004',
    status: 'break',
    reason: 'Lunch',
    started_at: '2026-10-09T05:10:00.000Z',
    queue_name: 'Sales',
    active_call_number: null,
  },
  {
    id: 9,
    username: 'agent06',
    extension_name: null,
    status: null,
    reason: null,
    started_at: null,
    queue_name: null,
    active_call_number: null,
  },
];

describe('Live Agents', () => {
  it('shows each agent with status, queue and active call', async () => {
    fakeApi({ 'GET /admin/live-agents': { body: AGENTS } });
    renderPage(<LiveAgentsPage />);
    const onCall = (await screen.findByText('agent04')).closest('tr')!;
    expect(within(onCall).getByText('On call')).toBeInTheDocument();
    expect(within(onCall).getByText('9876543210')).toBeInTheDocument();
    expect(within(onCall).getByText('1003')).toBeInTheDocument();
    const onBreak = screen.getByText('agent05').closest('tr')!;
    expect(within(onBreak).getByText('Break')).toBeInTheDocument();
    expect(within(onBreak).getByText('Lunch')).toBeInTheDocument();
    const offline = screen.getByText('agent06').closest('tr')!;
    expect(within(offline).getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('On call: 1')).toBeInTheDocument();
    expect(screen.getByText('Break: 1')).toBeInTheDocument();
  });

  it('reloads on Refresh', async () => {
    const calls = fakeApi({ 'GET /admin/live-agents': { body: AGENTS } });
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent04');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(calls.filter((c) => c.key === 'GET /admin/live-agents')).toHaveLength(2));
  });

  it('says so when there are no agents', async () => {
    fakeApi({ 'GET /admin/live-agents': { body: [] } });
    renderPage(<LiveAgentsPage />);
    expect(await screen.findByText('No agents found')).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    fakeApi({ 'GET /admin/live-agents': { status: 500, body: { error: 'database unavailable' } } });
    renderPage(<LiveAgentsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
  });
});
