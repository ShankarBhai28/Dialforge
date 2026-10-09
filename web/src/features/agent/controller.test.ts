// The agent call workflow against a fake phone line and a fake backend.
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { fakeApi, type FakeApi } from '@/test/render';
import { AgentController } from './controller';
import { Softphone } from './softphone/softphone';
import { FakeSession, fakeUAFactory } from './softphone/fakes';
import type { ActiveCall } from './api';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await flush();
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function setup(api: FakeApi, { queue = { id: 4, name: 'Support Queue' } as { id: number; name: string } | null } = {}) {
  const calls = fakeApi(api);
  const uas = fakeUAFactory();
  const phone = new Softphone(uas.factory);
  const storage = memoryStorage();
  if (queue) storage.setItem('dialforge.agent.queue', JSON.stringify(queue));
  const controller = new AgentController({
    phone,
    queryClient: new QueryClient(),
    sleep: () => flush(),
    storage,
  });
  phone.connect({ extension: '1003', password: 'x', wsUrl: 'wss://x', sipDomain: 'x', iceServers: [] });
  uas.last().register();
  return { calls, phone, ua: uas.last(), controller, state: () => controller.getSnapshot() };
}

const LEAD = { id: 7, name: 'Ravi', phone: '9840012345', status: 'new' };
const ACTIVE: ActiveCall = {
  call_id: 55,
  lead_id: 9,
  name: 'Meena',
  phone: '9876543210',
  alt_phone: null,
  status: 'new',
  attempts: 1,
  custom_data: { amount: 5000 },
  list_name: 'Oct list',
  owner: true,
  from_dialer: true,
};

describe('click-to-call', () => {
  it('auto-answers our own leg, shows "ringing customer" until answered, then asks for the outcome', async () => {
    let answered = false;
    const t = setup({
      'POST /calls/click2call': { status: 202, body: { callId: 42, status: 'ringing_agent' } },
      'GET /agent/call-state/42': () => ({ body: { answered, ended: false } }),
      'POST /leads/7/disposition': { body: { status: 'ok' } },
      'GET /agent/campaign-info': {
        body: { id: 1, name: 'P', dialMode: 'progressive', wrapupSec: 0, dialerState: 'running' },
      },
      'GET /agent/stats': { body: { currentStatus: 'acw' } },
      'POST /agent/status': { body: { status: 'ok' } },
    });
    await t.controller.callLead(LEAD, LEAD.phone);
    expect(t.calls.find((c) => c.key === 'POST /calls/click2call')?.body).toEqual({
      toNumber: '9840012345',
      leadId: 7,
    });
    expect(t.state().workspace).toMatchObject({ lead: LEAD, callId: 42, contextText: 'Ravi (9840012345)' });

    // The server rings our line: answered without a popup.
    const s = t.ua.ring(new FakeSession('1003'));
    expect(s.answered).not.toBeNull();
    expect(t.state().incoming).toBeNull();
    s.up();
    await settle();
    expect(t.state().call).toMatchObject({ number: '9840012345', kind: 'Outbound call', ringingCustomer: true });

    answered = true;
    await settle();
    expect(t.state().call?.ringingCustomer).toBe(false);
    expect(t.state().call?.talkStartedAt).toBeTypeOf('number');

    s.remoteHangup();
    expect(t.state().outcomeFor).toEqual(LEAD);

    await t.controller.saveOutcome(7, 'interested');
    expect(t.state().outcomeFor).toBeNull();
    await settle();
    // Progressive campaign: back to Available by itself after wrap-up (here 0 s).
    expect(t.calls.find((c) => c.key === 'POST /agent/status')?.body).toEqual({
      status: 'available',
      reason: null,
      queueId: 4,
    });
  });

  it('a dialpad number gets no outcome dialog; a failed call is reported', async () => {
    const t = setup({
      'POST /calls/click2call': { status: 400, body: { error: 'number is on the Do Not Call list' } },
    });
    await t.controller.callLead(null, '9840000000');
    expect(t.state().message).toEqual({ text: 'Call failed: number is on the Do Not Call list', error: true });
    // The next ring is NOT treated as our own leg any more.
    const s = t.ua.ring(new FakeSession('9840000000'));
    expect(s.answered).toBeNull();
  });

  it('refuses to start a second call', async () => {
    const t = setup({ 'GET /agent/call-policy': { body: { autoAnswer: false } } });
    t.ua.ring(new FakeSession('1001'));
    await t.controller.callLead(LEAD, LEAD.phone);
    expect(t.calls.some((c) => c.key === 'POST /calls/click2call')).toBe(false);
    expect(t.state().message?.error).toBe(true);
  });
});

