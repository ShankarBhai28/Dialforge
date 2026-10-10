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

  it('Force logout: confirm, then the agent is taken offline; the server reason shows if refused', async () => {
    const calls = fakeApi({
      'GET /admin/live-agents': { body: AGENTS },
      'POST /admin/live-agents/8/logout': { body: { id: 8, status: 'ok', was: 'break' } },
      'POST /admin/live-agents/7/logout': {
        status: 409,
        body: { error: 'agent04 is on a call right now - try again when it ends' },
      },
    });
    renderPage(<LiveAgentsPage />);
    // offline agents have nothing to log out of
    await screen.findByText('agent06');
    expect(screen.queryByRole('button', { name: 'Force logout agent06' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Force logout agent05' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Force logout' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.key === 'POST /admin/live-agents/8/logout')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Force logout agent04' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Force logout' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('on a call right now');
  });

  it('without the Force logout right there is no button', async () => {
    fakeApi({
      'GET /auth/me': {
        body: { id: 30, username: 'tl', role: 'staff', scope: 'all', permissions: { live: ['view'] } },
      },
      'GET /admin/live-agents': { body: AGENTS },
    });
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent05');
    expect(screen.queryByRole('button', { name: /force logout/i })).not.toBeInTheDocument();
  });
});
