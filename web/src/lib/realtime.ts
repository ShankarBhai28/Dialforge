// Live updates from the backend's /ws (see docs/ARCHITECTURE.md §8).
// One shared connection per tab; reconnects with backoff. Components
// subscribe with useRealtime(type, handler).
import { useEffect, useRef } from 'react';

export type RealtimeMessage = { type: string; data: unknown; at: number };
type Handler = (msg: RealtimeMessage) => void;

const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;

function open() {
  if (socket || !wanted) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
  };
  ws.onmessage = (ev) => {
    let msg: RealtimeMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    handlers.get(msg.type)?.forEach((h) => h(msg));
    handlers.get('*')?.forEach((h) => h(msg));
  };
  ws.onclose = () => {
    socket = null;
    if (!wanted) return;
    const delay = Math.min(30000, 1000 * 2 ** retry++);
    retryTimer = setTimeout(open, delay);
  };
}

/** Called once the user is logged in. */
export function startRealtime() {
  wanted = true;
  open();
}

/** Called on logout. */
export function stopRealtime() {
  wanted = false;
  if (retryTimer) clearTimeout(retryTimer);
  socket?.close();
  socket = null;
}

export function subscribe(type: string, handler: Handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler);
  return () => {
    handlers.get(type)?.delete(handler);
  };
}

/** Runs `handler` for every message of `type` while the component is mounted. */
export function useRealtime(type: string, handler: Handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe(type, (m) => ref.current(m)), [type]);
}
