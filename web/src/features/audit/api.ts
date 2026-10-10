import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { Paged } from '@/components/common';

// One row of GET /admin/audit (table audit_log). The JSON columns arrive parsed.
export type AuditRow = {
  id: number;
  at: string;
  user_id: number | null;
  /** 'system' for automatic actions; the typed name for a failed login. */
  username: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  status: number | null;
  summary: string | null;
  request_json: Record<string, unknown> | null;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  ip: string | null;
};

export type AuditPage = Paged<AuditRow> & { actions: string[]; entities: string[] };

/** '' = no filter. `failed` = only refused / failed requests. */
export type AuditFilters = { q: string; action: string; entity: string; from: string; to: string; failed: boolean };
export const NO_AUDIT_FILTERS: AuditFilters = { q: '', action: '', entity: '', from: '', to: '', failed: false };
export const AUDIT_PAGE_SIZE = 50;

export const auditKeys = { all: ['admin', 'audit'] as const };

export function auditPath(f: AuditFilters, page: number) {
  const s = new URLSearchParams();
  for (const k of ['q', 'action', 'entity', 'from', 'to'] as const) if (f[k]) s.set(k, f[k]);
  if (f.failed) s.set('failed', '1');
  s.set('page', String(page));
  s.set('pageSize', String(AUDIT_PAGE_SIZE));
  return `/admin/audit?${s.toString()}`;
}

export function useAudit(f: AuditFilters, page: number) {
  return useQuery({
    queryKey: [...auditKeys.all, f, page],
    queryFn: () => get<AuditPage>(auditPath(f, page)),
    placeholderData: keepPreviousData,
  });
}

/** The fields that differ between the row before and after: [field, before, after]. */
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: [string, unknown, unknown][] = [];
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push([k, b, a]);
  }
  return out;
}
