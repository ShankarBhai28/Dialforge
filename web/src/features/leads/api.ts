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
  /** The campaign form's values known before the call (import or edit). */
  custom_data: Record<string, unknown> | null;
  created_at: string;
  /** Given to one agent: only they see it, the dialer leaves it to them. */
  assigned_user_id: number | null;
  assigned_to: string | null;
};

/** GET /admin/leads/:id - one lead in full (a deleted one too, read-only). */
export type LeadDetail = Lead & {
  is_final: 0 | 1;
  next_call_at: string | null;
  last_attempt_at: string | null;
  callback_at: string | null;
  list_active: 0 | 1 | null;
  updated_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
  on_dnc: boolean;
  /** The campaign form's fields, for labels of custom_data. */
  form_fields: { key: string; label: string }[];
};

/** active false = deactivated but still holding leads (filter only, not offered to give leads to). */
export type LeadAgent = { id: number; username: string; active: boolean };

export type BulkAction = 'status' | 'move' | 'assign' | 'reset' | 'dnc' | 'delete';
/** Ticked leads (ids), or every lead matching the filters (all). */
export type BulkTarget = { ids: number[] } | { all: true; filters: LeadFilters };
export type BulkInput = BulkTarget & {
  action: BulkAction;
  status?: string;
  listId?: number;
  userId?: number | null;
  resetAttempts?: boolean;
};
export type BulkResult = { action: BulkAction; changed: number; skipped: number; notes: string[] };

/** GET /admin/leads: one page, plus the statuses present (within the chosen campaign) for the status filter. */
export type LeadPage = Paged<Lead> & { statuses: string[] };

/** Server-side filters; '' = no filter. `campaignId: 'none'` = leads without a campaign. `q` = name or phone. */
export type LeadFilters = {
  q: string;
  campaignId: string;
  listId: string;
  status: string;
  /** An agent's id, or 'none' = not given to anyone. */
  assignedTo: string;
};

export const NO_LEAD_FILTERS: LeadFilters = { q: '', campaignId: '', listId: '', status: '', assignedTo: '' };

export const LEAD_PAGE_SIZE = 50;

export type Disposition = { code: string; label: string };

/** Duplicate check of a lead upload (backend/src/services/leadDedupe.js). */
export type DuplicateCheck = 'none' | 'file' | 'list' | 'campaign' | 'all';

export type ImportResult = {
  total: number;
  /** Saved (0 when only checked). */
  imported: number;
  /** Rows that pass every check (= imported, or would be on a check). */
  wouldImport?: number;
  /** "Update existing leads": leads changed (0 on a check). */
  updated?: number;
  /** Rows that match a lead of this campaign (would be updated on a check). */
  wouldUpdate?: number;
  /** Matched rows that had nothing new. */
  unchanged?: number;
  /** New leads whose number is already a lead of this campaign (a looser check allowed it). */
  copies?: number;
  onDuplicate?: 'skip' | 'update';
  /** inFile + existing */
  duplicates: number;
  /** Repeated inside the file. */
  inFile?: number;
  /** Already in the database (list / campaign / everywhere, by the check). */
  existing?: number;
  dnc: number;
  invalid: number;
  scope?: DuplicateCheck;
  /** Only checked - nothing saved. */
  dryRun?: boolean;
  /** The skipped rows as Excel: GET /admin/leads/import-report/:id (1 hour). */
  reportId?: string | null;
  /** First 50 invalid rows only; `invalid` is the full count. */
  errors: { row: number; reason: string }[];
};

export const importReportUrl = (id: string) => `/admin/leads/import-report/${id}`;

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
    /** A success outcome (sale, interested): recycling calls those customers again. */
    success?: boolean;
  }[];
  history: {
    statuses: string;
    reset_attempts: 0 | 1;
    leads_recycled: number;
    created_at: string;
    username: string | null;
  }[];
};

export type RecycleResult = {
  recycled: number;
  skippedDnc: number;
  skippedOnCall: number;
  /** Kept for their callback time. */
  skippedCallback?: number;
  /** Out of attempts and "Reset attempt count" not ticked. */
  skippedUsedUp?: number;
  /** The skips in words (services/recycle.js). */
  notes?: string[];
};

