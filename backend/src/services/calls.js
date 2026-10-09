const pool = require('../../db');
const { TRUNK_CALLER_ID, TRUNK_ENDPOINT } = require('../config');
const hub = require('../realtime/hub');

// Decides how to dial a destination: straight to one of our own test
// extensions if it matches one, otherwise out through the live trunk -
// using the calling campaign's own CLI if it has one set, falling back
// to the global default otherwise.
async function resolveDestination(toNumber, campaignCallerId) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? LIMIT 1', [toNumber]);
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
}

module.exports = { logEvent, resolveDestination };
