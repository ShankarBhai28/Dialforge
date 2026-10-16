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
    'GET /calls?period=today': { body: [] },
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
        'GET /agent/leads/9/history': {
          body: {
            lead: { id: 9 },
            summary: {
              calls: 3,
              answered: 2,
              talkSeconds: 300,
              lastCallAt: '2026-10-10T10:00:00Z',
              lastSpokeWith: 'agent1001',
              lastSpokeAt: '2026-10-10T10:00:00Z',
              lastOutcome: 'Callback',
              agents: ['agent1001'],
              pendingCallback: null,
            },
            latestForm: null,
            timeline: [],
          },
        },
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
    // Who spoke to this customer before, while the call is live.
    const history = await screen.findByRole('region', { name: 'Customer history' });
    expect(within(history).getByText(/Last spoke with/)).toHaveTextContent('agent1001');

    await userEvent.click(within(panel).getByRole('button', { name: /mute/i }));
    expect(within(panel).getByText(/you are muted/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'Gold');
    await userEvent.click(screen.getByRole('button', { name: 'Save Form' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /agent/form-responses')?.body).toEqual({
        leadId: 9,
        callId: 55,
        data: { amount: '5000', plan: 'Gold' },
        // only what the agent changed updates the lead's current details
        changed: ['plan'],
      }),
    );

    act(() => s.remoteHangup());
    const outcome = await screen.findByRole('dialog', { name: /^disposition$/i });
    await userEvent.click(within(outcome).getByRole('button', { name: 'Callback' }));
    await userEvent.type(within(outcome).getByLabelText('Note (optional)'), 'after 6');
    await userEvent.click(within(outcome).getByRole('button', { name: /confirm callback/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^disposition$/i })).not.toBeInTheDocument());
    const body = calls.find((c) => c.key === 'POST /leads/9/disposition')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'callback', callbackMine: true, note: 'after 6' });
    expect(new Date(body.callbackAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("auto disposition: no disposition given in time -> the campaign's choice is saved by itself", async () => {
    const { calls, ua } = await connect(
      backend({
        'GET /agent/dispositions': {
          body: [
            ...DISPOSITIONS,
            {
              code: 'no_dispo',
              label: 'No Disposition',
              is_final: 0,
              retry_after_min: 60,
              marks_dnc: 0,
              is_callback: 0,
            },
          ],
        },
        'GET /agent/call-policy': { body: { autoAnswer: false } },
        'GET /agent/active-call': { body: ACTIVE },
        'POST /leads/9/disposition': { body: { status: 'ok' } },
        'GET /agent/campaign-info': {
          body: {
            id: 1,
            name: 'Sales',
            dialMode: 'preview',
            wrapupSec: 0,
            dialerState: 'running',
            autoDispo: { seconds: 2, code: 'no_dispo', label: 'No Disposition' },
          },
        },
      }),
    );
    const s = new FakeSession('9876543210', 'Meena');
    act(() => void ua.ring(s));
    const ringing = await screen.findByRole('dialog');
    await userEvent.click(within(ringing).getByRole('button', { name: /accept/i }));
    act(() => s.up());
    await screen.findByRole('region', { name: 'Current call' });
    act(() => s.remoteHangup());
    const popup = await screen.findByRole('dialog', { name: /^disposition$/i });
    expect(await within(popup).findByRole('timer')).toHaveTextContent(/Auto disposition in \ds: No Disposition/);
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /leads/9/disposition')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.key === 'POST /leads/9/disposition')?.body).toMatchObject({
      status: 'no_dispo',
      note: 'Auto disposition (none given in time)',
    });

    // The next call: auto disposition works again (it only worked once before).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^disposition$/i })).not.toBeInTheDocument());
    const s2 = new FakeSession('9876543210', 'Meena');
    act(() => void ua.ring(s2));
    const ringing2 = await screen.findByRole('dialog');
    await userEvent.click(within(ringing2).getByRole('button', { name: /accept/i }));
    act(() => s2.up());
    await screen.findByRole('region', { name: 'Current call' });
    act(() => s2.remoteHangup());
    const popup2 = await screen.findByRole('dialog', { name: /^disposition$/i });
    expect(await within(popup2).findByText('saved automatically')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.key === 'POST /leads/9/disposition')).toHaveLength(2), {
      timeout: 5000,
    });
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

  it('call log: outcome instead of "ended", plays the recording, opens the customer with the last form answers', async () => {
    await connect(
      backend({
        'GET /calls?period=today': {
          body: [
            {
              id: 61,
              lead_id: 7,
              lead_name: 'Ravi',
              direction: 'outbound',
              to_number: '9840012345',
              start_time: '2026-10-13T10:00:00Z',
              answer_time: '2026-10-13T10:00:10Z',
              agent_connect_time: '2026-10-13T10:00:10Z',
              end_time: '2026-10-13T10:02:00Z',
              disposition: 'ended',
              outcome: 'interested',
              outcome_label: 'Interested',
              has_recording: true,
            },
            {
              id: 60,
              lead_id: null,
              direction: 'outbound',
              to_number: '9000000001',
              start_time: '2026-10-13T09:00:00Z',
              answer_time: null,
              end_time: '2026-10-13T09:00:30Z',
              disposition: 'busy',
              has_recording: false,
            },
            {
              id: 59,
              lead_id: null,
              direction: 'inbound',
              to_number: '9000000002',
              start_time: '2026-10-13T08:00:00Z',
              answer_time: '2026-10-13T08:00:05Z',
              agent_connect_time: '2026-10-13T08:00:05Z',
              end_time: '2026-10-13T08:01:00Z',
              disposition: 'ended',
              outcome: null,
              talk_seconds: 55,
            },
          ],
        },
        'GET /agent/leads/7': {
          body: { id: 7, name: 'Ravi', phone: '9840012345', status: 'interested', custom_data: { amount: 100 } },
        },
        'GET /agent/leads/7/history': {
          body: {
            // The lead's current details (the agent's last save made them so).
            lead: { id: 7, customData: { amount: 4500, plan: 'Gold' } },
            summary: {
              calls: 1,
              answered: 1,
              talkSeconds: 110,
              lastCallAt: null,
              lastSpokeWith: 'agent04',
              lastSpokeAt: null,
              lastOutcome: 'Interested',
              agents: [],
              pendingCallback: null,
            },
            latestForm: null,
            formData: { 1: { data: { amount: 4500, plan: 'Gold' }, at: '2026-10-13T10:01:00Z', agent: 'agent04' } },
            timeline: [],
          },
        },
      }),
    );
    const log = screen.getByRole('complementary', { name: 'Dialpad and recent calls' });
    expect(await within(log).findByText('Interested')).toBeInTheDocument();
    expect(within(log).getByText('Busy')).toBeInTheDocument();
    expect(within(log).queryByText('ended')).not.toBeInTheDocument();

    await userEvent.click(within(log).getByRole('button', { name: 'Play recording of 9840012345' }));
    expect(within(log).getByLabelText('Recording of call 61')).toHaveAttribute('src', '/agent/calls/61/recording');
    expect(within(log).queryByRole('button', { name: 'Play recording of 9000000001' })).not.toBeInTheDocument();

    // Clicking the customer opens them, the form filled with the lead's current details.
    expect(within(log).getByText('talked 55s')).toBeInTheDocument();
    // An answered call without an outcome: flagged, and the outcome can be given now.
    expect(within(log).getByText('Needs disposition')).toBeInTheDocument();
    await userEvent.click(within(log).getByRole('button', { name: 'Give disposition for 9000000002' }));
    const late = await screen.findByRole('dialog', { name: /^disposition$/i });
    await userEvent.click(within(late).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /^disposition$/i })).not.toBeInTheDocument();

    await userEvent.click(within(log).getByRole('button', { name: 'Open Ravi' }));
    expect(await screen.findByLabelText('Amount *')).toHaveValue(4500);
    expect(screen.getByLabelText('Plan')).toHaveValue('Gold');
    expect(screen.getByText(/The lead's current details/)).toBeInTheDocument();
    await userEvent.selectOptions(within(log).getByLabelText('Show'), 'Not answered (1)');
    expect(within(log).queryByText('Interested')).not.toBeInTheDocument();
    expect(within(log).getByText('Busy')).toBeInTheDocument();
    await userEvent.selectOptions(within(log).getByLabelText('Show'), 'All calls (3)');
    await userEvent.type(within(log).getByLabelText('Search calls'), 'ravi');
    expect(within(log).getByText('Interested')).toBeInTheDocument();
    expect(within(log).queryByText('Busy')).not.toBeInTheDocument();
  });

  it('before going Available only "Start your shift": no leads, dialpad or calls; picking the queue opens the workbench', async () => {
    let status = 'offline';
    const calls = fakeApi(
      backend({
        'GET /agent/stats': () => ({
          body: {
            loginSeconds: 0,
            talkSeconds: 0,
            breakSeconds: 0,
            acwSeconds: 0,
            handleSeconds: 0,
            currentStatus: status,
            currentReason: null,
            currentQueueName: null,
          },
        }),
        'GET /queues': { body: [{ id: 4, name: 'Support Queue', campaign_name: 'Sales' }] },
        'POST /agent/status': () => {
          status = 'available';
          return { body: { status: 'ok' } };
        },
      }),
    );
    const uas = fakeUAFactory();
    renderPage(<AgentPage createUA={uas.factory} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(uas.made.length).toBe(1));
    act(() => uas.last().register());

    expect(await screen.findByRole('heading', { name: 'Start your shift' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Number to dial')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Leads and callbacks' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Go Available on Support Queue' }));
    expect(calls.find((c) => c.key === 'POST /agent/status')?.body).toEqual({
      status: 'available',
      reason: null,
      queueId: 4,
    });
    expect(await screen.findByLabelText('Number to dial')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start your shift' })).not.toBeInTheDocument();
  });

  it('dialing a number of a deleted lead: no question, an information line in the lead area', async () => {
    const { calls } = await connect(
      backend({
        'POST /calls/click2call': { status: 202, body: { callId: 93, status: 'ringing_agent' } },
        'GET /agent/number-check?phone=8870084698': {
          body: {
            phone: '8870084698',
            dnc: false,
            activeLead: null,
            deletedLead: {
              id: 13,
              name: 'karthi',
              deletedAt: '2026-10-13T18:47:19Z',
              deletedBy: 'admin',
              withList: 'Live Dial Test',
              campaign: 'Predictive_Test',
              lastOutcome: 'Not Interested',
            },
          },
        },
      }),
    );
    await userEvent.type(screen.getByLabelText('Number to dial'), '8870084698');
    await userEvent.click(screen.getByRole('button', { name: /^call$/i }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /calls/click2call')).toBe(true));
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Earlier lead karthi');
    expect(note).toHaveTextContent('with list "Live Dial Test"');
    expect(within(note).getByRole('button', { name: 'See its history' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
