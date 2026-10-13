// The Dialer screen's live calls: every number the dialer is working on
// right now (dialing -> ringing -> waiting for an agent -> with an agent),
// the ones that just finished, and a supervisor's Hang up.
const pool = require('../../db');
const ari = require('../../ari');
const { finishAttempt } = require('../../dialer-common');
const { logEvent } = require('./calls');

/** dial_attempts.status (+ ringing_at) -> what the screen says. */
function liveState(a) {
  if (a.status === 'connected') return 'connected';
  if (a.status === 'answered') return 'waiting'; // answered, machine check / waiting for a free agent
  return a.ringing_at ? 'ringing' : 'dialing';
}

/** When the current state began. */
function stateSince(a) {
  return { connected: a.connected_at, waiting: a.answered_at, ringing: a.ringing_at, dialing: a.started_at }[
    liveState(a)
  ];
}

const RESULT_LABELS = {
  connected: 'Completed',
  no_answer: 'No answer',
  busy: 'Busy',
  congestion: 'Network error',
  failed: 'Failed',
  invalid: 'Invalid number',
  machine: 'Answering machine',
  abandoned: 'Dropped (no agent free)',
  customer_hangup: 'Hung up waiting',
  cancelled: 'Hung up by supervisor',
};

/** { live: [...], finished: [...], counts } for one campaign. */
async function dialerLive(campaignId, deps = { pool }) {
  const [live] = await deps.pool.query(
    `SELECT a.id, a.lead_id, a.phone, a.status, a.started_at, a.ringing_at, a.answered_at, a.connected_at, a.call_id,
            l.name AS lead_name, u.username AS agent
     FROM dial_attempts a
     LEFT JOIN leads l ON l.id = a.lead_id
     LEFT JOIN users u ON u.id = a.agent_user_id
     WHERE a.campaign_id = ? AND a.status <> 'ended' AND a.started_at > NOW() - INTERVAL 4 HOUR
     ORDER BY FIELD(a.status, 'connected', 'answered', 'dialing'), a.id DESC`,
    [campaignId],
  );
  const [finished] = await deps.pool.query(
    `SELECT a.id, a.lead_id, a.phone, a.result, a.ended_at, a.answered_at, a.connected_at, l.name AS lead_name,
            u.username AS agent,
            IF(a.connected_at IS NULL, NULL, GREATEST(TIMESTAMPDIFF(SECOND, a.connected_at, a.ended_at), 0)) AS talk_seconds
     FROM dial_attempts a
     LEFT JOIN leads l ON l.id = a.lead_id
     LEFT JOIN users u ON u.id = a.agent_user_id
     WHERE a.campaign_id = ? AND a.status = 'ended' AND a.ended_at > NOW() - INTERVAL 30 MINUTE
     ORDER BY a.ended_at DESC, a.id DESC LIMIT 50`,
    [campaignId],
  );
  const rows = live.map((a) => ({
    id: a.id,
    leadId: a.lead_id,
    leadName: a.lead_name,
    phone: a.phone,
    state: liveState(a),
    since: stateSince(a),
    startedAt: a.started_at,
    agent: a.agent || null,
    callId: a.call_id,
  }));
  const counts = { dialing: 0, ringing: 0, waiting: 0, connected: 0 };
  for (const r of rows) counts[r.state]++;
  return {
    live: rows,
    counts,
    finished: finished.map((f) => ({
      id: f.id,
      leadId: f.lead_id,
      leadName: f.lead_name,
      phone: f.phone,
      result: f.result,
      resultLabel: RESULT_LABELS[f.result] || f.result || 'Ended',
      endedAt: f.ended_at,
      agent: f.agent || null,
      talkSeconds: f.talk_seconds == null ? null : Number(f.talk_seconds),
    })),
  };
}

class HangupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A supervisor hangs up a dialer call. Not yet with an agent: recorded as
 * "cancelled" (the lead waits an hour before it can be dialed again). With
 * an agent: the call simply ends (the agent goes to wrap-up as usual).
 * `inScope(campaignId)` = the caller may act on that campaign.
 */
async function hangupAttempt(attemptId, { user, inScope }, deps = { pool, ari, finishAttempt, logEvent }) {
  const [rows] = await deps.pool.query(
    'SELECT id, campaign_id, lead_id, status, channel_id, call_id FROM dial_attempts WHERE id = ?',
    [attemptId],
  );
  const a = rows[0];
  if (!a || !inScope(a.campaign_id)) throw new HangupError(404, 'call not found');
  if (a.status === 'ended') throw new HangupError(409, 'that call has already ended');
  if (a.status !== 'connected') {
    await deps.finishAttempt(deps.pool, a.id, 'cancelled', null);
    await deps.pool.query(
      `UPDATE leads SET next_call_at = GREATEST(COALESCE(next_call_at, NOW()), NOW() + INTERVAL 60 MINUTE)
       WHERE id = ? AND is_final = 0`,
      [a.lead_id],
    );
  }
  if (a.call_id) await deps.logEvent(a.call_id, 'hangup_by_supervisor', { by: user.username });
  try {
    if (a.channel_id) await deps.ari.hangup(a.channel_id);
  } catch (err) {
    // Already gone (it ended at the same moment) - the result above stands.
    if (!/ 404 /.test(err.message)) throw new HangupError(502, `Asterisk couldn't hang up: ${err.message}`);
  }
  return { id: a.id, was: liveState(a) };
}

module.exports = { dialerLive, hangupAttempt, liveState, HangupError, RESULT_LABELS };
