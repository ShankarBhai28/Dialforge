const express = require('express');
const { deleteList } = require('../services/softDelete');
const { deletedLists, restoreList, RestoreError } = require('../services/restore');
const pool = require('../../db');
const { getDispositions } = require('../services/dispositions');
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
      (SELECT COUNT(*) FROM leads WHERE leads.list_id = ls.id AND leads.deleted_at IS NULL) AS lead_count,
      (SELECT COUNT(*) FROM leads WHERE leads.list_id = ls.id AND leads.deleted_at IS NULL AND leads.is_final = 0
         AND leads.attempts < COALESCE(c.max_attempts, 3)
         AND (leads.next_call_at IS NULL OR leads.next_call_at <= NOW())) AS dialable_count
    FROM lists ls
    LEFT JOIN campaigns c ON c.id = ls.campaign_id
    WHERE ls.deleted_at IS NULL${cond ? ` AND ${cond}` : ''}
    ORDER BY ls.id DESC
  `,
    params,
  );
  res.json(rows);
});

// A list must belong to a real campaign (the FK would otherwise give a raw 500).
// ...and, for a team-scoped role, to one of its teams' campaigns.
async function campaignExists(id, scope) {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL', [id]);
  return !!rows[0] && campaignInScope(scope, rows[0].id);
}

// is_active decides whether the dialer takes leads from a list;
// priority orders lists within a campaign (higher first).
/** The list's source / note (where its leads came from): trimmed, max 200, '' = none. */
const parseSource = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 200));

function parseListPriority(v) {
  const n = v === undefined || v === '' ? 0 : Number(v);
  return Number.isInteger(n) && n >= -100 && n <= 100 ? n : null;
}

router.post('/admin/lists', requirePermission('leads', 'create'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  if (!(await campaignExists(campaignId, req.access.scope)))
    return res.status(400).json({ error: 'campaign not found' });
  const [result] = await pool.query(
    'INSERT INTO lists (tenant_id, campaign_id, name, is_active, priority, source) VALUES (1, ?, ?, ?, ?, ?)',
    [campaignId, name, isActive === false ? 0 : 1, priority, parseSource(req.body.source)],
  );
  res.status(201).json({ id: result.insertId, name, campaignId });
});

router.put('/admin/lists/:id', requirePermission('leads', 'edit'), async (req, res) => {
  const { name, campaignId, isActive } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  const priority = parseListPriority(req.body.priority);
  if (priority === null) return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  if (!(await campaignExists(campaignId, req.access.scope)))
    return res.status(400).json({ error: 'campaign not found' });
  const [rows] = await pool.query('SELECT id, campaign_id FROM lists WHERE id = ? AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'list not found' });
  // source left out = unchanged.
  const source = req.body.source === undefined ? undefined : parseSource(req.body.source);
  const moving = Number(campaignId) !== rows[0].campaign_id;
  const conn = await pool.getConnection();
  let moved = 0;
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE lists SET name = ?, campaign_id = ?, is_active = ?, priority = ?${source === undefined ? '' : ', source = ?'} WHERE id = ?`,
      [
        name,
        campaignId,
        isActive === false ? 0 : 1,
        priority,
        ...(source === undefined ? [] : [source]),
        req.params.id,
      ],
    );
    if (moving) {
      // A list's leads belong to the list's campaign (the dialer takes them by
      // campaign): they move with it, with their status and history; pending
      // callbacks follow; waiting hopper rows of the old campaign go.
      const [r] = await conn.query('UPDATE leads SET campaign_id = ? WHERE list_id = ? AND deleted_at IS NULL', [
        campaignId,
        req.params.id,
      ]);
      moved = r.affectedRows;
      await conn.query(
        `UPDATE callbacks SET campaign_id = ? WHERE status = 'pending'
         AND lead_id IN (SELECT id FROM leads WHERE list_id = ? AND deleted_at IS NULL)`,
        [campaignId, req.params.id],
      );
      await conn.query(
        `DELETE FROM dial_hopper WHERE status = 'ready' AND lead_id IN (SELECT id FROM leads WHERE list_id = ?)`,
        [req.params.id],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({
    id: Number(req.params.id),
    name,
    campaignId,
    notes: moving ? [`${moved} lead${moved === 1 ? '' : 's'} moved to the new campaign with the list`] : [],
  });
});

