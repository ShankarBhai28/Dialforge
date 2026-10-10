const express = require('express');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { requirePermission } = require('../middleware/auth');
const { addDnc } = require('../services/dnc');

const { likeTerm, pageResult, parsePaging, whereClause } = require('../services/paging');

const router = express.Router();

// --- Admin: DNC list ---
router.get('/admin/dnc', requirePermission('dnc', 'view'), async (req, res) => {
  // total = every number on the list; matching = after the search (paged).
  const paging = parsePaging(req.query);
  const q = normalizePhone(req.query.q || '');
  const where = whereClause([
    ['d.tenant_id = 1', []],
    [q ? 'd.phone LIKE ?' : '', [likeTerm(q)]],
  ]);
  const [rows] = await pool.query(
    `SELECT d.id, d.phone, d.source, d.created_at, u.username AS created_by_name
     FROM dnc_numbers d LEFT JOIN users u ON u.id = d.created_by
     ${where.sql}
     ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    [...where.params, paging.pageSize, paging.offset],
  );
  const [[matching]] = await pool.query(`SELECT COUNT(*) AS n FROM dnc_numbers d ${where.sql}`, where.params);
  const [[all]] = await pool.query('SELECT COUNT(*) AS n FROM dnc_numbers WHERE tenant_id = 1');
  res.json({ ...pageResult(rows, matching.n, paging), all: Number(all.n) });
});

// Bulk add: one number per line (or comma-separated).
router.post('/admin/dnc', requirePermission('dnc', 'create'), async (req, res) => {
  const entries = String(req.body.phones || '')
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (entries.length === 0) return res.status(400).json({ error: 'enter at least one number' });
  if (entries.length > 5000) return res.status(400).json({ error: 'max 5000 numbers per add' });
  let added = 0;
  let existing = 0;
  let invalid = 0;
  for (const p of entries) {
    const n = normalizePhone(p);
    if (n.length < 3 || n.length > 15) {
      invalid++;
      continue;
    }
    if (await addDnc(n, 'manual', req.session.user.id)) added++;
    else existing++;
  }
  res.json({ added, existing, invalid });
});

router.delete('/admin/dnc/:id', requirePermission('dnc', 'delete'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM dnc_numbers WHERE id = ? AND tenant_id = 1', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'not found' });
  res.json({ status: 'ok' });
});

module.exports = router;
