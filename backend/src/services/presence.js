// live_agents (migration 0008): one row per agent logged in right now,
// rewritten from the real sources every PRESENCE_SECONDS (default 10) and
// shortly after any status change. It is for people (SELECT * FROM
// live_agents) - the app itself keeps reading the sources:
//   agent_status_log (open row = status), calls (open call), the agent
//   screens' live connections (realtime hub), Asterisk (line registered),
//   audit_log (last login).
// "Logged in" = an open status row, or the agent screen open (logged in,
// no queue picked yet).
const pool = require('../../db');
const ari = require('../../ari');
const hub = require('../realtime/hub');
const tenancy = require('../tenancy');
const { forEachTenant } = require('./tenants');

/** Pure: the rows of live_agents from what the sources say (tests feed this directly). */
function buildPresence({ open, connected, users, calls, lines, queues, campaigns, logins }) {
  const byUser = new Map();
  for (const r of open) byUser.set(r.user_id, { user: { id: r.user_id, username: r.username, ext: r.ext }, status: r });
  for (const id of connected) {
    if (byUser.has(id)) continue;
    const u = users.find((x) => x.id === id);
    if (u) byUser.set(id, { user: { id, username: u.username, ext: u.ext }, status: null });
  }
  const rows = [];
  for (const [id, { user, status }] of byUser) {
    const ext = (status && status.extension_name) || user.ext || null;
    const call = ext ? calls.find((c) => c.from_extension === ext || c.transfer_ext === ext) : null;
    const queueId = status ? status.queue_id || status.last_queue_id || null : null;
    const queue = queueId ? queues.find((q) => q.id === queueId) : null;
    const campaign = queueId ? campaigns.find((c) => c.queue_id === queueId) : null;
    const lineState = !ext
      ? 'unregistered'
      : !lines
        ? 'unknown'
        : lines[ext] === 'online'
          ? 'registered'
          : 'unregistered';
    const screenOpen = connected.includes(id);
    rows.push({
      user_id: id,
      username: user.username,
      extension: ext,
      state: call ? 'on_call' : status ? status.status : 'logged_in',
      status: status ? status.status : null,
      reason: status ? status.reason : null,
      status_since: status ? status.started_at : null,
      login_at: logins[id] || (status ? status.started_at : null),
      queue_id: queue ? queue.id : null,
      queue_name: queue ? queue.name : null,
      campaign_id: campaign ? campaign.id : null,
      campaign_name: campaign ? campaign.name : null,
      call_id: call ? call.id : null,
      call_number: call ? call.to_number : null,
      call_since: call ? call.agent_connect_time || call.start_time : null,
      line: lineState,
      screen_open: screenOpen ? 1 : 0,
      seen: screenOpen || lineState === 'registered',
    });
  }
  return rows;
}

const COLUMNS = [
  'user_id',
  'username',
  'extension',
  'state',
  'status',
  'reason',
  'status_since',
  'login_at',
  'queue_id',
  'queue_name',
  'campaign_id',
  'campaign_name',
  'call_id',
  'call_number',
  'call_since',
  'line',
  'screen_open',
];

