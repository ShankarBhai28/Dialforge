import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// Shapes of /admin/reports/* (JSON). With `format=csv` the same routes
// return a CSV download of the same rows.
export type CampaignReportRow = {
  campaign_id: number;
  campaign_name: string;
  total_leads: number;
  total_calls: number;
  answered: number;
  not_answered: number;
  abandoned: number;
  answer_rate: number; // whole percent
  avg_talk_seconds: number;
};

export type AgentReportRow = {
  user_id: number;
  username: string;
  login_seconds: number;
  total_calls: number;
  answered_calls: number;
  talk_seconds: number;
  avg_talk_seconds: number;
  callbacks_set: number;
};

export type CallReportRow = {
  id: number;
  direction: string;
  from_extension: string | null;
  to_number: string;
  disposition: string | null;
  start_time: string;
  answer_time: string | null;
  end_time: string | null;
  campaign_name: string | null;
};

export type HourlyReportRow = { hour: number; total_calls: number; answered: number; answer_rate: number };

export type ReportKind = 'campaigns' | 'agents' | 'calls' | 'hourly';
export type ReportRows = {
  campaigns: CampaignReportRow;
  agents: AgentReportRow;
  calls: CallReportRow;
  hourly: HourlyReportRow;
};

/** Report URL; empty params are left out. `csv` adds format=csv for the export link. */
export function reportUrl(kind: ReportKind, params: Record<string, string>, csv = false) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  if (csv) qs.set('format', 'csv');
  const s = qs.toString();
  return `/admin/reports/${kind}${s ? `?${s}` : ''}`;
}

export function useReport<K extends ReportKind>(kind: K, params: Record<string, string>, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'reports', kind, params],
    queryFn: () => get<ReportRows[K][]>(reportUrl(kind, params)),
    enabled,
    // Keep the old table visible while a new date range loads.
    placeholderData: keepPreviousData,
  });
}
