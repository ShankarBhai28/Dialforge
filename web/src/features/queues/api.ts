import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

// One row of GET /admin/queues (queues.*).
export type Queue = {
  id: number;
  name: string;
  /** Stanza name in queues.conf, derived from the name at creation. */
  asterisk_name: string | null;
  status: string;
  created_at: string;
  ring_strategy: string;
  wait_timeout: number;
  announce: 'yes' | 'no' | string;
  retry: number;
  timeout_restart: 'yes' | 'no' | string;
};

/** Body of POST/PUT /admin/queues. PUT ignores `name` (queues can't be renamed). */
export type QueueBody = {
  name?: string;
  ringStrategy: string;
  waitTimeout: number;
  announce: string;
  retry: number;
  timeoutRestart: string;
};

export const RING_STRATEGIES = [
  { value: 'ringall', label: 'Ring All' },
  { value: 'random', label: 'Random' },
  { value: 'leastrecent', label: 'Least Recent' },
  { value: 'fewestcalls', label: 'Fewest Calls' },
];

export const queueKeys = { all: ['admin', 'queues'] as const };

/** All queues; also the campaign screen's queue picker. */
export function useQueues() {
  return useQuery({ queryKey: queueKeys.all, queryFn: () => get<Queue[]>('/admin/queues') });
}

export function useSaveQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: QueueBody }) =>
      v.id ? put(`/admin/queues/${v.id}`, v.body) : post('/admin/queues', v.body),
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queueKeys.all });
      // The campaign list shows each campaign's queue name and strategy.
      qc.invalidateQueries({ queryKey: ['admin', 'campaigns'] });
    },
  });
}

export function useDeleteQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/queues/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}
