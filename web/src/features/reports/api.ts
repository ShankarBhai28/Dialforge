import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

// GET /admin/reports: the reports + what their filters offer (the caller's scope).
export type FilterKey = 'campaign' | 'agent' | 'direction' | 'answered' | 'outcome' | 'number' | 'sla';
export type ReportFilter = FilterKey | { key: 'groupBy'; options: string[] };
export type ReportInfo = {
  key: string;
  title: string;
  description: string;
  filters: ReportFilter[];
  /** Current state, not a date range (List Penetration). */
  noRange?: boolean;
};
export type ReportCatalog = {
  timezone: string;
  reports: ReportInfo[];
  campaigns: { id: number; name: string }[];
  agents: { id: number; username: string }[];
  outcomes: { code: string; label: string }[];
};

// GET /admin/reports/:key - every report has the same shape; the screen
// formats each cell by its column type. ?format=csv = the same as a file.
export type ColumnType =
  | 'text'
  | 'id'
  | 'number'
  | 'decimal'
  | 'seconds'
  | 'percent'
  | 'date'
  | 'datetime'
  /** A call id with a recording: shown as a Play button. */
  | 'recording';
export type ReportColumn = {
  key: string;
  label: string;
  type?: ColumnType;
  /** Shown in red above / below this value (e.g. drop rate over 3 %). */
  warnAbove?: number;
  warnBelow?: number;
};
export type Cell = string | number | null;
export type ReportResult = {
  report: string;
  title: string;
  from: string;
  to: string;
  timezone: string;
  columns: ReportColumn[];
  rows: Record<string, Cell>[];
  totals: Record<string, Cell> | null;
  /** Call Detail: how many calls match vs. how many are shown. */
  meta?: { total: number; shown: number; limit: number };
  notes?: string[];
};

export function useReportCatalog() {
  return useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => get<ReportCatalog>('/admin/reports'),
    staleTime: 60_000,
  });
}

/** Report URL; empty params are left out. `csv` adds format=csv for the export link. */
export function reportUrl(key: string, params: Record<string, string>, csv = false) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  if (csv) qs.set('format', 'csv');
  const s = qs.toString();
  return `/admin/reports/${key}${s ? `?${s}` : ''}`;
}

export function useReport(key: string | null, params: Record<string, string>, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'reports', key, params],
    queryFn: () => get<ReportResult>(reportUrl(key!, params)),
    enabled: enabled && !!key,
    // Keep the old table visible while new filters load.
    placeholderData: keepPreviousData,
  });
}
