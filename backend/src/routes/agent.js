const express = require('express');
const pool = require('../../db');
const { requireAuth } = require('../middleware/auth');
const {
  findAgentQueues,
  findCurrentCampaign,
  findCurrentQueueAsteriskName,
  setAgentStatus,
} = require('../services/agents');
const { getDispositions } = require('../services/dispositions');
const { allowedExtensions, findOtherActiveHolder } = require('../services/extensionGuard');
const { buildWebrtcConfig } = require('../services/webrtc');

const router = express.Router();

router.post('/agent/status', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const { status, reason, queueId } = req.body;
  if (!['available', 'break', 'acw'].includes(status)) {
    return res.status(400).json({ error: 'status must be available, break, or acw' });
  }
  if (status === 'available' && !queueId) {
    return res.status(400).json({ error: 'a queue must be selected to go Available' });
  }
  // Enforced here too, not just by hiding queues in the UI - otherwise a
  // hand-crafted request could join any campaign's queue.
  if (status === 'available') {
    const allowed = await findAgentQueues(req.session.user.id);
    if (!allowed.some((q) => q.id === Number(queueId))) {
      return res.status(403).json({ error: "this queue is not in any of your teams' campaigns" });
    }
  }
  await setAgentStatus(
    req.session.user.id,
    status,
    status === 'break' ? reason : null,
    queueId,
    req.session.user.extensionName,
  );
  res.json({ status: 'ok' });
});

// --- Agent: does the call currently ringing them auto-answer, or should
// the browser show a real Accept/Reject popup? Set per-campaign by admin.
// Resolved from the agent's *current queue*, not by matching a specific
// calls row - auto_answer is a property of the campaign/queue, the same
// for whoever answers, so this needs no correlation to a particular call
// and can't race against AMI events telling us who picked up.
router.get('/agent/call-policy', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const asteriskName = await findCurrentQueueAsteriskName(req.session.user.id);
  if (!asteriskName) return res.json({ autoAnswer: false });
  const [rows] = await pool.query(
    `SELECT c.auto_answer FROM campaigns c JOIN queues q ON q.id = c.queue_id
     WHERE q.asterisk_name = ? LIMIT 1`,
    [asteriskName],
  );
  res.json({ autoAnswer: rows[0] ? !!rows[0].auto_answer : false });
});

// --- Queues (agent-visible list for the "pick a queue" popup) ---
// A queue only shows up here once some active campaign actually
// references it - an unassigned queue has no campaign context for an
// agent to be working under.
// Agents additionally only see campaigns mapped to one of their (active)
// teams - an agent in no team sees nothing, by design.
router.get('/queues', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') {
    const [rows] = await pool.query(`
      SELECT q.id, q.name, c.name AS campaign_name
      FROM queues q
      JOIN campaigns c ON c.queue_id = q.id
      WHERE q.status = 'active' AND c.status = 'active'
      ORDER BY c.name, q.name
    `);
    return res.json(rows);
  }
  res.json(await findAgentQueues(req.session.user.id));
});

// --- Agent: the dialer call they're on right now (screen pop, D7) ---
// The dialer's customer reaches the agent through Queue(), so the browser
// only sees "a call came in"; this tells it which lead it is.
router.get('/agent/active-call', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const [rows] = await pool.query(
    `
    SELECT c.id AS call_id, c.lead_id, l.name, COALESCE(l.phone, c.to_number) AS phone, l.alt_phone, l.status,
      l.attempts, l.custom_data, ls.name AS list_name,
      (c.from_extension = ?) AS owner, (c.dial_attempt_id IS NOT NULL) AS from_dialer
    FROM calls c
    LEFT JOIN leads l ON l.id = c.lead_id
    LEFT JOIN lists ls ON ls.id = l.list_id
    WHERE (c.from_extension = ? OR c.transfer_ext = ?) AND c.end_time IS NULL
      AND c.start_time > NOW() - INTERVAL 3 HOUR
    ORDER BY c.id DESC LIMIT 1
  `,
    [req.session.user.extensionName, req.session.user.extensionName, req.session.user.extensionName],
  );
  const row = rows[0];
  res.json(row ? { ...row, owner: !!Number(row.owner), from_dialer: !!Number(row.from_dialer) } : null);
});

// In-call panel: has the customer on the agent's click-to-call answered
// yet? (The agent's own leg answers first, so the browser can't tell.)
router.get('/agent/call-state/:callId', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT answer_time, end_time, disposition FROM calls WHERE id = ? AND from_extension = ?',
    [req.params.callId, req.session.user.extensionName],
  );
  if (!rows[0]) return res.status(404).json({ error: 'call not found' });
  // disposition says why it ended: ended | busy | no_answer | agent_unanswered | ...
  res.json({ answered: !!rows[0].answer_time, ended: !!rows[0].end_time, disposition: rows[0].disposition });
});

