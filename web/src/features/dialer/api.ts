import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';

// GET /admin/dialer. mysql2 returns DECIMAL and SUM() as strings, COUNT() and
// INT columns as numbers. The dialer_status columns are null until the
// engine has ticked for that campaign (LEFT JOIN).
export type DialerEngine = {
  alive: boolean;
  // Missing entirely when the engine has never written its heartbeat row.
  engine_id?: string | null;
  last_tick_at?: string | null;
  age_sec?: number | null;
};

export type DialerToday = {
  campaign_id: number;
  attempts: number;
  answered: string;
  connected: string;
  abandoned: string;
  not_reached: string;
  machine: string;
};

export type DialerState = 'stopped' | 'running' | 'paused';

export type DialerCampaign = {
  id: number;
  name: string;
  status: string;
  dial_mode: 'manual' | 'preview' | 'progressive' | 'predictive' | string;
  dial_ratio: string;
  max_dial_ratio: string;
  dialer_state: DialerState | string;
  dialer_state_changed_at: string | null;
  changed_by: string | null;
  queue_name: string | null;
  hopper_ready: number | null;
  hopper_locked: number | null;
  idle_agents: number | null;
  would_dial: number | null;
  in_flight: number | null;
  active_calls: number | null;
  note: string | null;
  last_tick_at: string | null;
  current_ratio: string | null;
  answer_rate: string | null;
  abandon_pct: string | null;
  ratio_adjust: string | null;
  pacing_note: string | null;
  today: DialerToday | null;
};

export type DialerOverview = { engine: DialerEngine; campaigns: DialerCampaign[] };

// GET /admin/campaigns/:id/hopper: dial_hopper.* + lead name, list name and
// the agent a callback is reserved for. Capped at 200 rows by the server.
export type HopperRow = {
  id: number;
  campaign_id: number;
  lead_id: number;
  list_id: number | null;
  phone: string;
  is_callback: 0 | 1;
  list_priority: number;
  lead_priority: number;
  attempts: number;
  reserved_user_id: number | null;
  status: 'ready' | 'locked' | string;
  locked_at: string | null;
  locked_by: string | null;
  inserted_at: string;
  name: string | null;
  list_name: string | null;
  reserved_for: string | null;
};

export const HOPPER_LIMIT = 200;

export type DialerAction = 'start' | 'pause' | 'stop';

export const dialerKeys = {
  overview: ['admin', 'dialer'] as const,
  hopper: (id: number) => ['admin', 'dialer', 'hopper', id] as const,
  live: (id: number) => ['admin', 'dialer', 'live', id] as const,
};

// GET /admin/campaigns/:id/dialer-live (backend/src/services/dialerLive.js).
export type LiveState = 'dialing' | 'ringing' | 'waiting' | 'connected';
export type LiveCall = {
  id: number;
  leadId: number | null;
  leadName: string | null;
  phone: string;
  state: LiveState;
  /** When the current state began (ISO). */
  since: string;
  startedAt: string;
  agent: string | null;
  callId: number | null;
};
export type FinishedCall = {
  id: number;
  leadId: number | null;
  leadName: string | null;
  phone: string;
  result: string | null;
  resultLabel: string;
  endedAt: string;
  agent: string | null;
  talkSeconds: number | null;
};
export type DialerLive = { live: LiveCall[]; counts: Record<LiveState, number>; finished: FinishedCall[] };

/** Live calls of one campaign: every 2 s while the panel is open (plus on every dialer.status push). */
export function useDialerLive(campaignId: number | null) {
  return useQuery({
    queryKey: dialerKeys.live(campaignId ?? 0),
    queryFn: () => get<DialerLive>(`/admin/campaigns/${campaignId}/dialer-live`),
    enabled: campaignId !== null,
    refetchInterval: 2000,
  });
}

export function useHangup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (attemptId: number) =>
      post<{ status: string; was: LiveState }>(`/admin/dialer/attempts/${attemptId}/hangup`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'dialer', 'live'] }),
  });
}

// The backend pushes `dialer.status` (the same payload as GET /admin/dialer)
// whenever the screen would change - see backend/src/realtime/dialerFeed.js.
// The interval is only the safety net for a dropped connection.
const SAFETY_POLL_MS = 15000;

export function useDialer() {
  const qc = useQueryClient();
  useRealtime('dialer.status', (msg) => {
    qc.setQueryData(dialerKeys.overview, msg.data as DialerOverview);
    // Hopper counts moved too; refresh an open hopper (not the overview just set).
    void qc.invalidateQueries({ queryKey: ['admin', 'dialer', 'hopper'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'dialer', 'live'] });
  });
  return useQuery({
    queryKey: dialerKeys.overview,
    queryFn: () => get<DialerOverview>('/admin/dialer'),
    refetchInterval: SAFETY_POLL_MS,
  });
}

export function useHopper(campaignId: number | null) {
  return useQuery({
    queryKey: dialerKeys.hopper(campaignId ?? 0),
    queryFn: () => get<HopperRow[]>(`/admin/campaigns/${campaignId}/hopper`),
    enabled: campaignId !== null,
    refetchInterval: SAFETY_POLL_MS,
  });
}

export function useDialerAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; action: DialerAction }) =>
      post<{ status: string; dialerState: DialerState }>(`/admin/campaigns/${v.id}/dialer`, { action: v.action }),
    // The page shows the reason (e.g. "campaign needs a queue") next to the action.
    meta: { errorInline: true },
    // Invalidating the 'dialer' prefix also refreshes an open hopper (stop empties it).
    onSuccess: () => qc.invalidateQueries({ queryKey: dialerKeys.overview }),
  });
}
