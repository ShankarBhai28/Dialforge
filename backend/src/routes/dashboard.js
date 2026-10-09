const express = require('express');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// --- Admin: dashboard summary ---
router.get('/admin/dashboard', requireRole('admin'), async (req, res) => {
  const [[agentCount]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'agent'");
  const [[availableCount]] = await pool.query(
    `SELECT COUNT(*) AS c FROM agent_status_log
     WHERE ended_at IS NULL AND status = 'available'`,
  );
  const [[callsToday]] = await pool.query('SELECT COUNT(*) AS c FROM calls WHERE DATE(start_time) = CURDATE()');
  const [[avgHandle]] = await pool.query(
    `SELECT COALESCE(AVG(TIMESTAMPDIFF(SECOND, answer_time, end_time)), 0) AS secs
     FROM calls WHERE DATE(start_time) = CURDATE() AND answer_time IS NOT NULL AND end_time IS NOT NULL`,
  );
  res.json({
    totalAgents: agentCount.c,
    availableNow: availableCount.c,
    callsToday: callsToday.c,
    avgHandleSeconds: Math.round(Number(avgHandle.secs)),
  });
});

// --- Admin: real-time live agent status ---
router.get('/admin/live-agents', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      u.id, u.username, e.name AS extension_name,
      asl.status, asl.reason, asl.started_at,
      q.name AS queue_name,
      (SELECT c.to_number FROM calls c WHERE c.from_extension = e.name AND c.end_time IS NULL ORDER BY c.id DESC LIMIT 1) AS active_call_number
    FROM users u
    LEFT JOIN extensions e ON u.extension_id = e.id
    LEFT JOIN agent_status_log asl ON asl.user_id = u.id AND asl.ended_at IS NULL
    LEFT JOIN queues q ON q.id = asl.queue_id
    WHERE u.role = 'agent'
    ORDER BY u.username
  `);
  res.json(rows);
});

module.exports = router;
