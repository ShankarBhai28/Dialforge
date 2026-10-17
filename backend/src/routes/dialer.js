const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');
const { dialerOverview, scopeOverview } = require('../services/dialer');
const dialerFeed = require('../realtime/dialerFeed');

const { campaignInScope } = require('../services/access');
const { audit } = require('../services/audit');
const { dialerLive, hangupAttempt, HangupError } = require('../services/dialerLive');

const router = express.Router();

// --- Admin: dialer control + live view (the engine itself is the
// separate dialer-engine.js process; these only flip state / read status) ---
router.post('/admin/campaigns/:id/dialer', requirePermission('dialer', 'control'), async (req, res) => {
  const { action } = req.body;
  const [rows] = await pool.query('SELECT * FROM campaigns WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  const c = rows[0];
  if (!c || !campaignInScope(req.access.scope, c.id)) return res.status(404).json({ error: 'campaign not found' });
  const next = { start: 'running', pause: 'paused', stop: 'stopped' }[action];
  if (!next) return res.status(400).json({ error: 'action must be start, pause or stop' });
  if (action === 'start') {
    if (c.dial_mode === 'manual' || c.dial_mode === 'inbound')
      return res.status(400).json({
        error: `${c.dial_mode === 'inbound' ? 'an Inbound' : 'a Manual'} campaign doesn't use the dialer - set Preview, Progressive or Predictive first (Campaigns → Edit)`,
      });
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

router.get('/admin/dialer', requirePermission('dialer', 'view'), async (req, res) => {
  res.json(scopeOverview(await dialerOverview(), req.access.scope));
});

router.get('/admin/campaigns/:id/hopper', requirePermission('dialer', 'view'), async (req, res) => {
  if (!campaignInScope(req.access.scope, req.params.id)) return res.status(404).json({ error: 'campaign not found' });
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

// --- Live calls of a campaign (Dialer screen; polled while open) ---
router.get('/admin/campaigns/:id/dialer-live', requirePermission('dialer', 'view'), async (req, res) => {
  if (!campaignInScope(req.access.scope, req.params.id)) return res.status(404).json({ error: 'campaign not found' });
  res.json(await dialerLive(Number(req.params.id)));
});

// --- A supervisor hangs up one live dialer call (right: Dialer -> Hang up live calls) ---
router.post('/admin/dialer/attempts/:id/hangup', requirePermission('dialer', 'hangup'), async (req, res) => {
  try {
    const r = await hangupAttempt(Number(req.params.id), {
      user: req.session.user,
      inScope: (id) => campaignInScope(req.access.scope, id),
    });
    void audit({
      user: req.session.user,
      action: 'dialer.hangup',
      entity: 'dial_attempts',
      entityId: r.id,
      status: 200,
      summary: `hung up while ${r.was}`,
      ip: req.ip,
    });
    dialerFeed.check({ force: true });
    res.json({ status: 'ok', ...r });
  } catch (err) {
    if (err instanceof HangupError) return res.status(err.status).json({ error: err.message });
    console.error('[dialer hangup]', err);
    res.status(500).json({ error: 'could not hang up' });
  }
});

module.exports = router;
