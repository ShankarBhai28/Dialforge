import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

export type DashboardSummary = {
  totalAgents: number;
  availableNow: number;
  callsToday: number;
  avgHandleSeconds: number;
};

export type AgentStatus = 'available' | 'break' | 'acw' | 'offline' | null;

export type LiveAgent = {
  id: number;
  username: string;
  extension_name: string | null;
  status: AgentStatus;
  reason: string | null;
  started_at: string | null;
  queue_name: string | null;
  /** Blended: extra queues the agent also takes calls from (comma separated). */
  extra_queues?: string | null;
  active_call_number: string | null;
  // Live Agents wallboard (backend/src/services/liveFloor.js).
  campaign_name?: string | null;
  /** The campaign's wrap-up seconds (to flag a long wrap-up). */
  wrapup_sec?: number | null;
  /** The campaign's warning times; null/absent = defaults (break 10 / 15 min, wrap-up + 60 s). */
  warn?: { breakWarnMin: number; breakAlertMin: number; acwWarnSec: number } | null;
  teams?: string | null;
  /** registered | unregistered | unknown; null = not logged in. */
  line?: string | null;
  login_at?: string | null;
  call?: {
    id: number;
    number: string;
    leadName: string | null;
    kind: 'inbound' | 'outbound' | 'dialer';
    /** What the Live Agents "Call type" column shows (absent from servers before 30 Oct 2026). */
    type?: 'inbound' | 'manual' | 'predictive' | 'progressive' | 'preview' | 'callback' | 'transfer';
    startedAt: string;
    connectedAt: string | null;
  } | null;
  today?: { calls: number; connected: number; talkSeconds: number; avgHandleSeconds: number | null };
};

/** GET /admin/live-agents/summary: callers waiting for an agent now, and today's totals. */
export type FloorSummary = {
  waiting: number;
  waitingInbound: number;
  waitingDialer: number;
  longestWaitSeconds: number | null;
  today: { calls: number; connected: number; talkSeconds: number };
};

export const dashboardKeys = {
  summary: ['admin', 'dashboard'] as const,
  liveAgents: ['admin', 'live-agents'] as const,
  floor: ['admin', 'live-agents', 'summary'] as const,
};

export function useDashboardSummary() {
  return useQuery({
    queryKey: dashboardKeys.summary,
    queryFn: () => get<DashboardSummary>('/admin/dashboard'),
    refetchInterval: 30_000,
  });
}

export function useLiveAgents() {
  return useQuery({
    queryKey: dashboardKeys.liveAgents,
    queryFn: () => get<LiveAgent[]>('/admin/live-agents'),
    // Live updates refresh it instantly; this is only a safety net.
    refetchInterval: 15_000,
  });
}

export function useFloorSummary() {
  return useQuery({
    queryKey: dashboardKeys.floor,
    queryFn: () => get<FloorSummary>('/admin/live-agents/summary'),
    // Waiting callers change by the second; live updates also refresh it.
    refetchInterval: 5_000,
  });
}
