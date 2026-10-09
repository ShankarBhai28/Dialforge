const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

// --- Admin: DID numbers, mapped to a campaign (this is what makes
// inbound routing actually DID-aware instead of guessing) ---
router.get('/admin/dids', requirePermission('numbers', 'view'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT d.id, d.number, d.campaign_id, c.name AS campaign_name
    FROM dids d
    LEFT JOIN campaigns c ON c.id = d.campaign_id
    ORDER BY d.id DESC
  `);
  res.json(rows);
});

router.post('/admin/dids', requirePermission('numbers', 'manage'), async (req, res) => {
  const { number, campaignId } = req.body;
  if (!number) return res.status(400).json({ error: 'number is required' });
  // Upsert - reassigning an existing DID to a different campaign is just
  // as valid a thing to do here as creating a brand new one.
  await pool.query(
    `INSERT INTO dids (tenant_id, number, campaign_id) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE campaign_id = VALUES(campaign_id)`,
    [number, campaignId || null],
  );
  res.status(201).json({ number, campaignId: campaignId || null });
});

router.put('/admin/dids/:id', requirePermission('numbers', 'manage'), async (req, res) => {
  const { campaignId } = req.body;
  const [rows] = await pool.query('SELECT id FROM dids WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'DID not found' });
  await pool.query('UPDATE dids SET campaign_id = ? WHERE id = ?', [campaignId || null, req.params.id]);
  res.json({ id: Number(req.params.id), campaignId: campaignId || null });
});

router.delete('/admin/dids/:id', requirePermission('numbers', 'manage'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM dids WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'DID not found' });
  res.json({ status: 'ok' });
});

module.exports = router;
