// The browser phone line. Wraps JsSIP (SIP over WebSocket + WebRTC) behind
// a small interface and exposes a plain snapshot for React
// (useSyncExternalStore). Knows nothing about leads or campaigns - deciding
// what a call *means* is the call controller's job.
//
// Every call reaches the agent as an INCOMING SIP call: click-to-call rings
// the agent's own line first, queue calls ring it from Asterisk's Queue().

export type RegState = 'idle' | 'connecting' | 'registered' | 'failed';

/** Longest we wait for network routes (ICE candidates) before answering. */
export const ICE_WAIT_MS = 1000;

export type CallSnapshot = {
  /** Increments per call, so listeners can tell calls apart. */
  id: number;
  /** 'ringing' = not answered yet; 'live' = media up. */
  phase: 'ringing' | 'live';
  remote: { number: string; name: string };
  answeredAt: number | null;
  onHold: boolean;
  muted: boolean;
  /** A hold/resume re-INVITE is in flight - don't send another. */
  holdPending: boolean;
};

export type SoftphoneSnapshot = {
  reg: RegState;
  regError: string | null;
  extension: string | null;
  call: CallSnapshot | null;
};

export type SoftphoneEvent =
  | { type: 'incoming'; call: CallSnapshot }
  | { type: 'answered'; call: CallSnapshot }
  | { type: 'ended'; call: CallSnapshot };

// The parts of JsSIP's RTCSession / UA we use - small enough to fake in tests.
export interface SessionLike {
  on(event: string, fn: (data?: unknown) => void): void;
  answer(options?: object): void;
  terminate(): void;
  mute(options?: object): void;
  unmute(options?: object): void;
  hold(options?: object, done?: () => void): boolean;
  unhold(options?: object, done?: () => void): boolean;
  sendDTMF(tone: string): void;
  remote_identity?: { display_name?: string; uri?: { user?: string } };
  connection?: RTCPeerConnection | null;
}
export interface UALike {
  on(event: string, fn: (data: never) => void): void;
  start(): void;
  stop(): void;
}
export type ConnectOptions = {
  extension: string;
  password: string;
  wsUrl: string;
  sipDomain: string;
  iceServers: RTCIceServer[];
};
export type UAFactory = (o: ConnectOptions) => UALike;

/** Who is calling, as Asterisk presents it (dialer calls carry the lead's number and name). */
export function remoteOf(session: SessionLike) {
  const id = session.remote_identity ?? {};
  const number = id.uri?.user || 'Unknown number';
  const name = id.display_name && id.display_name !== number ? id.display_name : '';
  return { number, name };
}

