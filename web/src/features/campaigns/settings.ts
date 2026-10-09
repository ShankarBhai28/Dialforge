// Campaign form state <-> API body, plus the simple checks from the backend's
// parseCampaignSettings / validateDispositions so most mistakes show before a
// round trip. The server still validates everything and its message wins.
import type { Campaign, CampaignBody, DialMode, Disposition, DispositionInput } from './api';

export const DIAL_MODES: { value: DialMode; label: string }[] = [
  { value: 'manual', label: 'Manual - agent dials' },
  { value: 'preview', label: 'Preview - lead shown, agent clicks dial' },
  { value: 'progressive', label: 'Progressive - auto-dial at fixed ratio' },
  { value: 'predictive', label: 'Predictive - adaptive ratio' },
];

/** Which mode-specific knobs to show (same rules as the classic screen). */
export function modeFields(mode: DialMode) {
  const auto = mode === 'progressive' || mode === 'predictive';
  return { preview: mode === 'preview', auto, predictive: mode === 'predictive' };
}

// Inputs are kept as strings so a half-typed number isn't coerced.
export type CampaignForm = {
  name: string;
  queueId: string;
  formId: string;
  outboundCallerId: string;
  status: string;
  autoAnswer: boolean;
  dialMode: DialMode;
  dialRatio: string;
  maxDialRatio: string;
  targetAbandonPct: string;
  previewAutodialSec: string;
  ringTimeoutSec: string;
  maxAttempts: string;
  maxChannels: string;
  wrapupSec: string;
  abandonWaitSec: string;
  callWindowStart: string;
  callWindowEnd: string;
  timezone: string;
  amdEnabled: boolean;
};

// The server's defaults (parseCampaignSettings), also used when a box is left blank.
const DEFAULTS = {
  dialRatio: 1,
  maxDialRatio: 2.5,
  targetAbandonPct: 3,
  ringTimeoutSec: 30,
  maxAttempts: 3,
  maxChannels: 10,
  wrapupSec: 10,
  abandonWaitSec: 5,
};

export function campaignForm(c: Campaign | null): CampaignForm {
  const str = (v: number | string | null | undefined, def: number) => String(v == null ? def : Number(v));
  return {
    name: c?.name ?? '',
    queueId: c?.queue_id ? String(c.queue_id) : '',
    formId: c?.form_id ? String(c.form_id) : '',
    outboundCallerId: c?.outbound_caller_id ?? '',
    status: c?.status ?? 'active',
    autoAnswer: !!c?.auto_answer,
    dialMode: c?.dial_mode ?? 'manual',
    dialRatio: str(c?.dial_ratio, DEFAULTS.dialRatio),
    maxDialRatio: str(c?.max_dial_ratio, DEFAULTS.maxDialRatio),
    targetAbandonPct: str(c?.target_abandon_pct, DEFAULTS.targetAbandonPct),
    previewAutodialSec: c?.preview_autodial_sec == null ? '' : String(c.preview_autodial_sec),
    ringTimeoutSec: str(c?.ring_timeout_sec, DEFAULTS.ringTimeoutSec),
    maxAttempts: str(c?.max_attempts, DEFAULTS.maxAttempts),
    maxChannels: str(c?.max_channels, DEFAULTS.maxChannels),
    wrapupSec: str(c?.wrapup_sec, DEFAULTS.wrapupSec),
    abandonWaitSec: str(c?.abandon_wait_sec, DEFAULTS.abandonWaitSec),
    callWindowStart: (c?.call_window_start ?? '09:00').slice(0, 5),
    callWindowEnd: (c?.call_window_end ?? '21:00').slice(0, 5),
    timezone: c?.timezone ?? 'Asia/Kolkata',
    amdEnabled: !!c?.amd_enabled,
  };
}

