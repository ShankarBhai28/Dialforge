import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '@/lib/api';

export type DncNumber = {
  id: number;
  phone: string;
  source: string;
  created_at: string;
  created_by_name: string | null;
};

/** GET /admin/dnc: `total` is the whole list; `rows` the newest 500 matching `q`. */
export type DncList = { total: number; rows: DncNumber[] };
export type DncAddResult = { added: number; existing: number; invalid: number };

export const dncKeys = {
  all: ['admin', 'dnc'] as const,
  list: (q: string) => ['admin', 'dnc', q] as const,
};

export function useDnc(q: string) {
  return useQuery({
    queryKey: dncKeys.list(q),
    queryFn: () => get<DncList>('/admin/dnc' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    // Keep the table on screen while the next search loads.
    placeholderData: keepPreviousData,
  });
}

/** `phones` is the raw textarea; the server splits on newlines/commas and normalises. */
export function useAddDnc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phones: string) => post<DncAddResult>('/admin/dnc', { phones }),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: dncKeys.all }),
  });
}

export function useRemoveDnc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/dnc/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: dncKeys.all }),
  });
}