router.get('/agent/campaign-info', requireAuth, async (req, res) => {
  const c = await findCurrentCampaign(req.session.user.id);
  res.json(
    c ? { id: c.id, name: c.name, dialMode: c.dial_mode, wrapupSec: c.wrapup_sec, dialerState: c.dialer_state } : null,
  );
});

// --- Agent: dispositions + callbacks for the campaign they're working ---
router.get('/agent/dispositions', requireAuth, async (req, res) => {
  const campaign = await findCurrentCampaign(req.session.user.id);
  res.json(await getDispositions(campaign ? campaign.id : null));
});

router.get('/agent/stats', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const userId = req.session.user.id;

  // Login time: from the first status row logged today until now.
  const [loginRows] = await pool.query(
    `SELECT MIN(started_at) AS first_login FROM agent_status_log
     WHERE user_id = ? AND DATE(started_at) = CURDATE()`,
    [userId],
  );
  const loginSeconds = loginRows[0].first_login
    ? Math.floor((Date.now() - new Date(loginRows[0].first_login).getTime()) / 1000)
    : 0;

  async function sumSecondsForStatus(status) {
    const [rows] = await pool.query(
      `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS secs
       FROM agent_status_log
       WHERE user_id = ? AND status = ? AND DATE(started_at) = CURDATE()`,
      [userId, status],
    );
    // MySQL returns SUM()/COALESCE() results as strings via mysql2, not numbers.
    return Number(rows[0].secs);
  }

  const breakSeconds = await sumSecondsForStatus('break');
  const acwSeconds = await sumSecondsForStatus('acw');

  const [talkRows] = await pool.query(
    `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, answer_time, COALESCE(end_time, NOW()))), 0) AS secs
     FROM calls
     WHERE from_extension = ? AND answer_time IS NOT NULL AND DATE(start_time) = CURDATE()`,
    [req.session.user.extensionName],
  );
  const talkSeconds = Number(talkRows[0].secs);

  // The agent's real current status can change server-side (e.g. the
  // automatic ACW transition after a call ends) without the browser ever
  // being told - without this, the status pill goes stale and silently
  // disagrees with reality (shows "Available" while actually paused in
  // the real queue). Piggybacking on the stats poll keeps it in sync.
  const [currentRows] = await pool.query(
    `SELECT asl.status, asl.reason, q.name AS queue_name
     FROM agent_status_log asl
     LEFT JOIN queues q ON q.id = asl.queue_id
     WHERE asl.user_id = ? AND asl.ended_at IS NULL
     ORDER BY asl.id DESC LIMIT 1`,
    [userId],
  );
  const current = currentRows[0] || null;

  res.json({
    loginSeconds,
    talkSeconds,
    breakSeconds,
    acwSeconds,
    handleSeconds: talkSeconds + acwSeconds,
    currentStatus: current ? current.status : null,
    currentReason: current ? current.reason : null,
    currentQueueName: current ? current.queue_name : null,
  });
});

// --- Agent: the extensions they may connect with (null = any free one) ---
router.get('/agent/extensions', requireAuth, async (req, res) => {
  res.json({ allowed: await allowedExtensions(req.session.user) });
});

// --- Agent: SIP credentials for the browser to register a WebRTC line ---
// The extension an agent connects with is a per-session device choice
// (like picking a desk phone for a shift), limited to the ones their
// team allows (see services/extensionGuard.js).
router.get('/agent/extension-credentials/:extension', requireAuth, async (req, res) => {
  const allowed = await allowedExtensions(req.session.user);
  if (allowed && !allowed.includes(req.params.extension)) {
    return res
      .status(403)
      .json({ error: `Extension ${req.params.extension} isn't one your team may use - pick ${allowed.join(', ')}.` });
  }
  const [rows] = await pool.query('SELECT id, name, sip_password FROM extensions WHERE name = ?', [
    req.params.extension,
  ]);
  if (!rows[0] || !rows[0].sip_password) {
    return res.status(404).json({ error: 'unknown extension' });
  }
  const holder = await findOtherActiveHolder(rows[0].name, req.session.user.id);
  if (holder) {
    return res
      .status(409)
      .json({ error: `Extension ${rows[0].name} is in use by ${holder} right now - pick another one.` });
  }
  // This is the moment the agent commits to an extension for this session -
  // everything downstream (queue membership, click2call's fromExtension,
  // stats, live-agents display) reads this session field, so it must match
  // what they actually registered in the browser, not their login-assigned
  // extension (those two can differ - picking a device is a per-shift choice).
  req.session.user.extensionName = rows[0].name;
  req.session.user.extensionId = rows[0].id;
  res.json({ extension: rows[0].name, sipPassword: rows[0].sip_password });
});

// --- Agent: how the browser softphone reaches Asterisk (see services/webrtc.js) ---
router.get('/agent/webrtc-config', requireAuth, (req, res) => {
  res.json(buildWebrtcConfig(process.env, req.hostname, { userId: req.session.user.id }));
});

module.exports = router;
