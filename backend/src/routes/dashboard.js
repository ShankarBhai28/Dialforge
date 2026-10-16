const express = require('express');
const { floorSummary, liveAgents } = require('../services/liveFloor');
const pool = require('../../db');
const { requireAdminSide, requirePermission, requireRole } = require('../middleware/auth');
const { collectHealth } = require('../services/health');
const { can, scopeCondition } = require('../services/access');
const { MonitorError, MODES, monitoringExtension, startMonitor } = require('../services/monitor');
const { findOtherActiveHolder } = require('../services/extensionGuard');
const { buildWebrtcConfig } = require('../services/webrtc');
const { onActiveCall, openStatus, takeOffline } = require('../services/agentLogout');
const { revokeUserSessions } = require('../services/sessions');
const { whereClause } = require('../services/paging');

const router = express.Router();

// --- Admin: dashboard summary ---
// A team-scoped role counts only its teams' agents and campaigns' calls.
router.get('/admin/dashboard', requirePermission('dashboard', 'view'), async (req, res) => {
  const { scope } = req.access;
  const agents = whereClause([["role = 'agent'", []], scopeCondition(scope, 'agents', 'id')]);
  const [[agentCount]] = await pool.query(`SELECT COUNT(*) AS c FROM users ${agents.sql}`, agents.params);
  const avail = whereClause([
    ["ended_at IS NULL AND status = 'available'", []],
    scopeCondition(scope, 'agents', 'user_id'),
  ]);
  const [[availableCount]] = await pool.query(`SELECT COUNT(*) AS c FROM agent_status_log ${avail.sql}`, avail.params);
  const today = whereClause([['DATE(start_time) = CURDATE()', []], scopeCondition(scope, 'campaigns', 'campaign_id')]);
  const [[callsToday]] = await pool.query(`SELECT COUNT(*) AS c FROM calls ${today.sql}`, today.params);
  const [[avgHandle]] = await pool.query(
    `SELECT COALESCE(AVG(TIMESTAMPDIFF(SECOND, answer_time, end_time)), 0) AS secs
     FROM calls ${today.sql} AND answer_time IS NOT NULL AND end_time IS NOT NULL`,
    today.params,
  );
  res.json({
    totalAgents: agentCount.c,
    availableNow: availableCount.c,
    callsToday: callsToday.c,
    avgHandleSeconds: Math.round(Number(avgHandle.secs)),
  });
});

// --- Admin: real-time live agent status ---
// Each agent with campaign, team, line, login time, current call and today's
// numbers (services/liveFloor.js); the summary = callers waiting + today's totals.
router.get('/admin/live-agents', requirePermission('live', 'view'), async (req, res) => {
  res.json(await liveAgents(req.access.scope));
});

router.get('/admin/live-agents/summary', requirePermission('live', 'view'), async (req, res) => {
  res.json(await floorSummary(req.access.scope));
});

// --- Force logout: a supervisor takes a stuck or absent agent offline ---
// Same as the agent logging out (queue left, status closed), and their
// login ends so the browser goes back to the login page. Not during a call.
router.post('/admin/live-agents/:id/logout', requirePermission('live', 'logout'), async (req, res) => {
  const [rows] = await pool.query("SELECT id, username FROM users WHERE id = ? AND role = 'agent'", [req.params.id]);
  const agent = rows[0];
  const { scope } = req.access;
  if (!agent || (scope && !scope.agentIds.includes(agent.id))) {
    return res.status(404).json({ error: 'agent not found' });
  }
  const open = await openStatus(agent.id);
  if (open && (await onActiveCall(open.extension_name))) {
    return res.status(409).json({ error: `${agent.username} is on a call right now - try again when it ends` });
  }
  if (open) await takeOffline(agent.id, open.extension_name);
  revokeUserSessions(agent.id);
  res.json({ id: agent.id, status: 'ok', was: open ? open.status : 'offline' });
});

// --- System health (Super Admin): the same checks the minute-by-minute
// watch alerts on (services/health.js) ---
router.get('/admin/system/health', requireRole('admin'), async (req, res) => {
  res.json(await collectHealth());
});

// --- Call monitoring (listen / whisper / barge) - see services/monitor.js ---
const canMonitor = (access) => MODES.some((m) => can(access, 'live', m));

// The supervisor's monitoring line: how their browser connects (same as an
// agent's line, but with the extension given to this admin login in Users).
router.get('/admin/monitor/line', requireAdminSide, async (req, res) => {
  if (!canMonitor(req.access)) return res.status(403).json({ error: "Your role doesn't allow call monitoring" });
  const line = await monitoringExtension(req.session.user.id);
  if (!line || !line.sip_password) {
    return res
      .status(409)
      .json({ error: 'You have no monitoring line - ask a Super Admin to give you an extension (Users).' });
  }
  const holder = await findOtherActiveHolder(line.name, req.session.user.id);
  if (holder) return res.status(409).json({ error: `Extension ${line.name} is in use by ${holder} right now.` });
  res.json({
    extension: line.name,
    sipPassword: line.sip_password,
    ...buildWebrtcConfig(process.env, req.hostname, { userId: req.session.user.id }),
  });
});

router.post('/admin/live-agents/:id/monitor', requireAdminSide, async (req, res) => {
  const mode = req.body && req.body.mode;
  if (MODES.includes(mode) && !can(req.access, 'live', mode)) {
    return res
      .status(403)
      .json({ error: `Your role doesn't allow: Live Agents - ${mode[0].toUpperCase()}${mode.slice(1)}` });
  }
  try {
    const started = await startMonitor({
      supervisorId: req.session.user.id,
      agentId: Number(req.params.id),
      mode,
      scope: req.access.scope,
    });
    res.json({ status: 'ringing', ...started });
  } catch (err) {
    if (err instanceof MonitorError) return res.status(err.status).json({ error: err.message });
    console.error('[monitor]', err);
    res.status(500).json({ error: 'could not start monitoring: ' + err.message });
  }
});

module.exports = router;