/** Reads the sources and rewrites live_agents. Returns the rows written. */
async function syncPresence(deps = { pool, ari, hub }) {
  const db = deps.pool;
  const [open] = await db.query(
    `SELECT asl.user_id, u.username, e.name AS ext, asl.status, asl.reason, asl.started_at, asl.extension_name,
            asl.queue_id,
            (SELECT x.queue_id FROM agent_status_log x WHERE x.user_id = asl.user_id AND x.queue_id IS NOT NULL
             ORDER BY x.id DESC LIMIT 1) AS last_queue_id
     FROM agent_status_log asl JOIN users u ON u.id = asl.user_id LEFT JOIN extensions e ON e.id = u.extension_id
     WHERE asl.ended_at IS NULL AND u.role = 'agent'
     ORDER BY asl.id`,
  );
  const connected = deps.hub.connectedUserIds('agent');
  const [users] = connected.length
    ? await db.query(
        `SELECT u.id, u.username, e.name AS ext FROM users u LEFT JOIN extensions e ON e.id = u.extension_id
         WHERE u.id IN (?) AND u.role = 'agent'`,
        [connected],
      )
    : [[]];
  const [calls] = await db.query(
    `SELECT id, to_number, from_extension, transfer_ext, start_time, agent_connect_time FROM calls
     WHERE end_time IS NULL AND start_time > NOW() - INTERVAL 3 HOUR ORDER BY id DESC`,
  );
  const [queues] = await db.query('SELECT id, name FROM queues');
  const [campaigns] = await db.query(
    'SELECT MIN(id) AS id, queue_id, MIN(name) AS name FROM campaigns WHERE deleted_at IS NULL AND queue_id IS NOT NULL GROUP BY queue_id',
  );
  const [loginRows] = await db.query(
    `SELECT entity_id AS user_id, MAX(at) AS at FROM audit_log
     WHERE action = 'auth.login' AND entity = 'users' AND at > NOW() - INTERVAL 1 DAY GROUP BY entity_id`,
  );
  const logins = Object.fromEntries(loginRows.map((r) => [r.user_id, r.at]));

  // Line state: one ARI call for all endpoints; ones it doesn't list are asked one by one.
  let lines = await deps.ari.endpointStates();
  if (lines) {
    const exts = new Set([...open.map((r) => r.extension_name || r.ext), ...users.map((u) => u.ext)].filter(Boolean));
    for (const ext of exts) {
      if (!(ext in lines)) lines = { ...lines, [ext]: await deps.ari.endpointState(`PJSIP/${ext}`) };
    }
  }

  const rows = buildPresence({ open, connected, users, calls, lines, queues, campaigns, logins });
  for (const r of rows) {
    await db.query(
      `INSERT INTO live_agents (${COLUMNS.join(', ')}, last_seen_at, updated_at)
       VALUES (${COLUMNS.map(() => '?').join(', ')}, IF(?, NOW(), NULL), NOW())
       ON DUPLICATE KEY UPDATE ${COLUMNS.filter((c) => c !== 'user_id')
         .map((c) => `${c} = VALUES(${c})`)
         .join(', ')}, last_seen_at = IF(?, NOW(), last_seen_at), updated_at = NOW()`,
      [...COLUMNS.map((c) => r[c]), r.seen ? 1 : 0, r.seen ? 1 : 0],
    );
  }
  if (rows.length) await db.query('DELETE FROM live_agents WHERE user_id NOT IN (?)', [rows.map((r) => r.user_id)]);
  else await db.query('DELETE FROM live_agents');
  return rows;
}

// --- running it ---
// Per company (Cloud edition): each has its own live_agents table, its own
// pending refresh and its own "already running" mark.
let timer = null;
const soon = new Map(); // company key -> pending refresh
const running = new Set(); // company keys

/** One refresh, for the company the code is running as. */
async function runOnce() {
  const k = tenancy.key();
  if (running.has(k)) return;
  running.add(k);
  try {
    await syncPresence();
  } catch (err) {
    console.error(`[presence] ${k || 'home'}:`, err.message);
  } finally {
    running.delete(k);
  }
}

/** A status / call just changed: refresh within a second (several changes, one refresh). */
function presenceChanged() {
  const k = tenancy.key();
  if (!timer || soon.has(k)) return;
  // The timer keeps the company it was started for (async context).
  const t = setTimeout(() => {
    soon.delete(k);
    void runOnce();
  }, 1000);
  t.unref?.();
  soon.set(k, t);
}

function startPresenceSync(seconds = Number(process.env.PRESENCE_SECONDS) || 10) {
  if (timer) return;
  const all = () =>
    forEachTenant(runOnce, { label: 'presence' }).catch((err) => console.error('[presence]', err.message));
  timer = setInterval(() => void all(), seconds * 1000);
  timer.unref?.();
  void all();
}

module.exports = { buildPresence, syncPresence, presenceChanged, startPresenceSync };
