import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import type { Paged } from '@/components/common';

// One row of GET /admin/callbacks (pending first, then by time).
export type Callback = {
  id: number;
  callback_at: string;
  status: 'pending' | 'done' | 'cancelled' | string;
  note: string | null;
  campaign_id: number | null;
  name: string | null;
  phone: string;
  campaign_name: string | null;
  assigned_to: string | null;
  created_by_name: string;
};

export type StatusFilter = '' | 'pending' | 'overdue' | 'done' | 'cancelled';

/** Server-side filters; '' = no filter. `q` matches the lead's name or number. */
export type CallbackFilters = { status: StatusFilter; campaignId: string; q: string };

export const NO_CALLBACK_FILTERS: CallbackFilters = { status: '', campaignId: '', q: '' };

export const CALLBACK_PAGE_SIZE = 50;

export const callbackKeys = {
  all: ['admin', 'callbacks'] as const,
  list: (f: CallbackFilters, page: number) => ['admin', 'callbacks', f, page] as const,
};

/** Query string in a fixed key order, empty values left out (so the same filters always give the same URL). */
function query(params: [string, string | number][]) {
  const s = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') s.set(k, String(v));
  return s.toString();
}

export const callbacksPath = (f: CallbackFilters, page: number) =>
  '/admin/callbacks?' +
  query([
    ['status', f.status],
    ['campaignId', f.campaignId],
    ['q', f.q],
    ['page', page],
    ['pageSize', CALLBACK_PAGE_SIZE],
  ]);

export function useCallbacks(f: CallbackFilters, page: number) {
  return useQuery({
    queryKey: callbackKeys.list(f, page),
    queryFn: () => get<Paged<Callback>>(callbacksPath(f, page)),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

/** Only pending callbacks can be cancelled; the server answers 404 otherwise. */
export function useCancelCallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => post(`/admin/callbacks/${id}/cancel`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: callbackKeys.all }),
  });
}
