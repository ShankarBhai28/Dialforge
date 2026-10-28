// The supervisor's monitoring line: a browser phone line on their own
// extension, used only to listen / whisper / barge (Live Agents). It lives
// outside React so it stays connected while they move between admin
// screens; the phone code (JsSIP) is downloaded only when they connect.
//
// Starting a monitor asks the server to make Asterisk call this line; calls
// whose caller name starts with "Monitor" are answered by themselves, any
// other call is refused. Mode changes are keys 4 / 5 / 6 (ChanSpy).
import { useSyncExternalStore } from 'react';
import { get, post } from '@/lib/api';
import type { Softphone, UAFactory } from '@/features/agent/softphone/softphone';
import type { WebrtcConfig } from '@/features/agent/api';

export type MonitorMode = 'listen' | 'whisper' | 'barge';
export const MODE_KEYS: Record<MonitorMode, string> = { listen: '4', whisper: '5', barge: '6' };

export type MonitorState = {
  status: 'off' | 'connecting' | 'connected' | 'failed';
  extension: string | null;
  error: string | null;
  /** The monitor in progress: ringing the line, then live. */
  session: { agentId: number; agent: string; mode: MonitorMode; live: boolean } | null;
};

const OFF: MonitorState = { status: 'off', extension: null, error: null, session: null };
let state: MonitorState = OFF;
let phone: Softphone | null = null;
let unsubscribePhone: (() => void) | null = null;
const listeners = new Set<() => void>();
let uaFactory: UAFactory | null = null; // tests inject a fake
let monitorCallId: number | null = null; // the line's call that is the monitor

function set(patch: Partial<MonitorState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

/** Tests: use a fake SIP stack instead of JsSIP. */
export function configureMonitorLine(o: { createUA: UAFactory | null }) {
  uaFactory = o.createUA;
}

export async function connectMonitorLine() {
  if (state.status === 'connecting' || state.status === 'connected') return;
  set({ status: 'connecting', error: null });
  try {
    const line = await get<WebrtcConfig & { extension: string; sipUser?: string; sipPassword: string }>(
      '/admin/monitor/line',
    );
    const { Softphone } = await import('@/features/agent/softphone/softphone');
    const createUA = uaFactory ?? (await import('@/features/agent/softphone/jssip')).createJsSipUA;
    const audio = typeof Audio === 'undefined' ? null : new Audio();
    if (audio) audio.autoplay = true;
    phone = new Softphone(createUA, audio);
    const p = phone;
    const offEvents = p.onEvent((e) => {
      if (e.type === 'incoming') {
        // Only the monitor calls the server sets up; nothing else rings here.
        if (/^Monitor/.test(e.call.remote.name)) {
          monitorCallId = e.call.id;
          p.answer();
        } else p.reject();
      } else if (e.type === 'answered') {
        if (e.call.id === monitorCallId && state.session) set({ session: { ...state.session, live: true } });
      } else if (e.type === 'ended' && e.call.id === monitorCallId) {
        monitorCallId = null;
        set({ session: null });
      }
    });
    const offSnap = p.subscribe(() => {
      const s = p.getSnapshot();
      if (s.reg === 'registered') set({ status: 'connected', extension: s.extension, error: null });
      else if (s.reg === 'failed') set({ status: 'failed', error: s.regError });
    });
    unsubscribePhone = () => {
      offEvents();
      offSnap();
    };
    p.connect({
      extension: line.extension,
      sipUser: line.sipUser,
      password: line.sipPassword,
      wsUrl: line.wsUrl,
      sipDomain: line.sipDomain,
      iceServers: line.iceServers,
    });
  } catch (err) {
    set({ status: 'failed', error: (err as Error).message });
  }
}

export function disconnectMonitorLine() {
  unsubscribePhone?.();
  unsubscribePhone = null;
  phone?.disconnect();
  phone = null;
  set(OFF);
}

/** Asks the server to start listening / whispering / barging on an agent's call. */
export async function startMonitor(agentId: number, agent: string, mode: MonitorMode) {
  const session = { agentId, agent, mode, live: false };
  set({ session, error: null });
  // If Asterisk never rings the line (call ended meanwhile...), don't wait forever.
  setTimeout(() => {
    if (state.session && state.session.agentId === agentId && !state.session.live) {
      set({ session: null, error: `The monitor of ${agent} didn't connect - their call may have ended.` });
    }
  }, 25000);
  try {
    await post(`/admin/live-agents/${agentId}/monitor`, { mode });
  } catch (err) {
    set({ session: null, error: (err as Error).message });
    throw err;
  }
}

/** Switches mode during a live monitor (keys 4 / 5 / 6). */
export function switchMode(mode: MonitorMode) {
  if (!phone || !state.session?.live) return;
  phone.sendDTMF(MODE_KEYS[mode]);
  set({ session: { ...state.session, mode } });
}

export function stopMonitor() {
  phone?.hangup();
  set({ session: null });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => state;

export function useMonitorLine() {
  return useSyncExternalStore(subscribe, snapshot);
}
