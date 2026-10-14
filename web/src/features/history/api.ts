import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// GET /agent/leads/:id/history and /admin/leads/:id/history
// (backend/src/services/leadHistory.js). Times are ISO (UTC).
type Base = {
  at: string;
  agent?: string | null;
  /** From an earlier, deleted lead with the same number (history kept across a re-add). */
  earlierLead?: { id: number; name: string | null } | null;
};
export type HistoryItem =
  | (Base & {
      type: 'call';
      callId: number;
      direction: 'inbound' | 'outbound';
      extension: string | null;
      result: string;
      talkSeconds: number | null;
      outcome: string | null;
      note: string | null;
      callbackAt: string | null;
      transferred: boolean;
      recorded: boolean;
      /** Admin side, with the right to play recordings. */
      recordingUrl?: string;
    })
  | (Base & { type: 'outcome'; outcome: string; note: string | null; callbackAt: string | null })
  | (Base & { type: 'form'; form: string; callId: number | null; answers: { label: string; value: string }[] })
  | (Base & { type: 'callback'; due: string; status: string; owner: string | null; note: string | null })
  | (Base & { type: 'edit'; changes: { field: string; from: unknown; to: unknown }[] })
  | (Base & { type: 'created'; campaign: string | null; list: string | null })
  | (Base & { type: 'deleted' });

export type LeadHistory = {
  lead: {
    id: number;
    name: string | null;
    phone: string;
    altPhone: string | null;
    status: string;
    attempts: number;
    final: boolean;
    nextCallAt: string | null;
    campaign: string | null;
    list: string | null;
    createdAt: string;
    /** Deleted (e.g. with its list): history only. */
    deletedAt?: string | null;
    customData: Record<string, unknown> | null;
  };
  summary: {
    calls: number;
    answered: number;
    talkSeconds: number;
    lastCallAt: string | null;
    lastSpokeWith: string | null;
    lastSpokeAt: string | null;
    lastOutcome: string | null;
    agents: string[];
    pendingCallback: { due: string } | null;
  };
  latestForm: { form: string; at: string; agent: string | null; answers: { label: string; value: string }[] } | null;
  /** The last answers saved with each form (by form id; raw values by field key). */
  formData?: Record<string, { data: Record<string, unknown>; at: string; agent: string | null }>;
  timeline: HistoryItem[];
};

export type HistorySide = 'agent' | 'admin';

export const historyKey = (side: HistorySide, leadId: number) =>
  side === 'agent' ? (['agent', 'lead-history', leadId] as const) : (['admin', 'lead-history', leadId] as const);

export function useLeadHistory(side: HistorySide, leadId: number | null) {
  return useQuery({
    queryKey: historyKey(side, leadId ?? 0),
    queryFn: () => get<LeadHistory>(`/${side}/leads/${leadId}/history`),
    enabled: !!leadId,
  });
}
