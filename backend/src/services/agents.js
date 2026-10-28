const pool = require('../../db');
const ami = require('../../ami');
const { releasePreviewLocks } = require('./preview');
const hub = require('../realtime/hub');
// Asterisk names (Cloud edition: <company>_1001, <company>_<queue>); our tables keep the plain ones.
const names = require('../telephony/names');

// --- Agent status tracking (available / break / acw) ---
async function closeOpenStatus(userId) {
  await pool.query('UPDATE agent_status_log SET ended_at = NOW() WHERE user_id = ? AND ended_at IS NULL', [userId]);
  require('./presence').presenceChanged(); // live_agents (lazy: presence needs this module's neighbours)
}

// Which queue is this agent nominally working this session? (the most
// recent status row that had one set, regardless of current status) -
// needed so break/acw/logout know which real Asterisk queue to pause or
// remove them from without every caller having to track it separately.
async function findCurrentQueueAsteriskName(userId) {
  const [rows] = await pool.query(
    'SELECT queue_id FROM agent_status_log WHERE user_id = ? AND queue_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    [userId],
  );
  if (!rows[0]) return null;
  const [queueRows] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [rows[0].queue_id]);
  return queueRows[0] ? queueRows[0].asterisk_name : null;
}

// The full campaign row for whichever queue this agent is currently
// working - same underlying lookup as above, one hop further, used
// anywhere a feature depends on "which campaign is this agent in right
// now" (leads scoping, outbound CLI selection).
async function findCurrentCampaign(userId) {
  const asteriskName = await findCurrentQueueAsteriskName(userId);
  if (!asteriskName) return null;
  const [rows] = await pool.query(
    `SELECT c.* FROM campaigns c JOIN queues q ON q.id = c.queue_id WHERE q.asterisk_name = ? LIMIT 1`,
    [asteriskName],
  );
  return rows[0] || null;
}

// Keeps real Asterisk queue membership in sync with our own status
// tracking via AMI - this is what makes "queue show" reflect what an
// agent is actually doing, instead of a label that only lives in our DB.
async function syncQueueMembership(userId, extensionName, newStatus, explicitQueueId) {
  if (!extensionName) return;
  let main;
  if (explicitQueueId) {
    const [rows] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [explicitQueueId]);
    main = rows[0] ? rows[0].asterisk_name : null;
  } else {
    main = await findCurrentQueueAsteriskName(userId);
  }
  // The campaign's other queues the agent took for this shift follow the
  // same status (Available = ringing, Break / wrap-up = paused, logout =
  // removed). All rung alike (penalty 0).
  const extras = (await extraQueueNames(userId)).filter((q) => q !== main);
  const targets = [...(main ? [main] : []), ...extras];
  const iface = names.pjsip(extensionName);
  for (const target of targets) {
    const queue = names.queue(target);
    try {
      if (newStatus === 'available') {
        await ami.queueAdd(queue, iface).catch(() => {}); // already a member - fine
        await ami.queuePause(queue, iface, false);
      } else if (newStatus === 'break' || newStatus === 'acw') {
        await ami.queuePause(queue, iface, true);
      } else if (newStatus === 'offline') {
        await ami.queueRemove(queue, iface);
      }
    } catch (err) {
      // Removing / pausing an agent who isn't in that queue (already left, never
      // went Available) is the state we want anyway - not worth a log line.
      if (/not there|interface not found/i.test(err.message)) continue;
      console.error('[AMI queue sync failed]', err.message);
    }
  }
  // Logged out: the next shift picks its queues again.
  if (newStatus === 'offline') await pool.query('DELETE FROM agent_extra_queues WHERE user_id = ?', [userId]);
}

