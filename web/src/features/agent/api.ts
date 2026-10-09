// Agent screen: response types (exactly what the routes return) and data hooks.
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { Disposition } from '@/features/campaigns/api';

export type { Disposition };

export type AgentStatus = 'available' | 'break' | 'acw';

/** GET /agent/stats - polled; also the source of truth for the status pill. */
export type AgentStats = {
  loginSeconds: number;
  talkSeconds: number;
  breakSeconds: number;
  acwSeconds: number;
  handleSeconds: number;
  currentStatus: AgentStatus | 'offline' | null;
  currentReason: string | null;
  currentQueueName: string | null;
};

/** GET /queues (agent): queues of campaigns mapped to the agent's teams. */
export type AgentQueue = { id: number; name: string; campaign_name: string };

/** A lead as GET /leads returns it to an agent (leads.*), or a screen-popped/preview lead. */
export type Lead = {
  id: number;
  name: string | null;
  phone: string;
  alt_phone?: string | null;
  status: string;
  attempts?: number | null;
  list_name?: string | null;
  custom_data?: Record<string, unknown> | null;
};

export type AgentCallback = {
  id: number;
  lead_id: number;
  callback_at: string;
  note: string | null;
  user_id: number | null;
  name: string | null;
  phone: string;
  campaign_name: string | null;
};

export type FormFieldType =
  'text' | 'textarea' | 'number' | 'email' | 'phone' | 'date' | 'dropdown' | 'radio' | 'checkbox';
export type AgentFormField = {
  id: number;
  field_key: string;
  label: string;
  field_type: FormFieldType;
  options: string[] | null;
  is_required: 0 | 1;
};
export type AgentForm = { id: number; name: string; fields: AgentFormField[] };

export type CallRow = {
  id: number;
  direction: string;
  to_number: string;
  start_time: string;
  answer_time: string | null;
  end_time: string | null;
  disposition: string | null;
};

export type PreviewLead = Lead & {
  callback_at: string | null;
  callback_note: string | null;
  is_callback: boolean;
};
export type PreviewState = {
  enabled: boolean;
  blocker?: string | null;
  autodialSec?: number;
  lead?: PreviewLead | null;
};

/** GET /agent/active-call - the lead call the agent is on (dialer, transfer). */
export type ActiveCall = {
  call_id: number;
  lead_id: number;
  name: string | null;
  phone: string;
  alt_phone: string | null;
  status: string;
  attempts: number;
  custom_data: Record<string, unknown> | null;
  list_name: string | null;
  /** false while a colleague is still consulting us about it */
  owner: boolean;
  from_dialer: boolean;
};

export type TransferTargets = {
  agents: { userId: number; username: string; ext: string; status: string }[];
  queues: { id: number; name: string; campaign: string; freeAgents: number }[];
};

export type CallControlView =
  | { controlled: false }
  | {
      controlled: true;
      callId: number;
      customerOnHold: boolean;
      parties: {
        id: string;
        label: string;
        kind: string;
        state: 'ringing' | 'up';
        role: 'warm' | 'blind' | 'member';
      }[];
    };

export type CampaignInfo = {
  id: number;
  name: string;
  dialMode: string;
  wrapupSec: number;
  dialerState: string;
} | null;
export type WebrtcConfig = { sipDomain: string; wsUrl: string; iceServers: RTCIceServer[] };

export const agentKeys = {
  stats: ['agent', 'stats'] as const,
  queues: ['agent', 'queues'] as const,
  leads: ['agent', 'leads'] as const,
  callbacks: ['agent', 'callbacks'] as const,
  dispositions: ['agent', 'dispositions'] as const,
  form: ['agent', 'form'] as const,
  calls: ['agent', 'calls'] as const,
  control: ['agent', 'call-control'] as const,
};

export const useAgentStats = () =>
  useQuery({ queryKey: agentKeys.stats, queryFn: () => get<AgentStats>('/agent/stats'), refetchInterval: 5000 });
export const useAgentQueues = (enabled: boolean) =>
  useQuery({ queryKey: agentKeys.queues, queryFn: () => get<AgentQueue[]>('/queues'), enabled });
export const useAgentLeads = () => useQuery({ queryKey: agentKeys.leads, queryFn: () => get<Lead[]>('/leads') });
export const useAgentCallbacks = () =>
  useQuery({
    queryKey: agentKeys.callbacks,
    queryFn: () => get<AgentCallback[]>('/agent/callbacks'),
    refetchInterval: 30_000,
  });
export const useAgentDispositions = () =>
  useQuery({ queryKey: agentKeys.dispositions, queryFn: () => get<Disposition[]>('/agent/dispositions') });
export const useAgentForm = () =>
  useQuery({ queryKey: agentKeys.form, queryFn: () => get<AgentForm | null>('/agent/form') });
export const useAgentCalls = () => useQuery({ queryKey: agentKeys.calls, queryFn: () => get<CallRow[]>('/calls') });
/** Consult / conference state - polled only while a call is live. */
export const useCallControl = (live: boolean) =>
  useQuery({
    queryKey: agentKeys.control,
    queryFn: () => get<CallControlView>('/agent/call/control'),
    enabled: live,
    refetchInterval: live ? 1500 : false,
  });

/** Default labels for leads whose campaign has no disposition of that code. */
export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  interested: 'Interested',
  not_interested: 'Not Interested',
  callback: 'Callback',
  no_answer: 'No Answer',
  do_not_call: 'Do Not Call',
};

export function dispositionLabel(code: string, dispositions: Disposition[] | undefined) {
  if (code === 'new') return 'New';
  return dispositions?.find((d) => d.code === code)?.label ?? LEAD_STATUS_LABELS[code] ?? code;
}

export function isDncStatus(code: string, dispositions: Disposition[] | undefined) {
  return code === 'do_not_call' || !!dispositions?.find((d) => d.code === code)?.marks_dnc;
}