describe('queue / dialer calls', () => {
  it('auto-answer campaign: answers, pops the lead, outcome at the end', async () => {
    const t = setup({
      'GET /agent/call-policy': { body: { autoAnswer: true } },
      'GET /agent/active-call': { body: ACTIVE },
    });
    const s = t.ua.ring(new FakeSession('9876543210', 'Meena'));
    await settle();
    expect(s.answered).not.toBeNull();
    s.up();
    await settle();
    expect(t.state().call).toMatchObject({ kind: 'Dialer call', callId: 55, number: '9876543210' });
    expect(t.state().workspace).toMatchObject({ callId: 55, contextText: 'Meena (9876543210)' });
    expect(t.state().workspace.lead).toMatchObject({ id: 9, custom_data: { amount: 5000 } });
    s.remoteHangup();
    expect(t.state().outcomeFor?.id).toBe(9);
  });

  it('without auto-answer: popup, then Accept answers', async () => {
    const t = setup({
      'GET /agent/call-policy': { body: { autoAnswer: false } },
      'GET /agent/active-call': { body: null },
    });
    const s = t.ua.ring(new FakeSession('9876543210', 'Meena'));
    await settle();
    expect(s.answered).toBeNull();
    expect(t.state().incoming).toEqual({ number: '9876543210', name: 'Meena' });
    t.controller.accept();
    expect(s.answered).not.toBeNull();
    expect(t.state().incoming).toBeNull();
  });

  it('caller hangs up while ringing: popup closes, no outcome', async () => {
    const t = setup({ 'GET /agent/call-policy': { body: { autoAnswer: false } } });
    const s = t.ua.ring(new FakeSession('1001'));
    await settle();
    s.remoteHangup();
    expect(t.state().incoming).toBeNull();
    expect(t.state().outcomeFor).toBeNull();
  });

  it("a colleague's consult is an offer until they complete the transfer", async () => {
    let owner = false;
    const t = setup({
      'GET /agent/call-policy': { body: { autoAnswer: true } },
      'GET /agent/active-call': () => ({ body: { ...ACTIVE, owner, from_dialer: false } }),
    });
    const s = t.ua.ring(new FakeSession('Transfer'));
    await settle();
    s.up();
    await settle();
    expect(t.state().call?.kind).toBe('Transfer offered by a colleague');
    owner = true;
    await settle();
    expect(t.state().call?.kind).toBe('Transferred call');
    s.remoteHangup();
    expect(t.state().outcomeFor?.id).toBe(9);
  });
});

describe('status and queue', () => {
  it('first Available asks for a queue, then posts it', async () => {
    const t = setup({ 'POST /agent/status': { body: { status: 'ok' } } }, { queue: null });
    await t.controller.setStatus('available');
    expect(t.state().queuePickerOpen).toBe(true);
    expect(t.calls.some((c) => c.key === 'POST /agent/status')).toBe(false);
    await t.controller.selectQueue({ id: 5, name: 'Sales' });
    expect(t.state()).toMatchObject({ queuePickerOpen: false, queue: { id: 5, name: 'Sales' } });
    expect(t.calls.find((c) => c.key === 'POST /agent/status')?.body).toEqual({
      status: 'available',
      reason: null,
      queueId: 5,
    });
  });

  it('a queue removed from the team: says why and asks again', async () => {
    const t = setup({
      'POST /agent/status': { status: 403, body: { error: "this queue is not in any of your teams' campaigns" } },
    });
    await t.controller.setStatus('available');
    expect(t.state()).toMatchObject({ queuePickerOpen: true, queue: null });
    expect(t.state().message?.text).toMatch(/not in any of your teams/);
  });

  it('break sends the reason', async () => {
    const t = setup({ 'POST /agent/status': { body: { status: 'ok' } } });
    await t.controller.setStatus('break', 'Lunch');
    expect(t.calls.find((c) => c.key === 'POST /agent/status')?.body).toEqual({
      status: 'break',
      reason: 'Lunch',
      queueId: 4,
    });
  });
});

describe('preview mode', () => {
  const NEXT = {
    id: 3,
    name: 'Kumar',
    phone: '9000000003',
    status: 'new',
    is_callback: false,
    callback_at: null,
    callback_note: null,
  };

  it('claims the next lead when the agent is free, and Dial calls it', async () => {
    const t = setup({
      'GET /agent/preview': { body: { enabled: true, blocker: null, autodialSec: 0, lead: null } },
      'POST /agent/preview/next': { body: { lead: NEXT } },
      'POST /calls/click2call': { status: 202, body: { callId: 60 } },
    });
    await t.controller.onStats({ currentStatus: 'available' } as never);
    expect(t.state().preview.lead).toEqual(NEXT);
    await t.controller.previewDial();
    expect(t.calls.find((c) => c.key === 'POST /calls/click2call')?.body).toEqual({
      toNumber: '9000000003',
      leadId: 3,
    });
  });

  it('does not claim a lead on break', async () => {
    const t = setup({ 'GET /agent/preview': { body: { enabled: true, lead: null } } });
    await t.controller.onStats({ currentStatus: 'break' } as never);
    expect(t.calls.some((c) => c.key === 'POST /agent/preview/next')).toBe(false);
  });
});
