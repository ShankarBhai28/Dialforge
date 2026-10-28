// Taking an agent offline from the server side: a supervisor's "Force
// logout" on Live Agents, or the automatic cleanup of agents whose browser
// line has been gone for a while (startStaleAgentCleanup). Same steps as
// the agent's own logout: free a reserved preview lead, close the open
// status row, leave the Asterisk queue, tell open screens.
const pool = require('../../db');
const ari = require('../../ari');
const hub = require('../realtime/hub');
const { closeOpenStatus, syncQueueMembership } = require('./agents');
const { releasePreviewLocks } = require('./preview');
const { audit } = require('./audit');
const tenancy = require('../tenancy');
const { forEachTenant } = require('./tenants');

/** The agent's open status row ({ status, extension_name, started_at }) or null. */
async function openStatus(userId, deps = { pool }) {
  const [rows] = await deps.pool.query(
    'SELECT id, status, extension_name, started_at FROM agent_status_log WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

/** Is this extension on a call right now (calls row still open)? */
async function onActiveCall(extensionName, deps = { pool }) {
  if (!extensionName) return false;
  const [rows] = await deps.pool.query(
    'SELECT id FROM calls WHERE (from_extension = ? OR transfer_ext = ?) AND end_time IS NULL AND start_time > NOW() - INTERVAL 3 HOUR LIMIT 1',
    [extensionName, extensionName],
  );
  return rows.length > 0;
}

async function takeOffline(userId, extensionName) {
  await releasePreviewLocks(userId, null).catch((err) => console.error('[preview release failed]', err.message));
  await closeOpenStatus(userId);
  await syncQueueMembership(userId, extensionName, 'offline', null);
  hub.publish(
    'agent.status',
    { userId, status: 'offline', reason: null, queueId: null, extensionName: extensionName || null },
    { toUserId: userId },
  );
}

// --- Automatic cleanup ---
// An agent who is Available / Break / ACW but whose browser line has been
// unregistered for STALE_AGENT_MINUTES (default 10) is taken offline: they
// closed the browser or lost the network without logging out. 0 turns it off.
// '<company>:<userId>' -> ms when first seen unregistered (the sweep runs per company).
const offlineSince = new Map();
const offlineKey = (userId) => `${tenancy.key()}:${userId}`;

async function sweepStaleAgents({ minutes, now = Date.now(), deps = { pool, ari } } = {}) {
  const [rows] = await deps.pool.query(
    `SELECT asl.user_id, asl.status, asl.extension_name, asl.started_at
     FROM agent_status_log asl JOIN users u ON u.id = asl.user_id
     WHERE asl.ended_at IS NULL AND u.role = 'agent'`,
  );
  const open = new Set(rows.map((r) => offlineKey(r.user_id)));
  const mine = `${tenancy.key()}:`;
  for (const k of offlineSince.keys()) if (k.startsWith(mine) && !open.has(k)) offlineSince.delete(k);
  const loggedOut = [];
  for (const r of rows) {
    const state = r.extension_name ? await deps.ari.endpointState(`PJSIP/${r.extension_name}`) : 'offline';
    if (state === null) continue; // couldn't ask Asterisk - decide next time
    const key = offlineKey(r.user_id);
    if (state === 'online') {
      offlineSince.delete(key);
      continue;
    }
    if (!offlineSince.has(key)) offlineSince.set(key, now);
    if (now - offlineSince.get(key) < minutes * 60000) continue;
    if (await onActiveCall(r.extension_name, deps)) continue;
    await takeOffline(r.user_id, r.extension_name);
    offlineSince.delete(key);
    loggedOut.push(r.user_id);
    await audit({
      action: 'agent.auto_logout',
      entity: 'users',
      entityId: r.user_id,
      summary: `was ${r.status}; line ${r.extension_name || '-'} unregistered for ${minutes}+ min`,
    });
  }
  return loggedOut;
}

function startStaleAgentCleanup(minutes = Number(process.env.STALE_AGENT_MINUTES ?? 10)) {
  if (!minutes) return null;
  const timer = setInterval(() => {
    forEachTenant(() => sweepStaleAgents({ minutes }), { label: 'stale agents' }).catch((err) =>
      console.error('[stale agents]', err.message),
    );
  }, 60000);
  timer.unref();
  return timer;
}

module.exports = { openStatus, onActiveCall, takeOffline, sweepStaleAgents, startStaleAgentCleanup };
