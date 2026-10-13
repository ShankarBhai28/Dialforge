// Only one browser tab works as the agent screen. Two tabs of the same
// browser share one login, and each would register the same phone line:
// Asterisk keeps only the newest registration, so they would knock each
// other off and calls would ring in the wrong tab. A new tab asks the
// others (BroadcastChannel) whether one is already working; if so it waits
// with a "Use here" button, which moves the work to it (the other tab then
// waits and disconnects its line). Logins on another browser / computer
// are handled by the server (backend/src/services/singleLogin.js).
import { useEffect, useRef, useState } from 'react';

export type TabState = 'checking' | 'active' | 'blocked';
type Msg = { t: 'who' | 'here' | 'take'; id: string };
type Channel = {
  postMessage(m: Msg): void;
  close(): void;
  onmessage: ((e: { data: Msg }) => void) | null;
};

let enabled = true;
let makeChannel = (): Channel | null =>
  typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel('dialforge-agent') as unknown as Channel);
let checkMs = 400;
let customChannel = false;
const canCheck = () => enabled && (customChannel || typeof BroadcastChannel !== 'undefined');

/** Tests: switch off, or use an in-memory channel and a short wait. */
export function configureSingleTab(o: { enabled?: boolean; channel?: () => Channel | null; checkMs?: number }) {
  if (o.enabled !== undefined) enabled = o.enabled;
  if (o.channel) {
    makeChannel = o.channel;
    customChannel = true;
  }
  if (o.checkMs !== undefined) checkMs = o.checkMs;
}

export function useSingleTab() {
  const [state, setState] = useState<TabState>(() => (canCheck() ? 'checking' : 'active'));
  const take = useRef<() => void>(() => {});

  useEffect(() => {
    if (!canCheck()) return;
    const ch = makeChannel();
    if (!ch) return;
    const id = Math.random().toString(36).slice(2);
    let current: TabState = 'checking';
    const set = (s: TabState) => {
      current = s;
      setState(s);
    };
    ch.onmessage = ({ data: m }) => {
      if (!m || m.id === id) return;
      if (m.t === 'who' && current === 'active') ch.postMessage({ t: 'here', id });
      else if (m.t === 'here' && current === 'checking') set('blocked');
      else if (m.t === 'take' && current === 'active') set('blocked');
    };
    ch.postMessage({ t: 'who', id });
    const timer = setTimeout(() => {
      if (current === 'checking') set('active');
    }, checkMs);
    take.current = () => {
      ch.postMessage({ t: 'take', id });
      set('active');
    };
    return () => {
      clearTimeout(timer);
      ch.onmessage = null;
      ch.close();
    };
  }, []);

  return { state, takeOver: () => take.current() };
}
