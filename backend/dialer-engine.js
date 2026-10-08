// DialForge dialer engine (predictive-dialer step D5).
//
// A separate process from the web backend (its own systemd unit,
// dialforge-dialer) so a crash or slow query here never takes down agents'
// screens, and vice versa. The two only talk through MySQL:
//   - admin sets campaigns.dialer_state (running/paused/stopped) via the web UI
//   - this engine keeps dial_hopper filled and writes dialer_status each tick
//
// Two loops:
//   every 5 s  - clean + fill the hopper, sweep stuck attempts, write status
//   every 1 s  - pacing: for running progressive campaigns, place
//                floor(idle agents x dial ratio) - calls already in flight
// Calls are placed through ARI under our own Stasis app "dialforge-dialer".
// An answered customer is handed to the [dialer-answered] dialplan context
// (optional AMD, then the campaign's Queue() with a short max wait); the web
// backend's AMI handlers record who took it / abandoned / machine.
require('dotenv').config();
const pool = require('./db');
const ari = require('./ari');
const { normalizePhone, isWithinCallWindow, finishAttempt } = require('./dialer-common');

const DIALER_APP = 'dialforge-dialer';
const TRUNK_ENDPOINT = process.env.TRUNK_ENDPOINT || 'dialforge-nxtra1';
const TRUNK_CALLER_ID = process.env.TRUNK_CALLER_ID || '8065098690';
// Hard ceiling across ALL campaigns - the trunk's concurrent-call limit.
// Set DIALER_MAX_TRUNK_CHANNELS in .env to the provider's real number.
const MAX_TRUNK_CHANNELS = Number(process.env.DIALER_MAX_TRUNK_CHANNELS || 4);
const PACE_MS = 1000;
const MAX_NEW_CALLS_PER_TICK = 5;  // smooths bursts (e.g. 10 agents freeing at once)
let ariReady = false;

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

