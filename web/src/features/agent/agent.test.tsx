// The whole agent screen with a fake phone line and a fake backend.
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage, type FakeApi } from '@/test/render';
import { AgentPage } from './AgentPage';
import { FakeSession, fakeUAFactory } from './softphone/fakes';

const ME = { id: 7, username: 'agent04', role: 'agent', extensionId: 3, extensionName: '1003' };
const FORM = {
  id: 1,
  name: 'Loan form',
  fields: [
    { id: 1, field_key: 'amount', label: 'Amount', field_type: 'number', options: null, is_required: 1 },
    { id: 2, field_key: 'plan', label: 'Plan', field_type: 'dropdown', options: ['Gold', 'Silver'], is_required: 0 },
  ],
};
const DISPOSITIONS = [
  { code: 'interested', label: 'Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'callback', label: 'Callback', is_final: 0, retry_after_min: null, marks_dnc: 0, is_callback: 1 },
];
const ACTIVE = {
  call_id: 55,
  lead_id: 9,
  name: 'Meena',
  phone: '9876543210',
  alt_phone: null,
  status: 'new',
  attempts: 1,
  custom_data: { amount: 5000, city: 'Chennai' },
  list_name: 'Oct list',
  owner: true,
  from_dialer: true,
};

function backend(extra: FakeApi = {}): FakeApi {
  return {
    'GET /auth/me': { body: ME },
    'GET /agent/webrtc-config': { body: { sipDomain: 'x', wsUrl: 'wss://x:8089/ws', iceServers: [] } },
    'GET /agent/extension-credentials': { body: { extension: '1003', sipPassword: 'secret' } },
    'GET /agent/stats': {
      body: {
        loginSeconds: 3725,
        talkSeconds: 60,
        breakSeconds: 0,
        acwSeconds: 0,
        handleSeconds: 60,
        currentStatus: 'available',
        currentReason: null,
        currentQueueName: 'Support Queue',
      },
    },
    'GET /leads': { body: [{ id: 7, name: 'Ravi', phone: '9840012345', status: 'new', custom_data: null }] },
    'GET /agent/callbacks': { body: [] },
    'GET /agent/dispositions': { body: DISPOSITIONS },
    'GET /agent/form': { body: FORM },
    'GET /calls': { body: [] },
    'GET /agent/preview': { body: { enabled: false } },
    'GET /agent/call/control': { body: { controlled: false } },
    ...extra,
  };
}

async function connect(api: FakeApi) {
  const calls = fakeApi(api);
  const uas = fakeUAFactory();
  renderPage(<AgentPage createUA={uas.factory} />);
  await waitFor(() => expect(screen.getByLabelText('Your extension')).toHaveTextContent('1003'));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); // shown, not editable
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(uas.made.length).toBe(1));
  act(() => uas.last().register());
  await screen.findByText('Login Time');
  return { calls, ua: uas.last() };
}

