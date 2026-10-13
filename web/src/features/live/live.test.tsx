import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { FakeSession, fakeUAFactory } from '@/features/agent/softphone/fakes';
import { configureMonitorLine, disconnectMonitorLine } from '@/features/monitor/monitorLine';
import { LiveAgentsPage } from './LiveAgentsPage';

afterEach(() => {
  disconnectMonitorLine();
  configureMonitorLine({ createUA: null });
  localStorage.clear();
});

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
    expect(screen.getByText('On call: 1')).toBeInTheDocument();
    expect(screen.getByText('Break: 1')).toBeInTheDocument();
    // logged-in agents only by default; offline ones under "All agents"
    expect(screen.queryByText('agent06')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'All agents');
    const offline = screen.getByText('agent06').closest('tr')!;
    expect(within(offline).getByText('Offline')).toBeInTheDocument();
  });

  it('filters by status (also by clicking a count), name or extension, and queue; the status choice is remembered', async () => {
    fakeApi({ 'GET /admin/live-agents': { body: AGENTS } });
    const { unmount } = renderPage(<LiveAgentsPage />);
    await screen.findByText('agent04');
    await userEvent.click(screen.getByRole('button', { name: 'Break: 1' }));
    expect(screen.queryByText('agent04')).not.toBeInTheDocument();
    expect(screen.getByText('agent05')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Break: 1' })); // again = back to logged in
    expect(screen.getByText('agent04')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search agent'), '1003');
    expect(screen.getByText('agent04')).toBeInTheDocument();
    expect(screen.queryByText('agent05')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search agent'));
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'Offline');
    expect(screen.getByText('agent06')).toBeInTheDocument();
    unmount();
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent06');
    expect(screen.getByLabelText('Show')).toHaveValue('offline');
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
    await screen.findByText('agent04');
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'All agents');
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

  it('monitoring: connect the line, listen to an agent on a call, switch to whisper (key 5), stop', async () => {
    const uas = fakeUAFactory();
    configureMonitorLine({ createUA: uas.factory });
    const calls = fakeApi({
      'GET /admin/live-agents': { body: AGENTS },
      'GET /admin/monitor/line': {
        body: { extension: '2001', sipPassword: 'pw', sipDomain: 'x', wsUrl: 'wss://x:8089/ws', iceServers: [] },
      },
      'POST /admin/live-agents/7/monitor': { body: { status: 'ringing', mode: 'listen' } },
    });
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent04');
    // not before the line is connected; only agents on a call
    expect(screen.getByRole('button', { name: 'Listen agent04' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Listen agent05' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /connect monitoring line/i }));
    await waitFor(() => expect(uas.made.length).toBe(1));
    expect(uas.last().options).toMatchObject({ extension: '2001', password: 'pw' });
    act(() => uas.last().register());
    expect(await screen.findByText(/Monitoring line 2001 connected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Listen agent04' }));
    expect(calls.find((c) => c.key === 'POST /admin/live-agents/7/monitor')?.body).toEqual({ mode: 'listen' });
    // Asterisk calls the line: answered by itself, other calls are refused
    const other = new FakeSession('5555', 'Someone');
    act(() => void uas.last().ring(other));
    expect(other.terminated).toBe(true);
    const s = new FakeSession('1003', 'Monitor agent04');
    act(() => void uas.last().ring(s));
    expect(s.answered).not.toBeNull();
    act(() => s.up());
    expect(await screen.findByText('Listening to agent04')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Whisper' }));
    expect(s.dtmf).toEqual(['5']);
    expect(screen.getByText('Whispering to agent04')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(s.terminated).toBe(true);
  });

  it('monitoring: the server reason shows when it refuses (e.g. no monitoring line)', async () => {
    fakeApi({
      'GET /admin/live-agents': { body: AGENTS },
      'GET /admin/monitor/line': {
        status: 409,
        body: { error: 'You have no monitoring line - ask a Super Admin to give you an extension (Users).' },
      },
    });
    renderPage(<LiveAgentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /connect monitoring line/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no monitoring line');
  });

  it('a role without monitoring rights sees no monitoring bar or buttons', async () => {
    fakeApi({
      'GET /auth/me': {
        body: { id: 30, username: 'tl', role: 'staff', scope: 'all', permissions: { live: ['view'] } },
      },
      'GET /admin/live-agents': { body: AGENTS },
    });
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent04');
    expect(screen.queryByRole('region', { name: 'Call monitoring' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /listen/i })).not.toBeInTheDocument();
  });
});