// Agents Available in the campaign's queue AND not already on a call.
// (Our status stays "available" during a call - ACW only starts when it
// ends - so an open calls row on their extension is what marks them busy.)
async function countIdleAgents(queueId) {
  if (!queueId) return 0;
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT asl.user_id) AS n
     FROM agent_status_log asl
     WHERE asl.ended_at IS NULL AND asl.status = 'available' AND asl.queue_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM calls c
         WHERE c.from_extension = asl.extension_name AND c.end_time IS NULL
           AND c.start_time > NOW() - INTERVAL 3 HOUR
       )`,
    [queueId]
  );
  return row.n;
}

async function attemptCounts(campaignId) {
  const [[row]] = await pool.query(
    `SELECT SUM(status IN ('dialing', 'answered')) AS in_flight,
            SUM(status IN ('dialing', 'answered', 'connected')) AS active
     FROM dial_attempts WHERE campaign_id = ? AND status <> 'ended'`,
    [campaignId]
  );
  return { inFlight: Number(row.in_flight || 0), active: Number(row.active || 0) };
}

async function trunkChannelsInUse() {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM dial_attempts WHERE status <> 'ended'");
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
  const ratio = effectiveRatio(c) || 1;
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

// --- Predictive pacing (D8) ---
// Progressive dials a fixed ratio. Predictive learns it: if only 40% of
// calls are answered, dialing 1 / 0.4 = 2.5 lines per free agent keeps
// agents busy. Dial too hard and answered customers find no free agent
// (abandons), so a self-tuning factor (adjust) is lowered whenever the
// abandon % goes over the campaign's target and slowly raised while it
// stays well below. The result is always kept between 1.0 and the
// campaign's max_dial_ratio.
const ANSWER_WINDOW_MIN = 15;     // answer rate measured over the last 15 min
const ABANDON_WINDOW_MIN = 30;    // abandon % over the last 30 min
const MIN_ATTEMPTS_FOR_RATE = 20; // fewer than this -> not enough data, use the starting ratio
const MIN_ANSWERED_FOR_ABANDON = 10;
const ADJUST_EVERY_MS = 30000;    // re-tune at most every 30 s
const ADJUST_MIN = 0.3;
const ADJUST_MAX = 1.0;           // never dial more than 1/answer_rate
const predictive = new Map();     // campaignId -> { ratio, answerRate, abandonPct, adjust, adjustedAt, note }

async function campaignRates(campaignId) {
  const [[r]] = await pool.query(
    `SELECT
       SUM(started_at > NOW() - INTERVAL ? MINUTE AND status = 'ended') AS attempts,
       SUM(started_at > NOW() - INTERVAL ? MINUTE AND status = 'ended' AND answered_at IS NOT NULL) AS answered,
       SUM(started_at > NOW() - INTERVAL ? MINUTE AND answered_at IS NOT NULL AND result IS NOT NULL) AS answered_long,
       SUM(started_at > NOW() - INTERVAL ? MINUTE AND result IN ('abandoned', 'customer_hangup')) AS abandoned
     FROM dial_attempts WHERE campaign_id = ? AND started_at > NOW() - INTERVAL ? MINUTE`,
    [ANSWER_WINDOW_MIN, ANSWER_WINDOW_MIN, ABANDON_WINDOW_MIN, ABANDON_WINDOW_MIN, campaignId,
      Math.max(ANSWER_WINDOW_MIN, ABANDON_WINDOW_MIN)]
  );
  return {
    attempts: Number(r.attempts || 0), answered: Number(r.answered || 0),
    answeredLong: Number(r.answered_long || 0), abandoned: Number(r.abandoned || 0),
  };
}

// Pure function (unit-tested): previous state + fresh rates -> new state.
function computePredictive(c, rates, prev, now) {
  const start = Number(c.dial_ratio);
  const max = Number(c.max_dial_ratio);
  const target = Number(c.target_abandon_pct);
  let adjust = prev ? prev.adjust : ADJUST_MAX;
  let adjustedAt = prev ? prev.adjustedAt : 0;
  const answerRate = rates.attempts >= MIN_ATTEMPTS_FOR_RATE ? rates.answered / rates.attempts : null;
  const abandonPct = rates.answeredLong >= MIN_ANSWERED_FOR_ABANDON ? (100 * rates.abandoned) / rates.answeredLong : null;
  let note;

  if (abandonPct !== null && now - adjustedAt >= ADJUST_EVERY_MS) {
    if (abandonPct > target) adjust = Math.max(ADJUST_MIN, adjust - 0.1);
    else if (abandonPct < target / 2) adjust = Math.min(ADJUST_MAX, adjust + 0.05);
    adjustedAt = now;
  }

  let ratio;
  if (abandonPct !== null && abandonPct > 2 * target) {
    ratio = 1;  // safety brake: way over target -> plain progressive until it recovers
    note = `abandon ${abandonPct.toFixed(1)}% is over 2x target - holding at 1.0`;
  } else if (answerRate === null) {
    ratio = start;
    note = `learning (${rates.attempts}/${MIN_ATTEMPTS_FOR_RATE} calls) - using starting ratio`;
  } else if (answerRate === 0) {
    ratio = max;
    note = 'no answers in the window - at max ratio';
  } else {
    ratio = (1 / answerRate) * adjust;
    note = null;
  }
  ratio = Math.round(Math.min(max, Math.max(1, ratio)) * 100) / 100;
  return { ratio, answerRate, abandonPct, adjust: Math.round(adjust * 100) / 100, adjustedAt, note };
}

async function updatePredictive(c) {
  if (c.dial_mode !== 'predictive') { predictive.delete(c.id); return null; }
  let prev = predictive.get(c.id);
  if (!prev) {
    // Engine restarted: resume the learned adjust factor.
    const [rows] = await pool.query('SELECT ratio_adjust FROM dialer_status WHERE campaign_id = ?', [c.id]);
    if (rows[0] && rows[0].ratio_adjust != null) prev = { adjust: Number(rows[0].ratio_adjust), adjustedAt: 0 };
  }
  const state = computePredictive(c, await campaignRates(c.id), prev, Date.now());
  predictive.set(c.id, state);
  return state;
}

// The ratio pacing uses right now: progressive = fixed; predictive = learned.
function effectiveRatio(c) {
  if (c.dial_mode === 'predictive') {
    const st = predictive.get(c.id);
    return st ? st.ratio : Number(c.dial_ratio);
  }
  return Number(c.dial_ratio);
}

// Keep (idle agents x ratio) calls ringing, minus what's already ringing
// or waiting for an agent, within the campaign's and the trunk's limits.
function callsToPlace(c, idle, attempts, trunkInUse, ratio) {
  const wanted = Math.floor(idle * ratio) - attempts.inFlight;
  return Math.max(0, Math.min(
    wanted,
    c.max_channels - attempts.active,
    MAX_TRUNK_CHANNELS - trunkInUse,
    MAX_NEW_CALLS_PER_TICK,
  ));
}

async function writeStatus(campaignId, s) {
  const pv = s.predictive || {};
  await pool.query(
    `INSERT INTO dialer_status (campaign_id, hopper_ready, hopper_locked, idle_agents, would_dial, in_flight, active_calls, note,
       current_ratio, answer_rate, abandon_pct, ratio_adjust, pacing_note, last_tick_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE hopper_ready = VALUES(hopper_ready), hopper_locked = VALUES(hopper_locked),
       idle_agents = VALUES(idle_agents), would_dial = VALUES(would_dial), in_flight = VALUES(in_flight),
       active_calls = VALUES(active_calls), note = VALUES(note), current_ratio = VALUES(current_ratio),
       answer_rate = VALUES(answer_rate), abandon_pct = VALUES(abandon_pct),
       ratio_adjust = COALESCE(VALUES(ratio_adjust), ratio_adjust), pacing_note = VALUES(pacing_note), last_tick_at = NOW()`,
    [campaignId, s.ready || 0, s.locked || 0, s.idle || 0, s.wouldDial || 0, s.inFlight || 0, s.active || 0, s.note || null,
      s.ratio == null ? null : s.ratio,
      pv.answerRate == null ? null : Math.round(pv.answerRate * 10000) / 100,
      pv.abandonPct == null ? null : Math.round(pv.abandonPct * 100) / 100,
      pv.adjust == null ? null : pv.adjust,
      pv.note || null]
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
  if (!note && isAutoDial(c) && !ariReady) note = 'not connected to Asterisk (ARI) - cannot dial';
  if (added) log(`campaign ${c.id}: added ${added} lead(s) to hopper (ready=${counts.ready})`);
  const attempts = await attemptCounts(c.id);
  const pv = await updatePredictive(c);
  const ratio = isAutoDial(c) ? effectiveRatio(c) : null;
  await writeStatus(c.id, {
    ready: counts.ready, locked: counts.locked, idle, note, ratio, predictive: pv,
    wouldDial: !note && isAutoDial(c) ? callsToPlace(c, idle, attempts, await trunkChannelsInUse(), ratio) : 0,
    inFlight: attempts.inFlight, active: attempts.active,
  });
}

const isAutoDial = (c) => c.dial_mode === 'progressive' || c.dial_mode === 'predictive';

// --- Placing calls ---
const HANGUP_CAUSE_RESULT = {
  17: 'busy', 21: 'busy',                      // user busy, call rejected
  18: 'no_answer', 19: 'no_answer', 16: 'no_answer', 0: 'no_answer',
  1: 'invalid', 3: 'invalid', 22: 'invalid', 28: 'invalid',  // unallocated / no route / number changed / invalid format
  34: 'congestion', 38: 'congestion', 41: 'congestion', 42: 'congestion', 44: 'congestion', 58: 'congestion',
};

// Our own extensions (test leads like 1002) are dialed directly, everything
// else through the trunk - same rule as the backend's click-to-call.
async function endpointFor(phone) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? LIMIT 1', [phone]);
  return rows.length ? `PJSIP/${phone}` : `PJSIP/${phone}@${TRUNK_ENDPOINT}`;
}

// Take the best ready lead off the hopper (SKIP LOCKED so the agents'
// preview claims never block us) and create its dial_attempts row - both in
// one transaction, so a lead can't be lost between the two.
async function claimLeadForDialing(c, ratio) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT h.id, h.lead_id, l.phone FROM dial_hopper h JOIN leads l ON l.id = h.lead_id
       WHERE h.campaign_id = ? AND h.status = 'ready' AND h.reserved_user_id IS NULL
       ORDER BY h.is_callback DESC, h.list_priority DESC, h.lead_priority DESC, h.attempts, h.lead_id
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [c.id]
    );
    if (!rows[0]) { await conn.rollback(); return null; }
    const row = rows[0];
    await conn.query('DELETE FROM dial_hopper WHERE id = ?', [row.id]);
    const [ins] = await conn.query(
      'INSERT INTO dial_attempts (tenant_id, campaign_id, lead_id, phone, ratio_at_dial) VALUES (1, ?, ?, ?, ?)',
      [c.id, row.lead_id, row.phone, ratio]
    );
    await conn.query('UPDATE leads SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?', [row.lead_id]);
    await conn.commit();
    return { attemptId: ins.insertId, leadId: row.lead_id, phone: row.phone };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function placeCall(c, ratio) {
  const claimed = await claimLeadForDialing(c, ratio);
  if (!claimed) return false;
  const channelId = `dfd-${claimed.attemptId}`;
  await pool.query('UPDATE dial_attempts SET channel_id = ? WHERE id = ?', [channelId, claimed.attemptId]);
  try {
    // Last-moment DNC check: the number may have been added since it was queued.
    const [dnc] = await pool.query('SELECT 1 FROM dnc_numbers WHERE tenant_id = 1 AND phone = ?', [normalizePhone(claimed.phone)]);
    if (dnc.length) { await finishAttempt(pool, claimed.attemptId, 'failed', null); return true; }
    await ari.originate({
      endpoint: await endpointFor(claimed.phone),
      app: DIALER_APP,
      appArgs: `attempt,${claimed.attemptId}`,
      callerId: c.outbound_caller_id || TRUNK_CALLER_ID,
      timeout: c.ring_timeout_sec,
      channelId,
    });
    log(`campaign ${c.id}: dialing lead ${claimed.leadId} (${claimed.phone}) attempt ${claimed.attemptId}`);
  } catch (err) {
    log(`campaign ${c.id}: originate failed for attempt ${claimed.attemptId}:`, err.message);
    await finishAttempt(pool, claimed.attemptId, 'failed', null);
  }
  return true;
}

let pacing = false;
async function paceTick() {
  if (pacing || !ariReady) return;
  pacing = true;
  try {
    const [campaigns] = await pool.query(
      `SELECT c.* FROM campaigns c
       WHERE c.dialer_state = 'running' AND c.status = 'active' AND c.queue_id IS NOT NULL
         AND c.dial_mode IN ('progressive', 'predictive')`
    );
    for (const c of campaigns) {
      if (!isWithinCallWindow(c)) continue;
      const idle = await countIdleAgents(c.queue_id);
      if (!idle) continue;
      const ratio = effectiveRatio(c);
      const n = callsToPlace(c, idle, await attemptCounts(c.id), await trunkChannelsInUse(), ratio);
      for (let i = 0; i < n; i++) {
        if (!(await placeCall(c, ratio))) break;  // hopper empty
      }
    }
  } catch (err) {
    log('pace tick failed:', err.message);
  } finally {
    pacing = false;
  }
}

// --- ARI events for our own calls ---
async function onAriEvent(event) {
  try {
    if (event.type === 'StasisStart' && event.args[0] === 'attempt') {
      // Customer answered: record it, open a calls row, hand to the queue.
      const attemptId = Number(event.args[1]);
      const [[a]] = await pool.query(
        `SELECT a.*, c.abandon_wait_sec, c.amd_enabled, c.auto_answer, q.asterisk_name
         FROM dial_attempts a JOIN campaigns c ON c.id = a.campaign_id JOIN queues q ON q.id = c.queue_id
         WHERE a.id = ?`, [attemptId]
      );
      if (!a) { await ari.hangup(event.channel.id).catch(() => {}); return; }
      const [call] = await pool.query(
        `INSERT INTO calls (tenant_id, lead_id, direction, to_number, campaign_id, auto_answer, answer_time, channel_name, dial_attempt_id)
         VALUES (1, ?, 'outbound', ?, ?, ?, NOW(), ?, ?)`,
        [a.lead_id, a.phone, a.campaign_id, a.auto_answer, event.channel.name, attemptId]
      );
      await pool.query(
        "UPDATE dial_attempts SET status = 'answered', answered_at = NOW(), channel_name = ?, call_id = ? WHERE id = ?",
        [event.channel.name, call.insertId, attemptId]
      );
      await ari.setChannelVar(event.channel.id, 'QUEUENAME', a.asterisk_name);
      await ari.setChannelVar(event.channel.id, 'DIALER_ATTEMPT_ID', String(attemptId));
      await ari.setChannelVar(event.channel.id, 'DIALER_MAXWAIT', String(a.abandon_wait_sec || 5));
      await ari.setChannelVar(event.channel.id, 'DIALER_AMD', a.amd_enabled ? '1' : '0');
      await ari.continueInDialplan(event.channel.id, { context: 'dialer-answered', extension: 's', priority: 1 });
      log(`attempt ${attemptId}: answered -> queue ${a.asterisk_name}`);
    } else if (event.type === 'ChannelDestroyed' && event.channel.id.startsWith('dfd-')) {
      // Fires for every one of our channels; only matters if it never got
      // answered (answered calls are finished by the backend's AMI events).
      const attemptId = Number(event.channel.id.slice(4));
      const [[a]] = await pool.query('SELECT status FROM dial_attempts WHERE id = ?', [attemptId]);
      if (a && a.status === 'dialing') {
        const result = HANGUP_CAUSE_RESULT[event.cause] || 'failed';
        await finishAttempt(pool, attemptId, result, event.cause);
        log(`attempt ${attemptId}: ${result} (cause ${event.cause} ${event.cause_txt || ''})`);
      }
    }
  } catch (err) {
    log('ARI event handling failed:', err.message);
  }
}

// Safety net for attempts no event closed (engine restarted mid-call, a
// missed event): if Asterisk no longer has the channel, close the attempt.
async function sweepStuckAttempts() {
  const [rows] = await pool.query(
    `SELECT a.id, a.status, a.channel_id, c.ring_timeout_sec, c.abandon_wait_sec FROM dial_attempts a
     JOIN campaigns c ON c.id = a.campaign_id
     WHERE a.status <> 'ended' AND (
       (a.status = 'dialing' AND a.started_at < NOW() - INTERVAL (c.ring_timeout_sec + 30) SECOND)
       OR (a.status = 'answered' AND a.answered_at < NOW() - INTERVAL (c.abandon_wait_sec + 60) SECOND)
       OR (a.status = 'connected' AND a.connected_at < NOW() - INTERVAL 4 HOUR)
     )`
  );
  for (const a of rows) {
    if (a.channel_id && (await ari.getChannel(a.channel_id).catch(() => 'unknown'))) continue;  // still up
    const result = { dialing: 'no_answer', answered: 'customer_hangup', connected: 'connected' }[a.status];
    if (a.status === 'connected') {
      await pool.query("UPDATE dial_attempts SET status = 'ended', ended_at = NOW() WHERE id = ?", [a.id]);
    } else {
      await finishAttempt(pool, a.id, result, null);
    }
    log(`attempt ${a.id}: swept (${a.status} with no channel left) -> ${result}`);
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;  // never overlap two ticks if one runs long
  ticking = true;
  try {
    await writeStatus(0, { note: ENGINE_ID });
    await sweepStuckAttempts().catch((err) => log('sweep failed:', err.message));
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
  log(`dialer engine started (${ENGINE_ID}), tick every ${TICK_MS / 1000}s, pacing every ${PACE_MS / 1000}s, trunk cap ${MAX_TRUNK_CHANNELS}`);
  ari.connectEvents(DIALER_APP, onAriEvent, (up) => { ariReady = up; });
  await tick();
  const timer = setInterval(tick, TICK_MS);
  const paceTimer = setInterval(paceTick, PACE_MS);
  const shutdown = async (sig) => {
    log(`${sig} received - stopping`);
    clearInterval(timer);
    clearInterval(paceTimer);
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
