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
    expect(screen.queryByRole('button', { name: 'Actions for agent06' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for agent05' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Force logout' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Force logout' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.key === 'POST /admin/live-agents/8/logout')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Actions for agent04' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Force logout' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Force logout' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Actions for agent04' }));
    expect(await screen.findByRole('menuitem', { name: 'Listen' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/Connect your monitoring line first/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for agent05' }));
    expect(await screen.findByRole('menuitem', { name: 'Force logout' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Listen' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: /connect monitoring line/i }));
    await waitFor(() => expect(uas.made.length).toBe(1));
    expect(uas.last().options).toMatchObject({ extension: '2001', password: 'pw' });
    act(() => uas.last().register());
    expect(await screen.findByText(/Monitoring line 2001 connected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for agent04' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Listen' }));
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
    expect(screen.queryByRole('button', { name: /actions for/i })).not.toBeInTheDocument();
  });
});

describe('Live agents - wallboard', () => {
  it('one line per agent: campaign, line, call type, the current call with its lead and talk time; waiting callers on top', async () => {
    const started = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // a 20-minute break
    fakeApi({
      'GET /admin/live-agents': {
        body: [
          {
            id: 7,
            username: 'agent04',
            extension_name: '1003',
            status: 'available',
            reason: null,
            started_at: started,
            queue_name: 'Sales Q',
            campaign_name: 'Home Loans',
            teams: 'Team A',
            line: 'registered',
            login_at: started,
            active_call_number: '9003220102',
            call: {
              id: 70,
              number: '9003220102',
              leadName: 'Ravi',
              kind: 'dialer',
              type: 'progressive',
              startedAt: started,
              connectedAt: started,
            },
            today: { calls: 12, connected: 6, talkSeconds: 900, avgHandleSeconds: 170 },
          },
          {
            id: 8,
            username: 'agent05',
            extension_name: '1004',
            status: 'break',
            reason: 'Tea',
            warn: { breakWarnMin: 15, breakAlertMin: 30, acwWarnSec: 60 },
            started_at: started,
            queue_name: 'Sales Q',
            campaign_name: 'Home Loans',
            line: 'unregistered',
            login_at: started,
            active_call_number: null,
            call: null,
            today: { calls: 0, connected: 0, talkSeconds: 0, avgHandleSeconds: null },
          },
        ],
      },
      'GET /admin/live-agents/summary': {
        body: {
          waiting: 3,
          waitingInbound: 2,
          waitingDialer: 1,
          longestWaitSeconds: 75,
          today: { calls: 40, connected: 22, talkSeconds: 3600 },
        },
      },
    });
    renderPage(<LiveAgentsPage />);
    const row = (await screen.findByText('agent04')).closest('tr')!;
    expect(within(row).queryByText('Team A')).not.toBeInTheDocument(); // Team is under Columns
    expect(within(row).getByText('Home Loans')).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'phone line connected' })).toBeInTheDocument();
    expect(within(row).getByText(/· Ravi/)).toBeInTheDocument();
    expect(within(row).getByText('Progressive')).toBeInTheDocument();
    expect(within(row).getByText(/^talk 20m/)).toBeInTheDocument();
    expect(within(row).queryByText(/12 calls/)).not.toBeInTheDocument();
    const onBreak = screen.getByText('agent05').closest('tr')!;
    expect(within(onBreak).getByRole('img', { name: 'phone line not connected' })).toBeInTheDocument();
    // 20 minutes on break: amber with this campaign's limits (amber 15, red 30)
    expect(within(onBreak).getByText(/^20m/).className).toMatch(/text-status-break/);
    const floor = await screen.findByLabelText('Floor');
    expect(within(floor).getByText('3 waiting')).toBeInTheDocument();
    expect(within(floor).getByText(/longest 1m 15s/)).toBeInTheDocument();
    expect(within(floor).getByText(/2 inbound · 1 dialer/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Filter by campaign'), 'Home Loans');
    expect(screen.getByText('agent04')).toBeInTheDocument();
  });

  it('Columns adds Team, Queue, Today and Logged in; the choice is remembered', async () => {
    const started = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fakeApi({
      'GET /admin/live-agents': {
        body: [
          {
            id: 7,
            username: 'agent04',
            extension_name: '1003',
            status: 'available',
            reason: null,
            started_at: started,
            queue_name: 'Sales Q',
            campaign_name: 'Home Loans',
            teams: 'Team A',
            line: 'registered',
            login_at: started,
            active_call_number: null,
            call: null,
            today: { calls: 12, connected: 6, talkSeconds: 900, avgHandleSeconds: 170 },
          },
        ],
      },
    });
    const { unmount } = renderPage(<LiveAgentsPage />);
    const row = (await screen.findByText('agent04')).closest('tr')!;
    expect(within(row).getByText(/^idle 5m/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Queue' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Queue' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Team' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Today/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Columns (+3)' })).toBeInTheDocument();
    const wide = screen.getByText('agent04').closest('tr')!;
    expect(within(wide).getByText('Sales Q')).toBeInTheDocument();
    expect(within(wide).getByText('Team A')).toBeInTheDocument();
    expect(within(wide).getByText(/12 calls · talk 15m 00s · AHT 2m 50s/)).toBeInTheDocument();
    unmount();
    renderPage(<LiveAgentsPage />);
    await screen.findByText('agent04');
    expect(screen.getByRole('columnheader', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Logged in' })).not.toBeInTheDocument();
  });

  it('call type: each kind of call gets its own label', async () => {
    const at = new Date().toISOString();
    const agent = (id: number, type: string | undefined, kind = 'outbound') => ({
      id,
      username: 'agent' + id,
      extension_name: String(1000 + id),
      status: 'available',
      reason: null,
      started_at: at,
      queue_name: null,
      active_call_number: '9000000000',
      call: { id, number: '9000000000', leadName: null, kind, type, startedAt: at, connectedAt: at },
    });
    fakeApi({
      'GET /admin/live-agents': {
        body: [
          agent(1, 'inbound', 'inbound'),
          agent(2, 'manual'),
          agent(3, 'predictive', 'dialer'),
          agent(4, 'preview'),
          agent(5, 'callback'),
          agent(6, 'transfer'),
          agent(7, undefined, 'dialer'), // older server: only kind
        ],
      },
    });
    renderPage(<LiveAgentsPage />);
    // Columns: agent, status, ext, campaign, call type, ...
    const typeOf = async (name: string) =>
      within((await screen.findByText(name)).closest('tr')!).getAllByRole('cell')[4];
    expect(await typeOf('agent1')).toHaveTextContent('Inbound');
    expect(await typeOf('agent2')).toHaveTextContent('Manual');
    expect(await typeOf('agent3')).toHaveTextContent('Predictive');
    expect(await typeOf('agent4')).toHaveTextContent('Preview');
    expect(await typeOf('agent5')).toHaveTextContent('Callback');
    expect(await typeOf('agent6')).toHaveTextContent('Transfer');
    expect(await typeOf('agent7')).toHaveTextContent('Predictive');
  });

  it('break and wrap-up colours: defaults amber at 10 min, red at 15; wrap-up red 60 s past its time', async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60 * 1000).toISOString();
    const agent = (id: number, status: string, startedMin: number) => ({
      id,
      username: 'agent' + id,
      extension_name: String(1000 + id),
      status,
      reason: null,
      started_at: ago(startedMin),
      queue_name: null,
      active_call_number: null,
      wrapup_sec: 30,
    });
    fakeApi({
      'GET /admin/live-agents': {
        body: [
          agent(1, 'break', 5),
          agent(2, 'break', 12),
          agent(3, 'break', 16),
          agent(4, 'acw', 1),
          agent(5, 'acw', 2),
        ],
      },
    });
    renderPage(<LiveAgentsPage />);
    const timer = async (name: string) =>
      within((await screen.findByText(name)).closest('tr')!).getByTitle(/In this status since/);
    expect((await timer('agent1')).className).toMatch(/text-muted-foreground/);
    expect((await timer('agent2')).className).toMatch(/text-status-break/);
    expect((await timer('agent3')).className).toMatch(/text-destructive/);
    expect((await timer('agent4')).className).toMatch(/text-muted-foreground/); // 60 s < 30 + 60
    expect((await timer('agent5')).className).toMatch(/text-destructive/); // 120 s > 30 + 60
  });
});
