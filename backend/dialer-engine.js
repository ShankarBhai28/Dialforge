// DialForge dialer engine (predictive-dialer step D5).
//
// A separate process from the web backend (its own systemd unit,
// dialforge-dialer) so a crash or slow query here never takes down agents'
// screens, and vice versa. The two only talk through MySQL:
//   - admin sets campaigns.dialer_state (running/paused/stopped) via the web UI
//   - this engine keeps dial_hopper filled and writes dialer_status each tick
//
// D5 does NOT place calls. It fills the hopper and computes how many calls
// it *would* place (would_dial, dry-run). Preview (D6) and progressive /
// predictive (D7-D8) build the actual dialing on top of this loop.
require('dotenv').config();
const pool = require('./db');
const { normalizePhone, isWithinCallWindow } = require('./dialer-common');

const TICK_MS = 5000;
const MIN_HOPPER = 20;        // always keep at least this many leads ready
const MAX_HOPPER = 500;       // never buffer more than this per campaign
const LEADS_PER_AGENT = 10;   // buffer ~10 dials' worth per idle agent line
const STALE_LOCK_MIN = 10;    // a locked row older than this goes back to ready
const ENGINE_ID = `engine-${process.pid}`;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Only one engine may ever run - two would race each other filling and
// (later) dialing the same campaign. MySQL's GET_LOCK is held for as long
// as this connection lives, so a crashed engine releases it automatically.
async function acquireSingleInstanceLock() {
  const conn = await pool.getConnection();
  const [[row]] = await conn.query("SELECT GET_LOCK('dialforge_dialer_engine', 0) AS got");
  if (row.got !== 1) {
    log('another dialer engine already holds the lock - exiting');
    process.exit(1);
  }
  // Losing this connection means losing the lock: exit and let systemd
  // restart us cleanly rather than keep running unprotected.
  conn.connection.on('error', (err) => {
    log('lock connection lost:', err.message);
    process.exit(1);
  });
  return conn;
}

// Agents currently Available in the campaign's queue.
async function countIdleAgents(queueId) {
  if (!queueId) return 0;
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS n FROM agent_status_log WHERE ended_at IS NULL AND status = 'available' AND queue_id = ?",
    [queueId]
  );
  return row.n;
}

async function hopperCounts(campaignId) {
  const [rows] = await pool.query(
    'SELECT status, COUNT(*) AS n FROM dial_hopper WHERE campaign_id = ? GROUP BY status', [campaignId]
  );
  const get = (s) => (rows.find((r) => r.status === s) || { n: 0 }).n;
  return { ready: get('ready'), locked: get('locked') };
}

// Drop rows that stopped being dialable since they were queued: the lead
// got a final disposition, was rescheduled, moved campaign, ran out of
// attempts, its list was deactivated, or its number went on the DNC list.
async function cleanHopper(c) {
  await pool.query(
    `UPDATE dial_hopper SET status = 'ready', locked_at = NULL, locked_by = NULL
     WHERE campaign_id = ? AND status = 'locked' AND locked_at < NOW() - INTERVAL ? MINUTE`,
    [c.id, STALE_LOCK_MIN]
  );
  const [stale] = await pool.query(
    `DELETE h FROM dial_hopper h
     JOIN leads l ON l.id = h.lead_id
     LEFT JOIN lists ls ON ls.id = l.list_id
     WHERE h.campaign_id = ? AND h.status = 'ready' AND (
       l.is_final = 1 OR l.campaign_id IS NULL OR l.campaign_id <> h.campaign_id
       OR (l.next_call_at IS NOT NULL AND l.next_call_at > NOW())
       OR l.attempts >= ? OR (ls.id IS NOT NULL AND ls.is_active = 0)
     )`,
    [c.id, c.max_attempts]
  );
  const [dnc] = await pool.query(
    `DELETE h FROM dial_hopper h JOIN dnc_numbers d ON d.tenant_id = 1 AND d.phone = h.phone
     WHERE h.campaign_id = ? AND h.status = 'ready'`,
    [c.id]
  );
  const removed = stale.affectedRows + dnc.affectedRows;
  if (removed) log(`campaign ${c.id}: removed ${removed} no-longer-dialable lead(s) from hopper`);
}