describe('agent screen', () => {
  it('connects the line with the server-provided settings and shows the workbench', async () => {
    const { ua } = await connect(backend());
    expect(ua.options).toMatchObject({ extension: '1003', password: 'secret', wsUrl: 'wss://x:8089/ws' });
    expect((await screen.findAllByText('01:02:05')).length).toBe(2); // top bar + Login tile
    expect(screen.getByRole('button', { name: /available - support queue/i })).toBeInTheDocument();
    expect(await screen.findByText('Ravi')).toBeInTheDocument();
    expect(localStorage.getItem('dialforge_extension')).toBe('1003');
  });

  it('a busy extension: shows why it was refused', async () => {
    fakeApi(
      backend({
        'GET /agent/extension-credentials': {
          status: 409,
          body: { error: 'Extension 1003 is in use by agent1003 right now - pick another one.' },
        },
      }),
    );
    renderPage(<AgentPage createUA={fakeUAFactory().factory} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('in use by agent1003');
  });

  it('incoming call: Accept -> in-call panel with the lead, form pre-filled and saved, outcome at the end', async () => {
    const { calls, ua } = await connect(
      backend({
        'GET /agent/call-policy': { body: { autoAnswer: false } },
        'GET /agent/active-call': { body: ACTIVE },
        'POST /agent/form-responses': { status: 201, body: { id: 1 } },
        'POST /leads/9/disposition': { body: { status: 'ok' } },
        'GET /agent/campaign-info': { body: null },
      }),
    );
    const s = new FakeSession('9876543210', 'Meena');
    act(() => void ua.ring(s));
    const popup = await screen.findByRole('dialog');
    expect(within(popup).getByText('9876543210')).toBeInTheDocument();
    await userEvent.click(within(popup).getByRole('button', { name: /accept/i }));
    expect(s.answered).not.toBeNull();
    act(() => s.up());

    const panel = await screen.findByRole('region', { name: 'Current call' });
    await waitFor(() => expect(within(panel).getByText(/dialer call/i)).toBeInTheDocument());
    // Lead data uploaded with the list fills the form; other data shows as details.
    expect(screen.getByLabelText('Amount *')).toHaveValue(5000);
    expect(screen.getByText('Chennai')).toBeInTheDocument();
    expect(screen.getByText('Saving against: Meena (9876543210)')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /mute/i }));
    expect(within(panel).getByText(/you are muted/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'Gold');
    await userEvent.click(screen.getByRole('button', { name: 'Save Form' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /agent/form-responses')?.body).toEqual({
        leadId: 9,
        callId: 55,
        data: { amount: '5000', plan: 'Gold' },
      }),
    );

    act(() => s.remoteHangup());
    const outcome = await screen.findByRole('dialog', { name: /call outcome/i });
    await userEvent.click(within(outcome).getByRole('button', { name: 'Callback' }));
    await userEvent.type(within(outcome).getByLabelText('Note (optional)'), 'after 6');
    await userEvent.click(within(outcome).getByRole('button', { name: /confirm callback/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /call outcome/i })).not.toBeInTheDocument());
    const body = calls.find((c) => c.key === 'POST /leads/9/disposition')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'callback', callbackMine: true, note: 'after 6' });
    expect(new Date(body.callbackAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('warm transfer to an agent sends the right request', async () => {
    const { calls, ua } = await connect(
      backend({
        'GET /agent/call-policy': { body: { autoAnswer: true } },
        'GET /agent/active-call': { body: ACTIVE },
        'GET /agent/transfer-targets': {
          body: {
            agents: [
              { userId: 2, username: 'agent1001', ext: '1001', status: 'available' },
              { userId: 3, username: 'agent1002', ext: '1002', status: 'on a call' },
            ],
            queues: [],
          },
        },
        'POST /agent/call/transfer': { body: { status: 'consulting' } },
      }),
    );
    const s = new FakeSession('9876543210');
    act(() => void ua.ring(s));
    await waitFor(() => expect(s.answered).not.toBeNull());
    act(() => s.up());
    const panel = await screen.findByRole('region', { name: 'Current call' });
    await userEvent.click(within(panel).getByRole('button', { name: /transfer/i }));
    await userEvent.click(within(panel).getByRole('radio', { name: 'Warm' }));
    // Busy agents can't be picked.
    expect(await within(panel).findByRole('radio', { name: /agent1002/ })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('radio', { name: /agent1001/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Call first' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /agent/call/transfer')?.body).toEqual({
        mode: 'warm',
        targetType: 'agent',
        target: '2',
      }),
    );
  });

  it('clicking a lead opens it; Call starts click-to-call', async () => {
    const { calls } = await connect(backend({ 'POST /calls/click2call': { status: 202, body: { callId: 42 } } }));
    await userEvent.click(await screen.findByText('Ravi'));
    expect(await screen.findByText('Saving against: Ravi (9840012345)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Call Ravi' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /calls/click2call')?.body).toEqual({
        toNumber: '9840012345',
        leadId: 7,
      }),
    );
  });
});
