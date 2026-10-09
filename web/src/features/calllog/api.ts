import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// One row of GET /calls: `SELECT * FROM calls`, newest first. Admins get every
// call, capped at CALL_LOG_LIMIT by the server; there are no filters.
export type CallRow = {
  id: number;
  tenant_id: number;
  lead_id: number | null;
  extension_id: number | null;
  direction: 'outbound' | 'inbound' | string;
  from_extension: string | null;
  to_number: string;
  ari_channel_id: string | null;
  // 'ended' / 'abandoned' once finished; null while live or never answered.
  disposition: string | null;
  start_time: string;
  answer_time: string | null;
  end_time: string | null;
  campaign_id: number | null;
  auto_answer: 0 | 1 | null;
  agent_channel: string | null;
  transfer_ext: string | null;
  channel_name: string | null;
  dial_attempt_id: number | null;
};

export const CALL_LOG_LIMIT = 100;

export const callLogKeys = { all: ['calls'] as const };

export function useCalls() {
  return useQuery({ queryKey: callLogKeys.all, queryFn: () => get<CallRow[]>('/calls') });
}
