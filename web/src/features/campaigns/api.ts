import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// One row of GET /admin/campaigns (campaigns.* + joined names).
// MySQL DECIMAL columns arrive as strings, TIME as "HH:MM:SS".
export type Campaign = {
  id: number;
  name: string;
  status: 'active' | 'inactive' | string;
  created_at: string;
  queue_id: number | null;
  queue_name: string | null;
  ring_strategy: string | null;
  wait_timeout: number | null;
  outbound_caller_id: string | null;
  auto_answer: 0 | 1;
  form_id: number | null;
  form_name: string | null;
  dial_mode: 'manual' | 'preview' | 'progressive' | 'predictive';
  dial_ratio: string;
  max_dial_ratio: string;
  target_abandon_pct: string;
  ring_timeout_sec: number;
  max_attempts: number;
  max_channels: number;
  amd_enabled: 0 | 1;
  preview_autodial_sec: number | null;
  wrapup_sec: number;
  abandon_wait_sec: number;
  call_window_start: string;
  call_window_end: string;
  timezone: string;
  dialer_state: 'stopped' | 'running' | 'paused' | string;
};

export const campaignKeys = {
  all: ['admin', 'campaigns'] as const,
};

/** All campaigns; also used by other screens for "pick a campaign" lists. */
export function useCampaigns() {
  return useQuery({ queryKey: campaignKeys.all, queryFn: () => get<Campaign[]>('/admin/campaigns') });
}
