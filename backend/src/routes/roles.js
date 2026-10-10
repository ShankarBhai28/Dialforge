const express = require('express');
const pool = require('../../db');
const { requireRole, requireAdminSide } = require('../middleware/auth');
const { ACTION_LABELS, SCREENS, TEAM_SCOPE_BLOCKED, forgetRoles, parseRole, toRole } = require('../services/access');
const hub = require('../realtime/hub');

const router = express.Router();

// --- Admin roles (Team Leader, Supervisor, ...): Super Admin only. ---
// GET also lists the screens with their actions, so the roles editor never
// hard-codes them, and which actions an own-teams role can't have.
router.get('/admin/roles', requireAdminSide, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
     FROM roles r ORDER BY r.name`,
  );
  res.json({
    screens: SCREENS,
    actionLabels: ACTION_LABELS,
    teamScopeBlocked: TEAM_SCOPE_BLOCKED,
    roles: rows.map((r) => ({ ...toRole(r), userCount: Number(r.user_count) })),
  });
});

// A role's rights apply on its users' very next request (the cache is
// cleared); live updates they receive are re-checked too.
function rolesChanged() {
  forgetRoles();
  hub.refreshAccess();
}

router.post('/admin/roles', requireRole('admin'), async (req, res) => {
  const { error, role } = parseRole(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const [result] = await pool.query('INSERT INTO roles (tenant_id, name, scope, permissions) VALUES (1, ?, ?, ?)', [
      role.name,
      role.scope,
      JSON.stringify(role.permissions),
    ]);
    rolesChanged();
    res.status(201).json({ id: result.insertId, ...role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a role with that name already exists' });
    throw err;
  }
});

router.put('/admin/roles/:id', requireRole('admin'), async (req, res) => {
  const { error, role } = parseRole(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const [result] = await pool.query('UPDATE roles SET name = ?, scope = ?, permissions = ? WHERE id = ?', [
      role.name,
      role.scope,
      JSON.stringify(role.permissions),
      req.params.id,
    ]);
    if (!result.affectedRows) return res.status(404).json({ error: 'role not found' });
    rolesChanged();
    res.json({ id: Number(req.params.id), ...role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a role with that name already exists' });
    throw err;
  }
});

router.delete('/admin/roles/:id', requireRole('admin'), async (req, res) => {
  const [users] = await pool.query('SELECT username FROM users WHERE role_id = ? ORDER BY username', [req.params.id]);
  if (users.length) {
    return res.status(409).json({
      error: `Cannot delete - ${users.map((u) => u.username).join(', ')} still ${users.length === 1 ? 'has' : 'have'} this role. Give them another role first.`,
    });
  }
  const [result] = await pool.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'role not found' });
  rolesChanged();
  res.json({ status: 'ok' });
});

module.exports = router;
