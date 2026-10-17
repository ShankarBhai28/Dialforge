const pool = require('../../db');
const { TRUNK_CALLER_ID, TRUNK_ENDPOINT } = require('../config');
const hub = require('../realtime/hub');

// Decides how to dial a destination: straight to one of our own test
// extensions if it matches one, otherwise out through the live trunk -
// using the calling campaign's own CLI if it has one set, falling back
// to the global default otherwise.
async function resolveDestination(toNumber, campaignCallerId) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? AND deleted_at IS NULL LIMIT 1', [toNumber]);
  if (rows.length > 0) {
    return { endpoint: `PJSIP/${toNumber}`, callerId: null };
  }
  return { endpoint: `PJSIP/${toNumber}@${TRUNK_ENDPOINT}`, callerId: campaignCallerId || TRUNK_CALLER_ID };
}

async function logEvent(callId, eventType, payload) {
  await pool.query('INSERT INTO call_events (call_id, event_type, payload) VALUES (?, ?, ?)', [
    callId,
    eventType,
    payload ? JSON.stringify(payload) : null,
  ]);
  hub.publish('call.event', { callId, eventType, payload: payload || null });
  require('./presence').presenceChanged(); // live_agents shows the call (lazy: presence needs hub too)
}

/**
 * SQL condition (with its params) for "this agent's call", on calls alias
 * `alias`: the agent who took it, or - transfers, older calls with no agent
 * recorded - a call on an extension the agent was using at that time.
 * Extensions are a per-shift device choice: whoever used 1001 yesterday must
 * not see today's agent's calls, and the other way round.
 */
function agentCallCondition(userId, alias = 'ca') {
  return [
    `(${alias}.agent_user_id = ? OR EXISTS (
       SELECT 1 FROM agent_status_log mine
       WHERE mine.user_id = ? AND mine.extension_name IN (${alias}.from_extension, ${alias}.transfer_ext)
         AND mine.started_at <= COALESCE(${alias}.end_time, NOW())
         AND (mine.ended_at IS NULL OR mine.ended_at >= ${alias}.start_time)))`,
    [userId, userId],
  ];
}

/** One of this agent's calls (agentCallCondition), or null. */
async function findAgentCall(userId, callId, deps = { pool }) {
  const [cond, params] = agentCallCondition(userId);
  const [rows] = await deps.pool.query(
    `SELECT ca.id, ca.campaign_id, ca.lead_id FROM calls ca WHERE ca.id = ? AND ${cond}`,
    [Number(callId) || 0, ...params],
  );
  return rows[0] || null;
}

module.exports = { agentCallCondition, findAgentCall, logEvent, resolveDestination };
