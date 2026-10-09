import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { Paged } from '@/components/common';

// One row of GET /admin/calls: `calls.*` plus the joined campaign and lead
// names, newest first.
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
  campaign_name: string | null;
  lead_name: string | null;
};

/** Server-side filters; '' = no filter. `disposition: 'none'` = not answered. `from`/`to` are YYYY-MM-DD, inclusive. */
export type CallFilters = { q: string; direction: string; disposition: string; from: string; to: string };

export const NO_CALL_FILTERS: CallFilters = { q: '', direction: '', disposition: '', from: '', to: '' };

export const CALL_PAGE_SIZE = 50;

export const callLogKeys = {
  all: ['admin', 'calls'] as const,
  list: (f: CallFilters, page: number) => ['admin', 'calls', f, page] as const,
};

/** Query string in a fixed key order, empty values left out (so the same filters always give the same URL). */
function query(params: [string, string | number][]) {
  const s = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') s.set(k, String(v));
  return s.toString();
}

export const callsPath = (f: CallFilters, page: number) =>
  '/admin/calls?' +
  query([
    ['q', f.q],
    ['direction', f.direction],
    ['disposition', f.disposition],
    ['from', f.from],
    ['to', f.to],
    ['page', page],
    ['pageSize', CALL_PAGE_SIZE],
  ]);

export function useCalls(f: CallFilters, page: number) {
  return useQuery({
    queryKey: callLogKeys.list(f, page),
    queryFn: () => get<Paged<CallRow>>(callsPath(f, page)),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}