export class Softphone {
  private snapshot: SoftphoneSnapshot = { reg: 'idle', regError: null, extension: null, call: null };
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: SoftphoneEvent) => void>();
  private ua: UALike | null = null;
  private session: SessionLike | null = null;
  private iceServers: RTCIceServer[] = [];
  private callSeq = 0;
  private readonly createUA: UAFactory;
  private readonly audio: HTMLAudioElement | null;

  constructor(createUA: UAFactory, audio: HTMLAudioElement | null = null) {
    this.createUA = createUA;
    this.audio = audio;
  }

  // --- React bindings ---
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  onEvent(fn: (e: SoftphoneEvent) => void) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private set(patch: Partial<SoftphoneSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private setCall(patch: Partial<CallSnapshot>) {
    if (this.snapshot.call) this.set({ call: { ...this.snapshot.call, ...patch } });
  }
  private emit(e: SoftphoneEvent) {
    this.eventListeners.forEach((fn) => fn(e));
  }

  // --- Line ---
  connect(o: ConnectOptions) {
    this.disconnect();
    this.iceServers = o.iceServers;
    this.set({ reg: 'connecting', regError: null, extension: o.extension });
    const ua = this.createUA(o);
    this.ua = ua;
    ua.on('registered', () => this.ua === ua && this.set({ reg: 'registered', regError: null }));
    ua.on('registrationFailed', (e: { cause?: string }) => {
      if (this.ua === ua) this.set({ reg: 'failed', regError: e?.cause ?? 'registration failed' });
    });
    ua.on('newRTCSession', (data: { session: SessionLike; originator: string }) => {
      if (this.ua === ua) this.attach(data.session, data.originator);
    });
    ua.start();
  }

  disconnect() {
    this.session?.terminate();
    this.ua?.stop();
    this.ua = null;
    this.session = null;
    this.set({ reg: 'idle', regError: null, call: null });
  }

  private attach(session: SessionLike, originator: string) {
    // We never place calls from the browser; a second ring while busy is
    // refused so it can't replace the live call (queues use ringinuse=no,
    // so this is only a safety net).
    if (originator !== 'remote' || this.session) {
      if (originator === 'remote') session.terminate();
      return;
    }
    this.session = session;
    const call: CallSnapshot = {
      id: ++this.callSeq,
      phase: 'ringing',
      remote: remoteOf(session),
      answeredAt: null,
      onHold: false,
      muted: false,
      holdPending: false,
    };
    this.set({ call });

    const playRemote = (pc?: RTCPeerConnection | null) => {
      pc?.addEventListener('track', (e) => {
        if (this.audio) this.audio.srcObject = e.streams[0];
      });
    };
    session.on('peerconnection', (d) => playRemote((d as { peerconnection: RTCPeerConnection }).peerconnection));
    if (session.connection) playRemote(session.connection);

    // Answer fast. JsSIP sends the SDP answer only once ICE gathering has
    // *finished*; with STUN/TURN servers that can take seconds, or until an
    // unreachable server times out - long enough for Asterisk to give up on
    // the call. Send it as soon as a TURN relay route is in, or ICE_WAIT_MS
    // after the first route (direct routes come first and are usually enough:
    // Asterisk has a public address).
    let iceTimer: ReturnType<typeof setTimeout> | null = null;
    session.on('icecandidate', (d) => {
      const { candidate, ready } = d as { candidate: RTCIceCandidate; ready: () => void };
      if (candidate.type === 'relay' || / typ relay /.test(candidate.candidate)) {
        if (iceTimer) clearTimeout(iceTimer);
        ready();
      } else if (!iceTimer) {
        iceTimer = setTimeout(ready, ICE_WAIT_MS);
      }
    });

    const answered = () => {
      if (this.session !== session || this.snapshot.call?.phase === 'live') return;
      this.setCall({ phase: 'live', answeredAt: Date.now() });
      this.emit({ type: 'answered', call: this.snapshot.call! });
    };
    session.on('accepted', answered);
    session.on('confirmed', answered);
    session.on('hold', () => this.session === session && this.setCall({ onHold: true }));
    session.on('unhold', () => this.session === session && this.setCall({ onHold: false }));
    session.on('muted', () => this.session === session && this.setCall({ muted: true }));
    session.on('unmuted', () => this.session === session && this.setCall({ muted: false }));
    const ended = () => {
      if (iceTimer) clearTimeout(iceTimer);
      if (this.session !== session) return;
      const last = this.snapshot.call!;
      this.session = null;
      this.set({ call: null });
      if (this.audio) this.audio.srcObject = null;
      this.emit({ type: 'ended', call: last });
    };
    session.on('ended', ended);
    session.on('failed', ended);

    this.emit({ type: 'incoming', call });
  }

  // --- Call controls ---
  answer() {
    this.session?.answer({
      mediaConstraints: { audio: true, video: false },
      // ICE servers go here (per call), not in the UA config, where JsSIP ignores them.
      pcConfig: { iceServers: this.iceServers },
    });
  }
  reject() {
    this.session?.terminate();
  }
  hangup() {
    this.session?.terminate();
  }
  toggleMute() {
    const c = this.snapshot.call;
    if (!this.session || !c) return;
    if (c.muted) this.session.unmute({ audio: true });
    else this.session.mute({ audio: true });
  }
  /** Hold makes Asterisk play music to the other side. One re-INVITE at a time. */
  toggleHold() {
    const c = this.snapshot.call;
    const s = this.session;
    if (!s || !c || c.holdPending) return;
    this.setCall({ holdPending: true });
    const done = () => this.session === s && this.setCall({ holdPending: false });
    const ok = c.onHold ? s.unhold({}, done) : s.hold({}, done);
    if (!ok) done(); // JsSIP refused (another renegotiation in progress)
    setTimeout(done, 5000);
  }
  sendDTMF(tone: string) {
    this.session?.sendDTMF(tone);
  }
}
