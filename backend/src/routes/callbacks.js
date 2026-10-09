const express = require('express');
const pool = require('../../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');

const router = express.Router();

// Pending callbacks the agent should see: their own, plus "anyone"
// callbacks in the campaign they're currently working.
router.get('/agent/callbacks', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  const [rows] = await pool.query(
    `
    SELECT cb.id, cb.lead_id, cb.callback_at, cb.note, cb.user_id, l.name, l.phone, c.name AS campaign_name
    FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    WHERE cb.status = 'pending'
      AND (cb.user_id = ? OR (cb.user_id IS NULL AND cb.campaign_id = ?))
    ORDER BY cb.callback_at
    LIMIT 100
  `,
    [req.session.user.id, campaign ? campaign.id : -1],
  );
  res.json(rows);
});

router.get('/admin/callbacks', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT cb.id, cb.callback_at, cb.status, cb.note, l.name, l.phone, c.name AS campaign_name,
      u.username AS assigned_to, cu.username AS created_by_name
    FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    LEFT JOIN users u ON u.id = cb.user_id
    JOIN users cu ON cu.id = cb.created_by
    ORDER BY cb.status = 'pending' DESC, cb.callback_at
    LIMIT 300
  `);
  res.json(rows);
});

router.post('/admin/callbacks/:id/cancel', requireRole('admin'), async (req, res) => {
  const [result] = await pool.query("UPDATE callbacks SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [
    req.params.id,
  ]);
  if (!result.affectedRows) return res.status(404).json({ error: 'no pending callback with that id' });
  res.json({ status: 'ok' });
});

module.exports = router;
