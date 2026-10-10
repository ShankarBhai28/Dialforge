const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');
const { scopeCondition } = require('../services/access');
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
router.get('/admin/live-agents', requirePermission('live', 'view'), async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'agents', 'u.id');
  const [rows] = await pool.query(
    `
    SELECT
      u.id, u.username, e.name AS extension_name,
      asl.status, asl.reason, asl.started_at,
      q.name AS queue_name,
      (SELECT c.to_number FROM calls c WHERE c.from_extension = e.name AND c.end_time IS NULL ORDER BY c.id DESC LIMIT 1) AS active_call_number
    FROM users u
    LEFT JOIN extensions e ON u.extension_id = e.id
    LEFT JOIN agent_status_log asl ON asl.user_id = u.id AND asl.ended_at IS NULL
    LEFT JOIN queues q ON q.id = asl.queue_id
    WHERE u.role = 'agent'${cond ? ` AND ${cond}` : ''}
    ORDER BY u.username
  `,
    params,
  );
  res.json(rows);
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

module.exports = router;
