import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

export type DialMode = 'manual' | 'preview' | 'progressive' | 'predictive' | 'inbound';

// One row of GET /admin/campaigns (campaigns.* + joined names).
// MySQL DECIMAL columns arrive as strings, TIME as "HH:MM:SS".
export type Campaign = {
  id: number;
  name: string;
  status: 'active' | 'paused' | string;
  created_at: string;
  queue_id: number | null;
  queue_name: string | null;
  /** The campaign's queues besides the main one (agents may take them too). */
  extra_queue_ids?: number[];
  extra_queue_names?: string | null;
  /** 1 = agents working it take all its queues (can't untick). */
  agents_take_all_queues?: 0 | 1;
  ring_strategy: string | null;
  wait_timeout: number | null;
  outbound_caller_id: string | null;
  auto_answer: 0 | 1;
  /** Calls of this campaign are recorded (on by default). */
  record_calls?: 0 | 1;
  form_id: number | null;
  form_name: string | null;
  dial_mode: DialMode;
  dial_ratio: string;
  max_dial_ratio: string;
  target_abandon_pct: string;
  ring_timeout_sec: number;
  max_attempts: number;
  max_channels: number;
  amd_enabled: 0 | 1;
  preview_autodial_sec: number | null;
  wrapup_sec: number;
  abandon_wait_sec: number;
  number_gap_hours?: number;
  auto_dispo_sec?: number;
  auto_dispo_code?: string | null;
  call_window_start: string;
  call_window_end: string;
  timezone: string;
  dialer_state: 'stopped' | 'running' | 'paused' | string;
};

/** Body of POST/PUT /admin/campaigns (camelCase; see parseCampaignSettings). */
export type CampaignBody = {
  name: string;
  queueId: number | null;
  extraQueueIds: number[];
  takeAllQueues: boolean;
  formId: number | null;
  outboundCallerId: string | null;
  autoAnswer: boolean;
  recordCalls: boolean;
  status: string;
  dialMode: DialMode;
  dialRatio: number;
  maxDialRatio: number;
  targetAbandonPct: number;
  previewAutodialSec: number | null;
  ringTimeoutSec: number;
  maxAttempts: number;
  maxChannels: number;
  wrapupSec: number;
  abandonWaitSec: number;
  numberGapHours: number;
  autoDispoSec: number;
  autoDispoCode: string | null;
  callWindowStart: string;
  callWindowEnd: string;
  timezone: string;
  amdEnabled: boolean;
};

// One row of GET /admin/campaigns/:id/dispositions (flags are 0/1).
export type Disposition = {
  code: string;
  label: string;
  is_final: 0 | 1;
  retry_after_min: number | null;
  marks_dnc: 0 | 1;
  is_callback: 0 | 1;
  /** Counts as a success (sale / interested) in reports. */
  is_success?: 0 | 1;
};

/** One item of PUT /admin/campaigns/:id/dispositions `{ dispositions: [...] }`. */
export type DispositionInput = {
  label: string;
  code: string;
  isFinal: boolean;
  retryAfterMin: number | null;
  isCallback: boolean;
  marksDnc: boolean;
  isSuccess: boolean;
};

// One row of GET /admin/campaigns/:id/recycle-rules - every result is always present.
export type RecycleRule = {
  result: string;
  label: string;
  enabled: 0 | 1;
  delay_min: number;
  max_tries: number;
};

/** PUT /admin/campaigns/:id/recycle-rules `{ rules: { [result]: ... } }`. */
export type RecycleRulesInput = Record<string, { enabled: boolean; delayMin: number; maxTries: number }>;

// Just what the form picker needs from GET /admin/forms.
export type FormOption = { id: number; name: string; status: 'active' | 'inactive' | string };

export const campaignKeys = {
  all: ['admin', 'campaigns'] as const,
  // Not under `all`, so saving settings doesn't refetch an editor that's open.
  dispositions: (id: number) => ['admin', 'campaign-dispositions', id] as const,
  recycleRules: (id: number) => ['admin', 'campaign-recycle-rules', id] as const,
};

/** All campaigns; also used by other screens for "pick a campaign" lists. */
export function useCampaigns() {
  return useQuery({ queryKey: campaignKeys.all, queryFn: () => get<Campaign[]>('/admin/campaigns') });
}

/** Forms for the campaign's form picker (same cache entry as the Forms screen). */
export function useFormOptions() {
  return useQuery({ queryKey: ['admin', 'forms'], queryFn: () => get<FormOption[]>('/admin/forms') });
}

export function useSaveCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: CampaignBody }) =>
      v.id ? put(`/admin/campaigns/${v.id}`, v.body) : post('/admin/campaigns', v.body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignKeys.all }),
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/campaigns/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignKeys.all }),
  });
}

export function useDispositions(campaignId: number) {
  return useQuery({
    queryKey: campaignKeys.dispositions(campaignId),
    queryFn: () => get<Disposition[]>(`/admin/campaigns/${campaignId}/dispositions`),
  });
}

export function useSaveDispositions(campaignId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dispositions: DispositionInput[]) =>
      put(`/admin/campaigns/${campaignId}/dispositions`, { dispositions }),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignKeys.dispositions(campaignId) }),
  });
}

export function useRecycleRules(campaignId: number) {
  return useQuery({
    queryKey: campaignKeys.recycleRules(campaignId),
    queryFn: () => get<RecycleRule[]>(`/admin/campaigns/${campaignId}/recycle-rules`),
  });
}

export function useSaveRecycleRules(campaignId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: RecycleRulesInput) => put(`/admin/campaigns/${campaignId}/recycle-rules`, { rules }),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignKeys.recycleRules(campaignId) }),
  });
}
