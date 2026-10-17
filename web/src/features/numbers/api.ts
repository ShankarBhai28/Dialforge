import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

export type Did = {
  id: number;
  number: string;
  /** The queue (line) calls to this number wait in. */
  queue_id: number | null;
  queue_name: string | null;
  /** Campaigns that take that queue (main or one of their queues), comma separated. */
  campaign_names: string | null;
};

export const didKeys = { all: ['admin', 'dids'] as const };

export function useDids() {
  return useQuery({ queryKey: didKeys.all, queryFn: () => get<Did[]>('/admin/dids') });
}

/** Create, or re-map if the number already exists (the API upserts). */
export function useSaveDid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; number: string; queueId: number | null }) =>
      v.id ? put(`/admin/dids/${v.id}`, { queueId: v.queueId }) : post('/admin/dids', v),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: didKeys.all }),
  });
}

export function useDeleteDid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/dids/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: didKeys.all }),
  });
}
