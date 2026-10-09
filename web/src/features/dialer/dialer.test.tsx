import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { DialerPage } from './DialerPage';

// A GET /admin/dialer campaign row: DECIMAL and SUM() columns arrive as strings,
// dialer_status columns are null until the engine has ticked for it.
function campaign(over: Record<string, unknown>) {
  return {
    id: 1,
    name: 'Predictive_Test',
    status: 'active',
    dial_mode: 'predictive',
    dial_ratio: '1.00',
    max_dial_ratio: '2.50',
    dialer_state: 'running',
    dialer_state_changed_at: '2026-10-09T04:30:00.000Z',
    changed_by: 'admin',
    queue_name: 'Sales',
    hopper_ready: 12,
    hopper_locked: 2,
    idle_agents: 3,
    would_dial: 4,
    in_flight: 2,
    active_calls: 5,
    note: null,
    last_tick_at: '2026-10-09T05:00:00.000Z',
    current_ratio: '1.80',
    answer_rate: '42.50',
    abandon_pct: '1.20',
    ratio_adjust: '0.90',
    pacing_note: 'abandons under target',
    today: {
      campaign_id: 1,
      attempts: 40,
      answered: '20',
      connected: '18',
      abandoned: '1',
      not_reached: '18',
      machine: '2',
    },
    ...over,
  };
}

const STOPPED = campaign({
  id: 4,
  name: 'Support',
  dial_mode: 'progressive',
  dial_ratio: '1.50',
  dialer_state: 'stopped',
  dialer_state_changed_at: null,
  changed_by: null,
  hopper_ready: null,
  hopper_locked: null,
  idle_agents: null,
  would_dial: null,
  in_flight: null,
  active_calls: null,
  last_tick_at: null,
  current_ratio: null,
  answer_rate: null,
  abandon_pct: null,
  ratio_adjust: null,
  pacing_note: null,
  today: null,
});

const OVERVIEW = {
  body: {
    engine: { engine_id: 'engine-1', last_tick_at: '2026-10-09T05:00:00.000Z', age_sec: 2, alive: true },
    campaigns: [campaign({}), STOPPED],
  },
};

const HOPPER = [
  {
    id: 50,
    campaign_id: 1,
    lead_id: 300,
    list_id: 2,
    phone: '9000000300',
    is_callback: 1,
    list_priority: 5,
    lead_priority: 0,
    attempts: 1,
    reserved_user_id: 7,
    status: 'locked',
    locked_at: '2026-10-09T05:00:00.000Z',
    locked_by: 'dialer',
    inserted_at: '2026-10-09T04:59:00.000Z',
    name: 'Ravi Kumar',
    list_name: 'October leads',
    reserved_for: 'agent04',
  },
];

describe('Dialer', () => {
  it('shows engine status, live numbers and today stats per campaign', async () => {
    fakeApi({ 'GET /admin/dialer': OVERVIEW });
    renderPage(<DialerPage />);
    const row = (await screen.findByText('Predictive_Test')).closest('tr')!;
    expect(screen.getByText('Engine: running')).toBeInTheDocument();
    expect(within(row).getByText('predictive ≤2.5:1')).toBeInTheDocument();
    expect(within(row).getByText(/now 1\.8:1 · answer 43% · abandon 1\.2% · adjust 0\.9/)).toBeInTheDocument();
    expect(within(row).getByText('12 ready / 2 locked')).toBeInTheDocument();
    expect(within(row).getByText('40 dialed · 20 answered · 18 to agent')).toBeInTheDocument();
    expect(within(row).getByText('1 abandoned (5.0%)')).toHaveClass('text-destructive');
    const stopped = screen.getByText('Support').closest('tr')!;
    expect(within(stopped).getByText('progressive 1.5:1')).toBeInTheDocument();
    expect(within(stopped).getByText('no calls')).toBeInTheDocument();
    // Running: Pause + Stop, no Start. Stopped: Start only.
    expect(within(row).queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
    expect(within(stopped).queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('flags a dead engine', async () => {
    fakeApi({
      'GET /admin/dialer': {
        body: {
          engine: { engine_id: 'engine-1', last_tick_at: '2026-10-09T04:00:00.000Z', age_sec: 3600, alive: false },
          campaigns: [],
        },
      },
    });
    renderPage(<DialerPage />);
    expect(await screen.findByText(/Engine: DOWN/)).toBeInTheDocument();
    expect(screen.getByText('No campaigns.')).toBeInTheDocument();
  });

  it('starts only after confirming that real calls will be placed', async () => {
    const calls = fakeApi({
      'GET /admin/dialer': OVERVIEW,
      'POST /admin/campaigns/4/dialer': { body: { status: 'ok', dialerState: 'running' } },
    });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start Support' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/real calls/i);
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start dialing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/campaigns/4/dialer')?.body).toEqual({ action: 'start' });
  });

  it('pauses straight away', async () => {
    const calls = fakeApi({
      'GET /admin/dialer': OVERVIEW,
      'POST /admin/campaigns/1/dialer': { body: { status: 'ok', dialerState: 'paused' } },
    });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause Predictive_Test' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /admin/campaigns/1/dialer')?.body).toEqual({ action: 'pause' }),
    );
  });

  it("shows the server's reason when stop fails, and keeps the dialog open", async () => {
    const calls = fakeApi({
      'GET /admin/dialer': OVERVIEW,
      'POST /admin/campaigns/1/dialer': { status: 404, body: { error: 'campaign not found' } },
    });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/hopper will be emptied/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('campaign not found');
    expect(calls.find((c) => c.key === 'POST /admin/campaigns/1/dialer')?.body).toEqual({ action: 'stop' });
  });

  it("shows the server's reason when pause fails", async () => {
    fakeApi({
      'GET /admin/dialer': OVERVIEW,
      'POST /admin/campaigns/1/dialer': { status: 400, body: { error: 'only a running campaign can be paused' } },
    });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause Predictive_Test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only a running campaign can be paused');
  });

  it('opens and closes the hopper for a campaign', async () => {
    fakeApi({ 'GET /admin/dialer': OVERVIEW, 'GET /admin/campaigns/1/hopper': { body: HOPPER } });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Hopper Predictive_Test' }));
    expect(await screen.findByText('Hopper - Predictive_Test (1)')).toBeInTheDocument();
    const row = screen.getByText('Ravi Kumar').closest('tr')!;
    expect(within(row).getByText('Yes (agent04)')).toBeInTheDocument();
    expect(within(row).getByText('October leads')).toBeInTheDocument();
    expect(within(row).getByText('locked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText('Ravi Kumar')).not.toBeInTheDocument();
  });

  it('says when the hopper is empty', async () => {
    fakeApi({ 'GET /admin/dialer': OVERVIEW, 'GET /admin/campaigns/4/hopper': { body: [] } });
    renderPage(<DialerPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Hopper Support' }));
    expect(await screen.findByText('Hopper is empty.')).toBeInTheDocument();
  });

  it("shows the server's error when the overview fails", async () => {
    fakeApi({ 'GET /admin/dialer': { status: 500, body: { error: 'database unavailable' } } });
    renderPage(<DialerPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
  });
});
