// Test doubles for JsSIP: a UA and sessions driven by the test. Only used by tests.
import type { ConnectOptions, SessionLike, UAFactory, UALike } from './softphone';

type Handler = (data?: unknown) => void;

class Emitter {
  private handlers = new Map<string, Handler[]>();
  on(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  emit(event: string, data?: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(data);
  }
}

export class FakeSession extends Emitter implements SessionLike {
  answered: object | null = null;
  terminated = false;
  dtmf: string[] = [];
  remote_identity: { display_name?: string; uri: { user: string } };
  connection = null;
  constructor(number: string, name?: string) {
    super();
    this.remote_identity = { display_name: name, uri: { user: number } };
  }
  answer(options?: object) {
    this.answered = options ?? {};
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('ended');
  }
  mute() {
    this.emit('muted');
  }
  unmute() {
    this.emit('unmuted');
  }
  hold(_o?: object, done?: () => void) {
    this.emit('hold');
    done?.();
    return true;
  }
  unhold(_o?: object, done?: () => void) {
    this.emit('unhold');
    done?.();
    return true;
  }
  sendDTMF(tone: string) {
    this.dtmf.push(tone);
  }
  /** Media up (what JsSIP emits after answer). */
  up() {
    this.emit('accepted');
    this.emit('confirmed');
  }
  /** The other side hung up. */
  remoteHangup() {
    this.terminated = true;
    this.emit('ended');
  }
}

export class FakeUA extends Emitter {
  started = false;
  stopped = false;
  constructor(readonly options: ConnectOptions) {
    super();
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  register() {
    this.emit('registered');
  }
  ring(session: FakeSession) {
    this.emit('newRTCSession', { session, originator: 'remote' });
    return session;
  }
}

/** A UA factory that remembers every UA it made. */
export function fakeUAFactory() {
  const made: FakeUA[] = [];
  const factory: UAFactory = (o) => {
    const ua = new FakeUA(o);
    made.push(ua);
    return ua as unknown as UALike;
  };
  return { factory, made, last: () => made[made.length - 1] };
}