/** The asterisk names of the campaign queues an agent took for this shift (besides the main one). */
async function extraQueueNames(userId) {
  const [rows] = await pool.query(
    `SELECT q.asterisk_name FROM agent_extra_queues x JOIN queues q ON q.id = x.queue_id
     WHERE x.user_id = ? AND q.deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.asterisk_name);
}

/**
 * Replace an agent's extra queues (going Available with a new choice): queues
 * dropped from the choice are left in Asterisk right away.
 */
async function setExtraQueues(userId, extensionName, queueIds) {
  const [old] = await pool.query(
    'SELECT x.queue_id, q.asterisk_name FROM agent_extra_queues x JOIN queues q ON q.id = x.queue_id WHERE x.user_id = ?',
    [userId],
  );
  const keep = new Set(queueIds);
  for (const o of old) {
    if (keep.has(o.queue_id) || !extensionName) continue;
    await ami.queueRemove(names.queue(o.asterisk_name), names.pjsip(extensionName)).catch(() => {});
  }
  await pool.query('DELETE FROM agent_extra_queues WHERE user_id = ?', [userId]);
  if (queueIds.length)
    await pool.query('INSERT INTO agent_extra_queues (user_id, queue_id) VALUES ?', [queueIds.map((q) => [userId, q])]);
}

/** extraQueueIds: the campaign's other queues the agent takes (only when going Available; undefined = keep the shift's). */
async function setAgentStatus(userId, status, reason, queueId, extensionName, extraQueueIds) {
  require('./presence').presenceChanged();
  let keepCampaignId = null;
  if (status === 'available' && queueId) {
    const [c] = await pool.query('SELECT id FROM campaigns WHERE queue_id = ? LIMIT 1', [queueId]);
    keepCampaignId = c[0] ? c[0].id : null;
  }
  await releasePreviewLocks(userId, keepCampaignId).catch((err) =>
    console.error('[preview release failed]', err.message),
  );
  // A different main queue (another campaign): leave the old one (re-joined below if it's one of the new campaign's).
  if (status === 'available' && queueId && extensionName) {
    const before = await findCurrentQueueAsteriskName(userId);
    const [now] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [queueId]);
    if (before && now[0] && now[0].asterisk_name !== before)
      await ami.queueRemove(names.queue(before), names.pjsip(extensionName)).catch(() => {});
  }
  await closeOpenStatus(userId);
  await pool.query(
    'INSERT INTO agent_status_log (user_id, status, reason, queue_id, extension_name) VALUES (?, ?, ?, ?, ?)',
    [userId, status, reason || null, queueId || null, extensionName || null],
  );
  if (status === 'available' && Array.isArray(extraQueueIds))
    await setExtraQueues(userId, extensionName, extraQueueIds);
  await syncQueueMembership(userId, extensionName, status, queueId);
  hub.publish(
    'agent.status',
    { userId, status, reason: reason || null, queueId: queueId || null, extensionName: extensionName || null },
    { toUserId: userId },
  );
}

// Who is ACTUALLY on this extension right now? Not the same as asking
// which login account has it as their assigned extension - an agent can
// connect with a different one (a per-shift device choice), so the only
// reliable source of truth is their most recent status row that recorded
// this extension_name.
async function findAgentIdByExtension(extensionName) {
  const [rows] = await pool.query(
    'SELECT user_id FROM agent_status_log WHERE extension_name = ? ORDER BY id DESC LIMIT 1',
    [extensionName],
  );
  return rows[0] ? rows[0].user_id : null;
}

// Queues this agent may work, via team membership -> team's campaigns.
// DISTINCT because an agent in two teams sharing a campaign would
// otherwise see that queue twice. Each row is a campaign's main queue, with
// the campaign's other queues (extra_queues) the agent may also take and
// whether they must take them all (take_all).
async function findAgentQueues(userId) {
  const [rows] = await pool.query(
    `
    SELECT DISTINCT q.id, q.name, c.name AS campaign_name, c.id AS campaign_id, c.dial_mode,
      c.agents_take_all_queues AS take_all
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
    JOIN team_campaigns tc ON tc.team_id = t.id
    JOIN campaigns c ON c.id = tc.campaign_id AND c.status = 'active'
    JOIN queues q ON q.id = c.queue_id AND q.status = 'active'
    WHERE tm.user_id = ?
    ORDER BY c.name, q.name
  `,
    [userId],
  );
  const extras = rows.length
    ? (
        await pool.query(
          `SELECT cq.campaign_id, q.id, q.name FROM campaign_queues cq
           JOIN queues q ON q.id = cq.queue_id AND q.status = 'active' AND q.deleted_at IS NULL
           WHERE cq.campaign_id IN (?) ORDER BY q.name`,
          [rows.map((r) => r.campaign_id)],
        )
      )[0]
    : [];
  return rows.map((r) => ({
    ...r,
    take_all: !!Number(r.take_all),
    extra_queues: extras
      .filter((x) => x.campaign_id === r.campaign_id && x.id !== r.id)
      .map(({ id, name }) => ({ id, name })),
  }));
}

/**
 * A campaign's queue list changed: agents working it leave the queues it no
 * longer has (their Asterisk membership and their shift choice). Agents pick
 * up newly added queues at their next Available.
 */
async function leaveRemovedCampaignQueues(campaignId, removedQueueIds) {
  if (!removedQueueIds.length) return;
  const [rows] = await pool.query(
    `SELECT x.user_id, x.queue_id, q.asterisk_name,
       (SELECT s.extension_name FROM agent_status_log s WHERE s.user_id = x.user_id ORDER BY s.id DESC LIMIT 1) AS ext,
       (SELECT s.queue_id FROM agent_status_log s WHERE s.user_id = x.user_id AND s.queue_id IS NOT NULL ORDER BY s.id DESC LIMIT 1) AS main_queue
     FROM agent_extra_queues x JOIN queues q ON q.id = x.queue_id
     WHERE x.queue_id IN (?)`,
    [removedQueueIds],
  );
  const [[c]] = await pool.query('SELECT queue_id FROM campaigns WHERE id = ?', [campaignId]);
  for (const r of rows) {
    if (!c || r.main_queue !== c.queue_id) continue; // working another campaign that still has it
    if (r.ext) await ami.queueRemove(names.queue(r.asterisk_name), names.pjsip(r.ext)).catch(() => {});
    await pool.query('DELETE FROM agent_extra_queues WHERE user_id = ? AND queue_id = ?', [r.user_id, r.queue_id]);
  }
}

async function currentAgentStatus(userId) {
  const [rows] = await pool.query(
    'SELECT status FROM agent_status_log WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId],
  );
  return rows[0] ? rows[0].status : 'offline';
}

module.exports = {
  extraQueueNames,
  leaveRemovedCampaignQueues,
  setExtraQueues,
  closeOpenStatus,
  currentAgentStatus,
  findAgentIdByExtension,
  findAgentQueues,
  findCurrentCampaign,
  findCurrentQueueAsteriskName,
  setAgentStatus,
  syncQueueMembership,
};
