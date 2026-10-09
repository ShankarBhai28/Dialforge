const pool = require('../../db');
const ami = require('../../ami');
const { releasePreviewLocks } = require('./preview');
const hub = require('../realtime/hub');

// --- Agent status tracking (available / break / acw) ---
async function closeOpenStatus(userId) {
  await pool.query('UPDATE agent_status_log SET ended_at = NOW() WHERE user_id = ? AND ended_at IS NULL', [userId]);
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
  let asteriskName;
  if (explicitQueueId) {
    const [rows] = await pool.query('SELECT asterisk_name FROM queues WHERE id = ?', [explicitQueueId]);
    asteriskName = rows[0] ? rows[0].asterisk_name : null;
  } else {
    asteriskName = await findCurrentQueueAsteriskName(userId);
  }
  if (!asteriskName) return;

  const iface = `PJSIP/${extensionName}`;
  try {
    if (newStatus === 'available') {
      await ami.queueAdd(asteriskName, iface).catch(() => {}); // already a member - fine
      await ami.queuePause(asteriskName, iface, false);
    } else if (newStatus === 'break' || newStatus === 'acw') {
      await ami.queuePause(asteriskName, iface, true);
    } else if (newStatus === 'offline') {
      await ami.queueRemove(asteriskName, iface);
    }
  } catch (err) {
    console.error('[AMI queue sync failed]', err.message);
  }
}

async function setAgentStatus(userId, status, reason, queueId, extensionName) {
  let keepCampaignId = null;
  if (status === 'available' && queueId) {
    const [c] = await pool.query('SELECT id FROM campaigns WHERE queue_id = ? LIMIT 1', [queueId]);
    keepCampaignId = c[0] ? c[0].id : null;
  }
  await releasePreviewLocks(userId, keepCampaignId).catch((err) =>
    console.error('[preview release failed]', err.message),
  );
  await closeOpenStatus(userId);
  await pool.query(
    'INSERT INTO agent_status_log (user_id, status, reason, queue_id, extension_name) VALUES (?, ?, ?, ?, ?)',
    [userId, status, reason || null, queueId || null, extensionName || null],
  );
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
// otherwise see that queue twice.
async function findAgentQueues(userId) {
  const [rows] = await pool.query(
    `
    SELECT DISTINCT q.id, q.name, c.name AS campaign_name
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
  return rows;
}

async function currentAgentStatus(userId) {
  const [rows] = await pool.query(
    'SELECT status FROM agent_status_log WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId],
  );
  return rows[0] ? rows[0].status : 'offline';
}

module.exports = {
  closeOpenStatus,
  currentAgentStatus,
  findAgentIdByExtension,
  findAgentQueues,
  findCurrentCampaign,
  findCurrentQueueAsteriskName,
  setAgentStatus,
  syncQueueMembership,
};
