import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';

// One row of GET /admin/callbacks (pending first, then by time; max 300).
export type Callback = {
  id: number;
  callback_at: string;
  status: 'pending' | 'done' | 'cancelled' | string;
  note: string | null;
  name: string | null;
  phone: string;
  campaign_name: string | null;
  assigned_to: string | null;
  created_by_name: string;
};

export const callbackKeys = { all: ['admin', 'callbacks'] as const };

export function useCallbacks() {
  return useQuery({ queryKey: callbackKeys.all, queryFn: () => get<Callback[]>('/admin/callbacks') });
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
