const express = require('express');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');
const { dialerOverview } = require('../services/dialer');
const dialerFeed = require('../realtime/dialerFeed');

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
  dialerFeed.check({ force: true }); // every open Dialer screen shows it now, not at its next refresh
  res.json({ status: 'ok', dialerState: next });
});

router.get('/admin/dialer', requireRole('admin'), async (req, res) => {
  res.json(await dialerOverview());
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
