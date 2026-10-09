import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '@/lib/api';
import type { Paged } from '@/components/common';

export type DncNumber = {
  id: number;
  phone: string;
  source: string;
  created_at: string;
  created_by_name: string | null;
};

/** GET /admin/dnc: `all` = every number on the list; `total` = how many match `q` (paged, newest first). */
export type DncList = Paged<DncNumber> & { all: number };
export type DncAddResult = { added: number; existing: number; invalid: number };

export const DNC_PAGE_SIZE = 50;

export const dncKeys = {
  all: ['admin', 'dnc'] as const,
  list: (q: string, page: number) => ['admin', 'dnc', q, page] as const,
};

/** Query string in a fixed key order, empty values left out (so the same search always gives the same URL). */
function query(params: [string, string | number][]) {
  const s = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') s.set(k, String(v));
  return s.toString();
}

export const dncPath = (q: string, page: number) =>
  '/admin/dnc?' +
  query([
    ['q', q],
    ['page', page],
    ['pageSize', DNC_PAGE_SIZE],
  ]);

export function useDnc(q: string, page: number) {
  return useQuery({
    queryKey: dncKeys.list(q, page),
    queryFn: () => get<DncList>(dncPath(q, page)),
    // Keep the table on screen while the next search or page loads.
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
