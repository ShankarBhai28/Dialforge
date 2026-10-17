const pool = require('../../db');
const { localTimeIn } = require('../../dialer-common');

const DIAL_MODES = ['manual', 'preview', 'progressive', 'predictive', 'inbound'];

// Parses and range-checks the dial settings block of a campaign form.
// Returns { error } or { settings } with DB column names.
function parseCampaignSettings(body) {
  const num = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));
  const s = {
    dial_mode: body.dialMode || 'manual',
    dial_ratio: num(body.dialRatio, 1),
    max_dial_ratio: num(body.maxDialRatio, 2.5),
    target_abandon_pct: num(body.targetAbandonPct, 3),
    ring_timeout_sec: num(body.ringTimeoutSec, 30),
    max_attempts: num(body.maxAttempts, 3),
    max_channels: num(body.maxChannels, 10),
    amd_enabled: body.amdEnabled ? 1 : 0,
    preview_autodial_sec: num(body.previewAutodialSec, null),
    wrapup_sec: num(body.wrapupSec, 10),
    call_window_start: body.callWindowStart || '09:00',
    call_window_end: body.callWindowEnd || '21:00',
    timezone: body.timezone || 'Asia/Kolkata',
    abandon_wait_sec: num(body.abandonWaitSec, 5),
    // 0 = off; otherwise skip numbers another campaign reached in the last N hours.
    number_gap_hours: num(body.numberGapHours, 0),
    // Auto disposition: 0 = off; otherwise this disposition is saved when the
    // agent gives none within that many seconds after the call.
    auto_dispo_sec: num(body.autoDispoSec, 0),
    auto_dispo_code: body.autoDispoCode ? String(body.autoDispoCode).trim().slice(0, 30) : null,
    // Recording is on unless switched off.
    record_calls: body.recordCalls === false ? 0 : 1,
  };
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!DIAL_MODES.includes(s.dial_mode)) return { error: 'unknown dial mode' };
  if (!inRange(s.dial_ratio, 1, 5)) return { error: 'dial ratio must be between 1 and 5' };
  if (!inRange(s.max_dial_ratio, s.dial_ratio, 5))
    return { error: 'max dial ratio must be between the dial ratio and 5' };
  if (!inRange(s.target_abandon_pct, 0, 10)) return { error: 'target abandon % must be between 0 and 10' };
  if (!inRange(s.ring_timeout_sec, 10, 60)) return { error: 'ring timeout must be 10-60 seconds' };
  if (!inRange(s.max_attempts, 1, 20) || !Number.isInteger(s.max_attempts))
    return { error: 'max attempts must be a whole number 1-20' };
  if (!inRange(s.max_channels, 1, 200) || !Number.isInteger(s.max_channels))
    return { error: 'max channels must be a whole number 1-200' };
  if (s.preview_autodial_sec !== null && !inRange(s.preview_autodial_sec, 0, 120))
    return { error: 'preview auto-dial must be 0-120 seconds' };
  if (!inRange(s.wrapup_sec, 0, 600)) return { error: 'wrap-up must be 0-600 seconds' };
  if (!inRange(s.abandon_wait_sec, 2, 30) || !Number.isInteger(s.abandon_wait_sec))
    return { error: 'max wait for an agent must be 2-30 seconds' };
  if (!inRange(s.auto_dispo_sec, 0, 600) || !Number.isInteger(s.auto_dispo_sec))
    return { error: 'auto disposition must be 0-600 seconds (0 = off)' };
  if (s.auto_dispo_sec > 0 && !s.auto_dispo_code) return { error: 'pick the disposition to save automatically' };
  if (!inRange(s.number_gap_hours, 0, 168) || !Number.isInteger(s.number_gap_hours))
    return { error: 'spacing across campaigns must be 0-168 hours (0 = off)' };
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  if (!timeRe.test(s.call_window_start) || !timeRe.test(s.call_window_end))
    return { error: 'calling window times must be HH:MM' };
  if (s.call_window_start.length === 5) s.call_window_start += ':00';
  if (s.call_window_end.length === 5) s.call_window_end += ':00';
  if (s.call_window_start >= s.call_window_end) return { error: 'calling window start must be before its end' };
  try {
    localTimeIn(s.timezone);
  } catch {
    return { error: `unknown timezone "${s.timezone}"` };
  }
  return { settings: s };
}

// Only an active form can be attached to a campaign.
async function checkCampaignForm(formId) {
  if (!formId) return null;
  const [rows] = await pool.query('SELECT status FROM forms WHERE id = ? AND deleted_at IS NULL', [formId]);
  if (!rows[0]) return 'form not found';
  if (rows[0].status !== 'active') return 'that form is inactive';
  return null;
}

module.exports = { checkCampaignForm, parseCampaignSettings };
