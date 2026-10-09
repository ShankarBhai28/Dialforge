const express = require('express');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// --- Admin: dialer control + live view (the engine itself is the
// separate dialer-engine.js process; these only flip state / read status) ---
router.post('/admin/campaigns/:id/dialer', requireRole('admin'), async (req, res) => {
  const { action } = req.body;
  const [rows] = await pool.query('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  const next = { start: 'running', pause: 'paused', stop: 'stopped' }[action];
  if (!next) return res.status(400).json({ error: 'action must be start, pause or stop' });
  if (action === 'start') {
    if (c.dial_mode === 'manual')
      return res.status(400).json({ error: 'set a dial mode other than Manual first (Campaigns → Edit)' });
    if (c.status !== 'active') return res.status(400).json({ error: 'campaign status must be Active' });
    if (!c.queue_id) return res.status(400).json({ error: 'campaign needs a queue' });
  }
  if (action === 'pause' && c.dialer_state !== 'running')
    return res.status(400).json({ error: 'only a running campaign can be paused' });
  await pool.query(
    'UPDATE campaigns SET dialer_state = ?, dialer_state_changed_at = NOW(), dialer_state_changed_by = ? WHERE id = ?',
    [next, req.session.user.id, c.id],
  );
  res.json({ status: 'ok', dialerState: next });
});

router.get('/admin/dialer', requireRole('admin'), async (req, res) => {
  // Row 0 is the engine's heartbeat: no tick for 15s+ means it's down.
  const [engineRows] = await pool.query(
    'SELECT note AS engine_id, last_tick_at, TIMESTAMPDIFF(SECOND, last_tick_at, NOW()) AS age_sec FROM dialer_status WHERE campaign_id = 0',
  );
  const engine = engineRows[0];
  const [campaigns] = await pool.query(`
    SELECT c.id, c.name, c.status, c.dial_mode, c.dial_ratio, c.max_dial_ratio, c.dialer_state, c.dialer_state_changed_at,
      u.username AS changed_by, q.name AS queue_name,
      s.hopper_ready, s.hopper_locked, s.idle_agents, s.would_dial, s.in_flight, s.active_calls, s.note, s.last_tick_at,
      s.current_ratio, s.answer_rate, s.abandon_pct, s.ratio_adjust, s.pacing_note
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN users u ON u.id = c.dialer_state_changed_by
    LEFT JOIN dialer_status s ON s.campaign_id = c.id
    ORDER BY c.dialer_state = 'running' DESC, c.dialer_state = 'paused' DESC, c.name
  `);
  // Today = since midnight in India (server clock is UTC).
  const [stats] = await pool.query(`
    SELECT campaign_id, COUNT(*) AS attempts,
      SUM(answered_at IS NOT NULL) AS answered,
      SUM(result = 'connected') AS connected,
      SUM(result = 'abandoned' OR result = 'customer_hangup') AS abandoned,
      SUM(result IN ('no_answer', 'busy', 'congestion', 'failed', 'invalid')) AS not_reached,
      SUM(result = 'machine') AS machine
    FROM dial_attempts
    WHERE started_at >= CONVERT_TZ(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')), '+05:30', '+00:00')
    GROUP BY campaign_id
  `);
  res.json({
    engine: engine ? { ...engine, alive: engine.age_sec <= 15 } : { alive: false },
    campaigns: campaigns.map((c) => ({ ...c, today: stats.find((x) => x.campaign_id === c.id) || null })),
  });
});

router.get('/admin/campaigns/:id/hopper', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `
    SELECT h.*, l.name, ls.name AS list_name, u.username AS reserved_for
    FROM dial_hopper h
    JOIN leads l ON l.id = h.lead_id
    LEFT JOIN lists ls ON ls.id = h.list_id
    LEFT JOIN users u ON u.id = h.reserved_user_id
    WHERE h.campaign_id = ?
    ORDER BY h.status = 'locked' DESC, h.is_callback DESC, h.list_priority DESC, h.lead_priority DESC, h.attempts, h.lead_id
    LIMIT 200
  `,
    [req.params.id],
  );
  res.json(rows);
});

module.exports = router;
