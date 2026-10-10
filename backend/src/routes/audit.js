const express = require('express');
const pool = require('../../db');
const { requirePermission } = require('../middleware/auth');
const { likeTerm, pageResult, parsePaging, whereClause } = require('../services/paging');

const router = express.Router();

// --- Audit log: who changed what, when (written by services/audit.js) ---
// ?q= (username) &action= (exact or prefix like "campaigns.") &entity= &entityId=
// &from= &to= (YYYY-MM-DD) &failed=1 (refused / failed requests only) &page= &pageSize=
router.get('/admin/audit', requirePermission('audit', 'view'), async (req, res) => {
  const paging = parsePaging(req.query);
  const { q, action, entity, entityId, from, to, failed } = req.query;
  const where = whereClause([
    [q ? 'username LIKE ?' : '', [likeTerm(String(q || '').trim())]],
    [
      action ? (String(action).endsWith('.') ? 'action LIKE ?' : 'action = ?') : '',
      [String(action || '').endsWith('.') ? likeTerm(action).slice(1) : action],
    ],
    [entity ? 'entity = ?' : '', [entity]],
    [entityId ? 'entity_id = ?' : '', [entityId]],
    [from ? 'at >= ?' : '', [from]],
    [to ? 'at < DATE_ADD(?, INTERVAL 1 DAY)' : '', [to]],
    [failed === '1' ? 'status >= 400' : '', []],
  ]);
  const [rows] = await pool.query(`SELECT * FROM audit_log ${where.sql} ORDER BY id DESC LIMIT ? OFFSET ?`, [
    ...where.params,
    paging.pageSize,
    paging.offset,
  ]);
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM audit_log ${where.sql}`, where.params);
  // For the filters: the actions and kinds of record that occur.
  const [actions] = await pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action');
  const [entities] = await pool.query('SELECT DISTINCT entity FROM audit_log WHERE entity IS NOT NULL ORDER BY entity');
  res.json({
    ...pageResult(rows, count.n, paging),
    actions: actions.map((r) => r.action),
    entities: entities.map((r) => r.entity),
  });
});

module.exports = router;
