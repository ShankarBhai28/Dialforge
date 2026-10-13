// Shared bits of the report modules.
const { scopeCondition } = require('../access');
const { DEFAULT_DISPOSITIONS } = require('../dispositions');

/** ' AND <scope>' for a team-scoped role (empty for "all"). */
function scoped(scope, kind, column) {
  const [cond, params] = scopeCondition(scope, kind, column);
  return cond ? { sql: ` AND ${cond}`, params } : { sql: '', params: [] };
}

/** A positive whole number from a query string, else null. */
function idParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const num = (v) => (v == null ? 0 : Number(v));
/** a / b as a percent with one decimal; null when b is 0. */
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
/** a / b rounded; null when b is 0. */
const avg = (a, b) => (b > 0 ? Math.round(a / b) : null);

/** A stored (UTC) time as local 'YYYY-MM-DD HH:MM:SS' (offset comes from parseRange, never from the user). */
const localTime = (col, offset) => `DATE_FORMAT(CONVERT_TZ(${col}, '+00:00', '${offset}'), '%Y-%m-%d %H:%i:%s')`;

/** Seconds the agent was talking on a call (connected -> end). */
const TALK_SQL =
  'IF(ca.agent_connect_time IS NULL, 0, GREATEST(TIMESTAMPDIFF(SECOND, ca.agent_connect_time, COALESCE(ca.end_time, ca.agent_connect_time)), 0))';

/** Sums the given keys over rows. */
function sum(rows, keys) {
  const t = {};
  for (const k of keys) t[k] = rows.reduce((s, r) => s + num(r[k]), 0);
  return t;
}

// What calls.disposition (how the call ended, technically) means.
const RESULT_LABELS = {
  ended: 'Not answered', // connected calls are labelled before this lookup
  connected: 'Answered',
  abandoned: 'Dropped (no agent free)',
  customer_hangup: 'Caller hung up waiting',
  machine: 'Answering machine',
  no_answer: 'No answer',
  busy: 'Busy',
  congestion: 'Network error',
  network_error: 'Network error',
  failed: 'Failed',
  invalid: 'Invalid number',
  agent_unanswered: "Agent didn't answer",
  cancelled: 'Hung up by supervisor',
};

function resultLabel(call) {
  if (call.agent_connect_time || call.connected) return 'Answered';
  if (call.disposition) return RESULT_LABELS[call.disposition] || call.disposition;
  return call.ended ? 'Not answered' : 'In progress';
}

const DEFAULT_LABELS = Object.fromEntries(DEFAULT_DISPOSITIONS.map((d) => [d.code, d.label]));
/** An outcome's label: the campaign's own, the default set's, or the raw code. */
const outcomeLabel = (code, label) => label || DEFAULT_LABELS[code] || code;

module.exports = {
  scoped,
  idParam,
  num,
  pct,
  avg,
  localTime,
  TALK_SQL,
  sum,
  RESULT_LABELS,
  resultLabel,
  outcomeLabel,
};