// Top up the hopper to its target size with the best next leads.
async function fillHopper(c, idleAgents, counts) {
  const ratio = Number(c.dial_mode === 'predictive' ? c.max_dial_ratio : c.dial_ratio) || 1;
  const want = Math.min(MAX_HOPPER, Math.max(MIN_HOPPER, Math.ceil(idleAgents * ratio * LEADS_PER_AGENT)));
  const need = want - (counts.ready + counts.locked);
  if (need <= 0) return 0;

  // Fetch extra so DNC/"only me" filtering below can still fill the gap.
  const [candidates] = await pool.query(
    `SELECT l.id, l.phone, l.list_id, l.priority, l.attempts, COALESCE(ls.priority, 0) AS list_priority,
            cb.id AS callback_id, cb.user_id AS callback_user_id
     FROM leads l
     LEFT JOIN lists ls ON ls.id = l.list_id
     LEFT JOIN dial_hopper h ON h.lead_id = l.id
     LEFT JOIN callbacks cb ON cb.lead_id = l.id AND cb.status = 'pending'
     WHERE l.campaign_id = ? AND l.is_final = 0 AND l.attempts < ?
       AND (l.next_call_at IS NULL OR l.next_call_at <= NOW())
       AND (ls.id IS NULL OR ls.is_active = 1)
       AND l.status <> 'do_not_call'
       AND h.id IS NULL
     ORDER BY (cb.id IS NOT NULL) DESC, list_priority DESC, l.priority DESC, l.attempts ASC, l.id ASC
     LIMIT ?`,
    [c.id, c.max_attempts, need * 2]
  );
  if (candidates.length === 0) return 0;

  const phones = candidates.map((x) => normalizePhone(x.phone));
  const [dncRows] = await pool.query('SELECT phone FROM dnc_numbers WHERE tenant_id = 1 AND phone IN (?)', [phones]);
  const dnc = new Set(dncRows.map((r) => r.phone));

  const rows = [];
  for (const lead of candidates) {
    if (rows.length >= need) break;
    const phone = normalizePhone(lead.phone);
    if (dnc.has(phone)) continue;
    // An "only me" callback can only go to that agent - which only preview
    // mode can guarantee. Auto-dial modes leave it on the agent's
    // My Callbacks list instead of handing it to whoever is free.
    if (lead.callback_user_id && c.dial_mode !== 'preview') continue;
    rows.push([c.id, lead.id, lead.list_id, phone, lead.callback_id ? 1 : 0, lead.list_priority,
      lead.priority, lead.attempts, lead.callback_user_id || null]);
  }
  if (rows.length === 0) return 0;
  // INSERT IGNORE: the UNIQUE(lead_id) guard wins over any race.
  const [result] = await pool.query(
    `INSERT IGNORE INTO dial_hopper
       (campaign_id, lead_id, list_id, phone, is_callback, list_priority, lead_priority, attempts, reserved_user_id)
     VALUES ?`,
    [rows]
  );
  return result.affectedRows;
}

// Dry-run of the pacing maths (real dialing arrives in D7): how many calls
// would be started right now for the agents who are free.
function wouldDial(c, idleAgents, readyCount) {
  if (c.dial_mode !== 'progressive' && c.dial_mode !== 'predictive') return 0;
  return Math.min(readyCount, c.max_channels, Math.floor(idleAgents * Number(c.dial_ratio)));
}

async function writeStatus(campaignId, s) {
  await pool.query(
    `INSERT INTO dialer_status (campaign_id, hopper_ready, hopper_locked, idle_agents, would_dial, note, last_tick_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE hopper_ready = VALUES(hopper_ready), hopper_locked = VALUES(hopper_locked),
       idle_agents = VALUES(idle_agents), would_dial = VALUES(would_dial), note = VALUES(note), last_tick_at = NOW()`,
    [campaignId, s.ready || 0, s.locked || 0, s.idle || 0, s.wouldDial || 0, s.note || null]
  );
}

async function processCampaign(c) {
  if (c.dialer_state === 'stopped') {
    // Stopped: empty the buffer (locked rows are mid-use; they expire).
    const [r] = await pool.query("DELETE FROM dial_hopper WHERE campaign_id = ? AND status = 'ready'", [c.id]);
    if (r.affectedRows) log(`campaign ${c.id}: stopped - cleared ${r.affectedRows} lead(s) from hopper`);
    await pool.query('DELETE FROM dialer_status WHERE campaign_id = ?', [c.id]);
    return;
  }

  const idle = await countIdleAgents(c.queue_id);
  await cleanHopper(c);
  let note = null;
  let added = 0;
  if (c.status !== 'active') note = 'campaign status is not active - not filling';
  else if (c.dial_mode === 'manual') note = 'manual mode - the dialer is not used';
  else if (!c.queue_id) note = 'campaign has no queue';
  else if (c.dialer_state === 'paused') note = 'paused by admin';
  else if (!isWithinCallWindow(c)) note = `outside calling hours (${c.call_window_start.slice(0, 5)}-${c.call_window_end.slice(0, 5)} ${c.timezone})`;
  else added = await fillHopper(c, idle, await hopperCounts(c.id));

  const counts = await hopperCounts(c.id);
  if (!note && counts.ready === 0) note = 'no dialable leads (check active lists, attempts used, retry/callback times)';
  if (added) log(`campaign ${c.id}: added ${added} lead(s) to hopper (ready=${counts.ready})`);
  await writeStatus(c.id, {
    ready: counts.ready, locked: counts.locked, idle,
    wouldDial: note ? 0 : wouldDial(c, idle, counts.ready), note,
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;  // never overlap two ticks if one runs long
  ticking = true;
  try {
    await writeStatus(0, { note: ENGINE_ID });
    // Running/paused campaigns, plus stopped ones that still have hopper
    // rows to clear.
    const [campaigns] = await pool.query(
      `SELECT * FROM campaigns
       WHERE dialer_state IN ('running', 'paused')
          OR id IN (SELECT DISTINCT campaign_id FROM dial_hopper)
          OR id IN (SELECT campaign_id FROM dialer_status WHERE campaign_id > 0)`
    );
    for (const c of campaigns) {
      try {
        await processCampaign(c);
      } catch (err) {
        log(`campaign ${c.id}: tick failed:`, err.message);
      }
    }
  } catch (err) {
    log('tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

async function main() {
  await acquireSingleInstanceLock();
  log(`dialer engine started (${ENGINE_ID}), tick every ${TICK_MS / 1000}s`);
  await tick();
  const timer = setInterval(tick, TICK_MS);
  const shutdown = async (sig) => {
    log(`${sig} received - stopping`);
    clearInterval(timer);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