export function campaignBody(f: CampaignForm): CampaignBody {
  const num = (v: string, def: number) => (v.trim() === '' ? def : Number(v));
  return {
    name: f.name.trim(),
    queueId: f.queueId ? Number(f.queueId) : null,
    formId: f.formId ? Number(f.formId) : null,
    outboundCallerId: f.outboundCallerId.trim() || null,
    autoAnswer: f.autoAnswer,
    status: f.status,
    dialMode: f.dialMode,
    dialRatio: num(f.dialRatio, DEFAULTS.dialRatio),
    maxDialRatio: num(f.maxDialRatio, DEFAULTS.maxDialRatio),
    targetAbandonPct: num(f.targetAbandonPct, DEFAULTS.targetAbandonPct),
    // Blank = auto-dial off.
    previewAutodialSec: f.previewAutodialSec.trim() === '' ? null : Number(f.previewAutodialSec),
    ringTimeoutSec: num(f.ringTimeoutSec, DEFAULTS.ringTimeoutSec),
    maxAttempts: num(f.maxAttempts, DEFAULTS.maxAttempts),
    maxChannels: num(f.maxChannels, DEFAULTS.maxChannels),
    wrapupSec: num(f.wrapupSec, DEFAULTS.wrapupSec),
    abandonWaitSec: num(f.abandonWaitSec, DEFAULTS.abandonWaitSec),
    callWindowStart: f.callWindowStart,
    callWindowEnd: f.callWindowEnd,
    timezone: f.timezone.trim() || 'Asia/Kolkata',
    amdEnabled: f.amdEnabled,
  };
}

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Same checks and wording as parseCampaignSettings; null = looks fine. */
export function checkCampaign(b: CampaignBody): string | null {
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  const whole = (v: number, lo: number, hi: number) => inRange(v, lo, hi) && Number.isInteger(v);
  if (!b.name) return 'Campaign name is required';
  if (!inRange(b.dialRatio, 1, 5)) return 'dial ratio must be between 1 and 5';
  if (!inRange(b.maxDialRatio, b.dialRatio, 5)) return 'max dial ratio must be between the dial ratio and 5';
  if (!inRange(b.targetAbandonPct, 0, 10)) return 'target abandon % must be between 0 and 10';
  if (!inRange(b.ringTimeoutSec, 10, 60)) return 'ring timeout must be 10-60 seconds';
  if (!whole(b.maxAttempts, 1, 20)) return 'max attempts must be a whole number 1-20';
  if (!whole(b.maxChannels, 1, 200)) return 'max channels must be a whole number 1-200';
  if (b.previewAutodialSec !== null && !inRange(b.previewAutodialSec, 0, 120))
    return 'preview auto-dial must be 0-120 seconds';
  if (!inRange(b.wrapupSec, 0, 600)) return 'wrap-up must be 0-600 seconds';
  if (!whole(b.abandonWaitSec, 2, 30)) return 'max wait for an agent must be 2-30 seconds';
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  if (!timeRe.test(b.callWindowStart) || !timeRe.test(b.callWindowEnd)) return 'calling window times must be HH:MM';
  if (b.callWindowStart >= b.callWindowEnd) return 'calling window start must be before its end';
  if (!isTimeZone(b.timezone)) return `unknown timezone "${b.timezone}"`;
  return null;
}

/** IANA zone names for the timezone suggestions (empty on old browsers). */
export function timeZoneNames(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
}

// --- Dispositions ---

// One editable row. `uid` keeps React keys stable while rows move;
// `codeTouched` stops the code following the label once typed by hand.
export type DispoRow = {
  uid: number;
  label: string;
  code: string;
  codeTouched: boolean;
  isFinal: boolean;
  retryAfterMin: string;
  isCallback: boolean;
  marksDnc: boolean;
};

let nextUid = 1;
export function dispoRow(d?: Disposition): DispoRow {
  return {
    uid: nextUid++,
    label: d?.label ?? '',
    code: d?.code ?? '',
    codeTouched: !!d?.code,
    isFinal: !!d?.is_final,
    retryAfterMin: d?.retry_after_min ? String(d.retry_after_min) : '',
    isCallback: !!d?.is_callback,
    marksDnc: !!d?.marks_dnc,
  };
}

/** "Wrong Number" -> "wrong_number" (the classic slugifyKey, capped at 30 like the server). */
export function codeFromLabel(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 30);
}

/** Rows -> PUT body; fully blank rows are dropped, like the classic editor. */
export function dispositionsBody(rows: DispoRow[]): DispositionInput[] {
  return rows
    .map((r) => ({ ...r, label: r.label.trim(), code: r.code.trim() }))
    .filter((r) => r.label || r.code)
    .map((r) => ({
      label: r.label,
      code: r.code,
      isFinal: r.isFinal,
      retryAfterMin: r.retryAfterMin.trim() === '' ? null : Number(r.retryAfterMin),
      isCallback: r.isCallback,
      marksDnc: r.marksDnc,
    }));
}

/** Same checks and wording as validateDispositions. */
export function checkDispositions(list: DispositionInput[]): string | null {
  if (list.length === 0) return 'a campaign needs at least one disposition';
  const seen = new Set<string>();
  for (const d of list) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(d.code))
      return `code "${d.code}" must be lowercase letters, digits, underscores, starting with a letter`;
    if (d.code === 'new') return '"new" is reserved for leads not yet called';
    if (seen.has(d.code)) return `code "${d.code}" is used twice`;
    seen.add(d.code);
    if (!d.label) return `disposition "${d.code}" needs a label`;
    const retry = d.retryAfterMin;
    if (retry !== null && (!Number.isInteger(retry) || retry < 1 || retry > 43200))
      return `"${d.label}": retry must be a whole number of minutes (1-43200)`;
    if (d.isFinal && (retry !== null || d.isCallback))
      return `"${d.label}": a final disposition can't also retry or schedule a callback`;
    if (d.marksDnc && !d.isFinal) return `"${d.label}": Do-Not-Call dispositions must also be final`;
    if (d.isCallback && retry !== null) return `"${d.label}": pick either callback or retry, not both`;
  }
  return null;
}
