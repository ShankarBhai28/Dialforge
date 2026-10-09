import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICE_WAIT_MS, Softphone, type SoftphoneEvent } from './softphone';
import { FakeSession, fakeUAFactory } from './fakes';

const OPTS = {
  extension: '1003',
  password: 'pw',
  wsUrl: 'wss://x:8089/ws',
  sipDomain: 'x',
  iceServers: [{ urls: ['turn:1.2.3.4:3478'], username: 'u', credential: 'p' }],
};

function setup() {
  const uas = fakeUAFactory();
  const phone = new Softphone(uas.factory);
  const events: SoftphoneEvent['type'][] = [];
  phone.onEvent((e) => events.push(e.type));
  phone.connect(OPTS);
  return { phone, ua: uas.last(), events };
}

describe('Softphone', () => {
  it('registers the extension', () => {
    const { phone, ua } = setup();
    expect(phone.getSnapshot()).toMatchObject({ reg: 'connecting', extension: '1003' });
    expect(ua.started).toBe(true);
    ua.register();
    expect(phone.getSnapshot().reg).toBe('registered');
    ua.emit('registrationFailed', { cause: 'Wrong password' });
    expect(phone.getSnapshot()).toMatchObject({ reg: 'failed', regError: 'Wrong password' });
  });

  it('rings, answers with the ICE servers, goes live, ends', () => {
    const { phone, ua, events } = setup();
    const s = ua.ring(new FakeSession('9840012345', 'Ravi'));
    expect(phone.getSnapshot().call).toMatchObject({
      phase: 'ringing',
      remote: { number: '9840012345', name: 'Ravi' },
    });
    phone.answer();
    // ICE servers go to answer(): JsSIP ignores them in the UA config (the classic page's bug).
    expect(s.answered).toMatchObject({ pcConfig: { iceServers: OPTS.iceServers } });
    s.up();
    expect(phone.getSnapshot().call).toMatchObject({ phase: 'live' });
    expect(phone.getSnapshot().call?.answeredAt).toBeTypeOf('number');
    s.remoteHangup();
    expect(phone.getSnapshot().call).toBeNull();
    expect(events).toEqual(['incoming', 'answered', 'ended']);
  });

  it('mute, hold and keypad act on the live call', () => {
    const { phone, ua } = setup();
    const s = ua.ring(new FakeSession('1001'));
    phone.answer();
    s.up();
    phone.toggleMute();
    expect(phone.getSnapshot().call?.muted).toBe(true);
    phone.toggleMute();
    expect(phone.getSnapshot().call?.muted).toBe(false);
    phone.toggleHold();
    expect(phone.getSnapshot().call).toMatchObject({ onHold: true, holdPending: false });
    phone.toggleHold();
    expect(phone.getSnapshot().call?.onHold).toBe(false);
    phone.sendDTMF('5');
    expect(s.dtmf).toEqual(['5']);
  });

  it('refuses a second call while one is up, and keeps the first', () => {
    const { phone, ua } = setup();
    const first = ua.ring(new FakeSession('1001'));
    const second = ua.ring(new FakeSession('1002'));
    expect(second.terminated).toBe(true);
    expect(first.terminated).toBe(false);
    expect(phone.getSnapshot().call?.remote.number).toBe('1001');
  });

  it('shows "Unknown number" when the caller has no number', () => {
    const { phone, ua } = setup();
    const s = new FakeSession('');
    ua.ring(s);
    expect(phone.getSnapshot().call?.remote.number).toBe('Unknown number');
  });

  describe('answers without waiting for slow network routes', () => {
    afterEach(() => vi.useRealTimers());
    const cand = (type: string) => ({ type, candidate: `candidate:1 1 udp 1 1.2.3.4 5 typ ${type}` });

    it('right away once a TURN relay route is found', () => {
      const { ua } = setup();
      const s = ua.ring(new FakeSession('1001'));
      let readyCalls = 0;
      const ready = () => readyCalls++;
      s.emit('icecandidate', { candidate: cand('host'), ready });
      expect(readyCalls).toBe(0);
      s.emit('icecandidate', { candidate: cand('relay'), ready });
      expect(readyCalls).toBe(1);
    });

    it(`at most ${ICE_WAIT_MS} ms after the first route when no relay comes (e.g. TURN blocked)`, () => {
      vi.useFakeTimers();
      const { ua } = setup();
      const s = ua.ring(new FakeSession('1001'));
      let readyCalls = 0;
      const ready = () => readyCalls++;
      s.emit('icecandidate', { candidate: cand('host'), ready });
      s.emit('icecandidate', { candidate: cand('srflx'), ready });
      vi.advanceTimersByTime(ICE_WAIT_MS - 1);
      expect(readyCalls).toBe(0);
      vi.advanceTimersByTime(1);
      expect(readyCalls).toBe(1);
    });
  });
});
