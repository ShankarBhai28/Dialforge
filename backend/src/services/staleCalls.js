// Calls left open after they ended ("ghost calls"): Asterisk's hang-up
// event was missed - a server restarted mid-call, or under load (the 29 Oct
// load test: ~0.2 % of calls at 200 agents). The agent then shows "on a
// call" and gets no dialer calls for up to 3 hours. Every minute, open calls
// whose channels Asterisk no longer has - two checks in a row, so a call
// just being set up isn't caught - are closed the way the hang-up event
// would have closed them, and noted in the call's history and the audit log.
const pool = require('../../db');
const ari = require('../../ari');
const { logEvent } = require('./calls');
const { setAgentStatus } = require('./agents');
const { openStatus } = require('./agentLogout');
const { audit } = require('./audit');

const missingSince = new Map(); // callId -> ms when first seen with no channel

/** Is the call still up in Asterisk? Its own channels, or (no channel recorded) its extension's. */
function stillUp(call, live) {
  if (call.channel_name || call.agent_channel) {
    return live.has(call.channel_name) || live.has(call.agent_channel);
  }
  // Click-to-call rows may have no channel name: any channel on the agent's extension.
  const exts = [call.from_extension, call.transfer_ext].filter(Boolean);
  if (!exts.length) return true; // nothing to check it by - leave it
  for (const name of live) if (exts.some((e) => String(name).startsWith(`PJSIP/${e}-`))) return true;
  return false;
}

async function closeCall(call, deps) {
  const [r] = await deps.pool.query(
    "UPDATE calls SET end_time = NOW(), disposition = COALESCE(disposition, 'ended') WHERE id = ? AND end_time IS NULL",
    [call.id],
  );
  if (!r.affectedRows) return false; // the real event got there first
  if (call.dial_attempt_id) {
    // A connected attempt ends here; one never connected is the dialer's own stale check's.
    await deps.pool.query(
      "UPDATE dial_attempts SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE id = ? AND status <> 'ended' AND result IS NOT NULL",
      [call.dial_attempt_id],
    );
  }
  await deps.logEvent(call.id, 'ended', { by: 'cleanup', reason: 'no channel left in Asterisk' });
  // As after a normal hang-up: the agent who talked goes to wrap-up for the outcome.
  if (call.agent_user_id && call.agent_connect_time && call.from_extension) {
    const open = await deps.openStatus(call.agent_user_id, deps);
    if (open && open.status === 'available') {
      await deps.setAgentStatus(call.agent_user_id, 'acw', null, null, call.from_extension);
    }
  }
  await deps.audit({
    action: 'call.auto_close',
    entity: 'calls',
    entityId: call.id,
    summary: `open since ${new Date(call.start_time).toISOString()}, no channel left in Asterisk`,
  });
  return true;
}

async function sweepStaleCalls({
  now = Date.now(),
  deps = { pool, ari, logEvent, setAgentStatus, openStatus, audit },
} = {}) {
  // The last day only (index calls_start; end_time has none). Older open
  // calls block no one (agents count calls of the last 3 hours) - db-check lists them.
  const [calls] = await deps.pool.query(
    `SELECT id, channel_name, agent_channel, from_extension, transfer_ext, dial_attempt_id,
            agent_user_id, agent_connect_time, start_time
     FROM calls
     WHERE start_time > NOW() - INTERVAL 1 DAY AND start_time < NOW() - INTERVAL 30 SECOND AND end_time IS NULL`,
  );
  const open = new Set(calls.map((c) => c.id));
  for (const id of missingSince.keys()) if (!open.has(id)) missingSince.delete(id);
  if (!calls.length) return [];
  const live = await deps.ari.liveChannels();
  if (!live) return []; // couldn't ask Asterisk - decide next time
  const closed = [];
  for (const call of calls) {
    if (stillUp(call, live)) {
      missingSince.delete(call.id);
      continue;
    }
    if (!missingSince.has(call.id)) {
      missingSince.set(call.id, now);
      continue;
    }
    missingSince.delete(call.id);
    if (await closeCall(call, deps)) closed.push(call.id);
  }
  return closed;
}

function startStaleCallCleanup(seconds = Number(process.env.STALE_CALL_CHECK_SECONDS ?? 60)) {
  if (!seconds) return null;
  const timer = setInterval(() => {
    sweepStaleCalls().catch((err) => console.error('[stale calls]', err.message));
  }, seconds * 1000);
  timer.unref();
  return timer;
}

module.exports = { sweepStaleCalls, startStaleCallCleanup, stillUp };