// --- One list in numbers (Lists -> click a list): how far it got, how it
// performed, and every upload into it.
router.get('/admin/lists/:id/stats', requirePermission('leads', 'view'), async (req, res) => {
  const [[list]] = await pool.query(
    `SELECT ls.id, ls.name, ls.source, ls.is_active, ls.campaign_id, ls.created_at, c.name AS campaign,
            COALESCE(c.max_attempts, 3) AS max_attempts
     FROM lists ls LEFT JOIN campaigns c ON c.id = ls.campaign_id WHERE ls.id = ? AND ls.deleted_at IS NULL`,
    [req.params.id],
  );
  if (!list || !campaignInScope(req.access.scope, list.campaign_id))
    return res.status(404).json({ error: 'list not found' });
  const dispositions = await getDispositions(list.campaign_id);
  const success = dispositions.filter((d) => d.is_success).map((d) => d.code);
  const max = Number(list.max_attempts);
  const [[l]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(attempts = 0) AS fresh, SUM(attempts > 0) AS called,
       SUM(is_final = 0 AND attempts < ? AND (next_call_at IS NULL OR next_call_at <= NOW())) AS dialable,
       SUM(is_final = 0 AND attempts < ? AND next_call_at > NOW()) AS scheduled,
       SUM(is_final = 1 OR attempts >= ?) AS done,
       SUM(status IN (?)) AS success,
       SUM(status = 'do_not_call') AS dnc
     FROM leads WHERE list_id = ? AND deleted_at IS NULL`,
    [max, max, max, success.length ? success : [''], list.id],
  );
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS calls, SUM(ca.agent_connect_time IS NOT NULL) AS connected,
       COUNT(DISTINCT IF(ca.agent_connect_time IS NOT NULL, ca.lead_id, NULL)) AS reached,
       SUM(IF(ca.agent_connect_time IS NULL, 0, GREATEST(TIMESTAMPDIFF(SECOND, ca.agent_connect_time, COALESCE(ca.end_time, ca.agent_connect_time)), 0))) AS talk_seconds,
       MAX(ca.start_time) AS last_call_at
     FROM calls ca JOIN leads l ON l.id = ca.lead_id WHERE l.list_id = ? AND l.deleted_at IS NULL`,
    [list.id],
  );
  const [byStatus] = await pool.query(
    'SELECT status, COUNT(*) AS n FROM leads WHERE list_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY n DESC',
    [list.id],
  );
  const [imports] = await pool.query(
    `SELECT i.id, i.file_name, i.total, i.imported, i.updated, i.skipped, i.duplicate_check, i.on_duplicate, i.created_at,
            u.username
     FROM list_imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.list_id = ? ORDER BY i.id DESC LIMIT 50`,
    [list.id],
  );
  const n = (v) => Number(v || 0);
  const labels = Object.fromEntries(dispositions.map((d) => [d.code, d.label]));
  res.json({
    list: {
      id: list.id,
      name: list.name,
      source: list.source,
      campaign: list.campaign,
      active: !!list.is_active,
      createdAt: list.created_at,
      maxAttempts: max,
    },
    leads: {
      total: n(l.total),
      fresh: n(l.fresh),
      called: n(l.called),
      reached: n(c.reached),
      success: n(l.success),
      dialable: n(l.dialable),
      scheduled: n(l.scheduled),
      done: n(l.done),
      dnc: n(l.dnc),
    },
    calls: { total: n(c.calls), connected: n(c.connected), talkSeconds: n(c.talk_seconds), lastCallAt: c.last_call_at },
    byStatus: byStatus.map((s) => ({
      status: s.status,
      label: labels[s.status] || null,
      count: n(s.n),
      success: success.includes(s.status),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      fileName: i.file_name,
      total: i.total,
      imported: i.imported,
      updated: i.updated,
      skipped: i.skipped,
      duplicateCheck: i.duplicate_check,
      onDuplicate: i.on_duplicate,
      at: i.created_at,
      by: i.username,
    })),
  });
});

// Delete always works and keeps history: its leads go with it.
router.delete('/admin/lists/:id', requirePermission('leads', 'delete'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, campaign_id FROM lists WHERE id = ? AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id)) {
    return res.status(404).json({ error: 'list not found' });
  }
  const notes = await deleteList(Number(req.params.id), req.session.user.id);
  if (notes === null) return res.status(404).json({ error: 'list not found' });
  res.json({ status: 'ok', notes });
});

// --- Deleted lists + Restore (services/restore.js) ---
router.get('/admin/lists/deleted', requirePermission('leads', 'view'), async (req, res) => {
  res.json(await deletedLists((id) => campaignInScope(req.access.scope, id)));
});

router.post('/admin/lists/:id/restore', requirePermission('leads', 'delete'), async (req, res) => {
  try {
    const r = await restoreList(Number(req.params.id), { inScope: (id) => campaignInScope(req.access.scope, id) });
    const notes = [`${r.restored} lead${r.restored === 1 ? '' : 's'} restored`];
    if (r.skipped) notes.push(`${r.skipped} kept deleted - the number is an active lead in the campaign again`);
    notes.push('the list is inactive - switch it on when it should be dialed');
    res.json({ status: 'ok', ...r, notes });
  } catch (err) {
    if (err instanceof RestoreError) return res.status(err.status).json({ error: err.message });
    console.error('[list restore]', err);
    res.status(500).json({ error: 'could not restore the list' });
  }
});

module.exports = router;
