// Report screen helpers: date presets, which filters go into a report's
// query, how a cell is shown.
import { toDateInput } from '@/lib/format';
import { formatSeconds } from '@/lib/utils';
import type { Cell, ReportColumn, ReportInfo } from './api';

export const dash = <span className="text-muted-foreground">—</span>;

// --- dates ---
export type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'custom';
export const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'custom', label: 'Custom' },
];

/** The from / to dates of a preset, counted from `now` (the browser's local day). */
export function presetRange(p: Exclude<Preset, 'custom'>, now = new Date()) {
  const day = (offset: number) => toDateInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const today = day(0);
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: day(-1), to: day(-1) };
    case 'last7':
      return { from: day(-6), to: today };
    case 'thisMonth':
      return { from: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'lastMonth':
      return {
        from: toDateInput(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: toDateInput(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
  }
}

// --- filters ---
export type Filters = {
  preset: Preset;
  from: string;
  to: string;
  campaignId: string;
  agentId: string;
  direction: string;
  answered: string;
  outcome: string;
  number: string;
  groupBy: string;
  slaSeconds: string;
};

export const GROUP_LABELS: Record<string, string> = { campaign: 'Campaign', agent: 'Agent', hour: 'Hour', did: 'DID' };

export const filterKeys = (r: ReportInfo) => r.filters.map((f) => (typeof f === 'string' ? f : f.key));
export const groupOptions = (r: ReportInfo) => {
  const g = r.filters.find((f) => typeof f !== 'string');
  return g && typeof g !== 'string' ? g.options : null;
};

/** The query string for a report: only the filters it uses. */
export function reportParams(r: ReportInfo, f: Filters, number: string): Record<string, string> {
  const keys = filterKeys(r);
  const p: Record<string, string> = {};
  if (!r.noRange) {
    p.from = f.from;
    p.to = f.to;
  }
  if (keys.includes('campaign')) p.campaignId = f.campaignId;
  if (keys.includes('agent')) p.agentId = f.agentId;
  if (keys.includes('direction')) p.direction = f.direction;
  if (keys.includes('answered')) p.answered = f.answered;
  if (keys.includes('outcome')) p.outcome = f.outcome;
  if (keys.includes('number')) p.number = number.trim();
  const groups = groupOptions(r);
  if (groups) p.groupBy = groups.includes(f.groupBy) ? f.groupBy : groups[0];
  if (keys.includes('sla')) p.slaSeconds = f.slaSeconds;
  return p;
}

export function formatCell(v: Cell, type: ReportColumn['type']) {
  if (v === null || v === undefined || v === '') return dash;
  if (typeof v === 'number') {
    if (type === 'seconds') return formatSeconds(v);
    if (type === 'percent') return `${v}%`;
    if (type === 'number') return v.toLocaleString('en-IN');
    return String(v);
  }
  if (type === 'datetime') return v.replace(' ', ' · ');
  return v;
}
