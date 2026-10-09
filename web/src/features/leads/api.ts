import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';
import type { Paged } from '@/components/common';

// One row of GET /admin/lists (lists.* + campaign name + counts).
export type LeadList = {
  id: number;
  campaign_id: number;
  campaign_name: string | null;
  name: string;
  is_active: 0 | 1;
  priority: number;
  created_at: string;
  lead_count: number;
  dialable_count: number;
};

// One row of GET /admin/leads (leads.* + joined names, newest first).
export type Lead = {
  id: number;
  phone: string;
  alt_phone: string | null;
  name: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
  list_id: number | null;
  list_name: string | null;
  status: string;
  attempts: number;
  priority: number;
  created_at: string;
};

/** GET /admin/leads: one page, plus the statuses present (within the chosen campaign) for the status filter. */
export type LeadPage = Paged<Lead> & { statuses: string[] };

/** Server-side filters; '' = no filter. `campaignId: 'none'` = leads without a campaign. `q` = name or phone. */
export type LeadFilters = { q: string; campaignId: string; listId: string; status: string };

export const NO_LEAD_FILTERS: LeadFilters = { q: '', campaignId: '', listId: '', status: '' };

export const LEAD_PAGE_SIZE = 50;

export type Disposition = { code: string; label: string };

export type ImportResult = {
  total: number;
  imported: number;
  duplicates: number;
  dnc: number;
  invalid: number;
  /** First 50 invalid rows only; `invalid` is the full count. */
  errors: { row: number; reason: string }[];
};

export type RecycleInfo = {
  list: { id: number; name: string; maxAttempts: number };
  statuses: {
    status: string;
    label: string | null;
    total: number;
    dialable: number;
    scheduled: number;
    done: number;
    recyclable: boolean;
  }[];
  history: {
    statuses: string;
    reset_attempts: 0 | 1;
    leads_recycled: number;
    created_at: string;
    username: string | null;
  }[];
};

export type RecycleResult = { recycled: number; skippedDnc: number; skippedOnCall: number };

export const leadKeys = {
  lists: ['admin', 'lists'] as const,
  leads: ['admin', 'leads'] as const,
  leadPage: (f: LeadFilters, page: number) => ['admin', 'leads', f, page] as const,
  recycle: (listId: number) => ['admin', 'lists', listId, 'recycle'] as const,
  dispositions: (campaignId: number) => ['admin', 'campaigns', campaignId, 'dispositions'] as const,
};

// --- Lists ---

export function useLists() {
  return useQuery({ queryKey: leadKeys.lists, queryFn: () => get<LeadList[]>('/admin/lists') });
}

export type ListInput = { name: string; campaignId: number; priority: number; isActive: boolean };

export function useSaveList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ListInput & { id?: number }) =>
      id ? put(`/admin/lists/${id}`, body) : post('/admin/lists', body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: leadKeys.lists }),
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/lists/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: leadKeys.lists }),
  });
}

// --- Leads ---

/** Query string in a fixed key order, empty values left out (so the same filters always give the same URL). */
function query(params: [string, string | number][]) {
  const s = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') s.set(k, String(v));
  return s.toString();
}

export const leadsPath = (f: LeadFilters, page: number) =>
  '/admin/leads?' +
  query([
    ['q', f.q],
    ['campaignId', f.campaignId],
    ['listId', f.listId],
    ['status', f.status],
    ['page', page],
    ['pageSize', LEAD_PAGE_SIZE],
  ]);

/** Mutations invalidate `leadKeys.leads`, the prefix of every page and filter combination. */
export function useLeads(f: LeadFilters, page: number) {
  return useQuery({
    queryKey: leadKeys.leadPage(f, page),
    queryFn: () => get<LeadPage>(leadsPath(f, page)),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export type LeadInput = {
  name: string;
  phone: string;
  campaignId: number | null;
  listId: number | null;
  status: string;
};

export function useSaveLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: LeadInput & { id: number }) => put(`/admin/leads/${id}`, body),
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.leads });
      // moving a lead between lists changes the lists' counts
      qc.invalidateQueries({ queryKey: leadKeys.lists });
    },
  });
}

export function useDeleteLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/leads/${id}`),
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.leads });
      qc.invalidateQueries({ queryKey: leadKeys.lists });
    },
  });
}

/** The status choices of a campaign. Off (and empty) for unassigned leads. */
export function useDispositions(campaignId: number | null) {
  return useQuery({
    queryKey: leadKeys.dispositions(campaignId ?? 0),
    queryFn: () => get<Disposition[]>(`/admin/campaigns/${campaignId}/dispositions`),
    enabled: !!campaignId,
  });
}

// --- Import ---

export function useImportLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, file }: { listId: number; file: File }) => {
      // Field names come from the route: multer's single('file') + req.body.listId.
      const form = new FormData();
      form.append('file', file);
      form.append('listId', String(listId));
      return post<ImportResult>('/admin/leads/import', form);
    },
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.lists });
      qc.invalidateQueries({ queryKey: leadKeys.leads });
    },
  });
}

/** Download URL; the server builds the columns from the list's campaign form. */
export function templateUrl(format: 'xlsx' | 'csv', listId?: number | null) {
  const q = new URLSearchParams({ format });
  if (listId) q.set('listId', String(listId));
  return `/admin/leads/template?${q.toString()}`;
}

// --- Recycle ---

export function useRecycleInfo(listId: number) {
  return useQuery({
    queryKey: leadKeys.recycle(listId),
    queryFn: () => get<RecycleInfo>(`/admin/lists/${listId}/recycle`),
  });
}

export function useRecycleList(listId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { statuses: string[]; resetAttempts: boolean }) =>
      post<RecycleResult>(`/admin/lists/${listId}/recycle`, body),
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.recycle(listId) });
      qc.invalidateQueries({ queryKey: leadKeys.lists });
      qc.invalidateQueries({ queryKey: leadKeys.leads });
    },
  });
}