export const leadKeys = {
  lists: ['admin', 'lists'] as const,
  leads: ['admin', 'leads'] as const,
  leadPage: (f: LeadFilters, page: number) => ['admin', 'leads', f, page] as const,
  detail: (id: number) => ['admin', 'leads', 'one', id] as const,
  agents: ['admin', 'leads', 'agents'] as const,
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

// --- Deleted lists + Restore (backend/src/services/restore.js) ---
export type DeletedList = {
  id: number;
  name: string;
  campaignId: number;
  campaign: string | null;
  /** The campaign is deleted too: can't be restored. */
  campaignDeleted: boolean;
  deletedAt: string;
  deletedBy: string | null;
  /** Leads deleted together with the list. */
  leads: number;
  /** Of those, numbers that are an active lead in the campaign again (they stay deleted). */
  clashes: number;
};

export function useDeletedLists(enabled: boolean) {
  return useQuery({
    queryKey: [...leadKeys.lists, 'deleted'],
    queryFn: () => get<DeletedList[]>('/admin/lists/deleted'),
    enabled,
  });
}

export function useRestoreList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      post<{ status: string; restored: number; skipped: number; notes: string[] }>(`/admin/lists/${id}/restore`),
    meta: { errorInline: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: leadKeys.lists }); // the lists and the deleted ones
      void qc.invalidateQueries({ queryKey: leadKeys.leads });
    },
  });
}

// --- Leads ---

/** Query string in a fixed key order, empty values left out (so the same filters always give the same URL). */
function query(params: [string, string | number][]) {
  const s = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') s.set(k, String(v));
  return s.toString();
}

const filterParams = (f: LeadFilters): [string, string][] => [
  ['q', f.q],
  ['campaignId', f.campaignId],
  ['listId', f.listId],
  ['status', f.status],
  ['assignedTo', f.assignedTo],
];

export const leadsPath = (f: LeadFilters, page: number) =>
  '/admin/leads?' + query([...filterParams(f), ['page', page], ['pageSize', LEAD_PAGE_SIZE]]);

/** Leads -> Export: a plain link, the server sends the Excel file (same filters as the table). */
export const leadsExportUrl = (f: LeadFilters) => '/admin/leads/export?' + query(filterParams(f));

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
  /** '' clears it. */
  altPhone: string;
  /** -100..100; higher is dialled earlier. */
  priority: number;
  /** The campaign form's fields ('' / [] clears one). Left out = unchanged. */
  customData?: Record<string, string | string[]>;
  campaignId: number | null;
  listId: number | null;
  status: string;
  /** Left out = unchanged; null = shared with the campaign again. */
  assignedUserId?: number | null;
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

export function useLeadDetail(id: number) {
  return useQuery({ queryKey: leadKeys.detail(id), queryFn: () => get<LeadDetail>(`/admin/leads/${id}`) });
}

/** Agents for Leads: active ones, plus inactive ones still holding leads (own teams' for a team role). */
export function useLeadAgents(enabled = true) {
  return useQuery({ queryKey: leadKeys.agents, queryFn: () => get<LeadAgent[]>('/admin/leads/agents'), enabled });
}

export function useBulkLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkInput) => post<BulkResult>('/admin/leads/bulk', body),
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
    mutationFn: ({
      listId,
      file,
      duplicateCheck = 'campaign',
      dryRun = false,
      onDuplicate = 'skip',
      moveToList = false,
    }: {
      listId: number;
      file: File;
      duplicateCheck?: DuplicateCheck;
      dryRun?: boolean;
      /** 'update': a number already a lead of this campaign updates that lead (filled cells only). */
      onDuplicate?: 'skip' | 'update';
      /** With 'update': also move those leads into this list. */
      moveToList?: boolean;
    }) => {
      // Field names come from the route: multer's single('file') + req.body.
      const form = new FormData();
      form.append('file', file);
      form.append('listId', String(listId));
      form.append('duplicateCheck', duplicateCheck);
      if (dryRun) form.append('dryRun', '1');
      form.append('onDuplicate', onDuplicate);
      if (moveToList) form.append('moveToList', '1');
      return post<ImportResult>('/admin/leads/import', form);
    },
    meta: { errorInline: true },
    onSuccess: (r) => {
      if (r.dryRun) return; // nothing saved
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
