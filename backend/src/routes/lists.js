const express = require('express');
const pool = require('../../db');
const { requirePermission, requireAdminSide } = require('../middleware/auth');

const { campaignInScope, scopeCondition } = require('../services/access');

const router = express.Router();

// --- Admin: named lead lists within a campaign - a CSV import always
// targets one of these (a batch), not the campaign's flat lead pool
// directly, so admins can tell "Jan cold list" apart from "referrals". ---
router.get('/admin/lists', requireAdminSide, async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'campaigns', 'ls.campaign_id');
  const [rows] = await pool.query(
    `
    SELECT ls.*, c.name AS campaign_name,
      (SELECT COUNT(*) FROM leads WHERE leads.list_id = ls.id) AS lead_count,
      (SELECT COUNT(*) FROM leads WHERE leads.list_id = ls.id AND leads.is_final = 0
         AND leads.attempts < COALESCE(c.max_attempts, 3)
         AND (leads.next_call_at IS NULL OR leads.next_call_at <= NOW())) AS dialable_count
    FROM lists ls
    LEFT JOIN campaigns c ON c.id = ls.campaign_id
    ${cond ? `WHERE ${cond}` : ''}
    ORDER BY ls.id DESC
  `,
    params,
  );
  res.json(rows);
});

// A list must belong to a real campaign (the FK would otherwise give a raw 500).
// ...and, for a team-scoped role, to one of its teams' campaigns.
async function campaignExists(id, scope) {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [id]);
  return !!rows[0] && campaignInScope(scope, rows[0].id);
}

// is_active decides whether the dialer takes leads from a list;
// priority orders lists within a campaign (higher first).
function parseListPriority(v) {
  const n = v === undefined || v === '' ? 0 : Number(v);
  return Number.isInteger(n) && n >= -100 && n <= 100 ? n : null;
}

router.post('/admin/lists', requirePermission('leads', 'manage'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  if (!(await campaignExists(campaignId, req.access.scope)))
    return res.status(400).json({ error: 'campaign not found' });
  const [result] = await pool.query(
    'INSERT INTO lists (tenant_id, campaign_id, name, is_active, priority) VALUES (1, ?, ?, ?, ?)',
    [campaignId, name, isActive === false ? 0 : 1, priority],
  );
  res.status(201).json({ id: result.insertId, name, campaignId });
});

router.put('/admin/lists/:id', requirePermission('leads', 'manage'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  if (!(await campaignExists(campaignId, req.access.scope)))
    return res.status(400).json({ error: 'campaign not found' });
  const [rows] = await pool.query('SELECT id, campaign_id FROM lists WHERE id = ?', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'list not found' });
  await pool.query('UPDATE lists SET name = ?, campaign_id = ?, is_active = ?, priority = ? WHERE id = ?', [
    name,
    campaignId,
    isActive === false ? 0 : 1,
    priority,
    req.params.id,
  ]);
  res.json({ id: Number(req.params.id), name, campaignId });
});

router.delete('/admin/lists/:id', requirePermission('leads', 'manage'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, campaign_id FROM lists WHERE id = ?', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'list not found' });
  const [leadRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM leads WHERE list_id = ?', [req.params.id]);
  if (leadRefs[0].cnt > 0) {
    return res.status(409).json({
      error: `Cannot delete - ${leadRefs[0].cnt} lead(s) still belong to this list. Reassign or remove them first.`,
    });
  }
  await pool.query('DELETE FROM lists WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

module.exports = router;
