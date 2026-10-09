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
  active_call_number: string | null;
};

export const dashboardKeys = {
  summary: ['admin', 'dashboard'] as const,
  liveAgents: ['admin', 'live-agents'] as const,
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
