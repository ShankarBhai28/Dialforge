const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const { requireRole } = require('../middleware/auth');
const { closeOpenStatus, syncQueueMembership } = require('../services/agents');
const { releasePreviewLocks } = require('../services/preview');
const { revokeUserSessions } = require('../services/sessions');
const { checkPassword, parseNewUser, parseUserUpdate } = require('../services/users');

const router = express.Router();

async function extensionExists(id) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE id = ?', [id]);
  return rows.length > 0;
}

// --- Admin: manage user accounts ---
router.get('/admin/users', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT users.id, users.username, users.role, users.status, users.created_at,
            users.extension_id, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     ORDER BY users.id`,
  );
  res.json(rows);
});

router.post('/admin/users', requireRole('admin'), async (req, res) => {
  const { error, user } = parseNewUser(req.body);
  if (error) return res.status(400).json({ error });
  if (user.extensionId && !(await extensionExists(user.extensionId))) {
    return res.status(400).json({ error: 'that extension does not exist' });
  }
  const hash = await bcrypt.hash(user.password, 10);
  try {
    const [result] = await pool.query(
      'INSERT INTO users (tenant_id, username, password_hash, role, extension_id) VALUES (1, ?, ?, ?, ?)',
      [user.username, hash, user.role, user.extensionId],
    );
    res.status(201).json({ id: result.insertId, username: user.username, role: user.role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'that username is already taken' });
    }
    throw err;
  }
});

// Role, extension and active/inactive. No delete: calls, status history,
// form answers and callbacks point at users - deactivate instead.
router.put('/admin/users/:id', requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, role, status, extension_id FROM users WHERE id = ?', [req.params.id]);
  const current = rows[0];
  if (!current) return res.status(404).json({ error: 'user not found' });
  const [[admins]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'");
  const { error, changes, revoke } = parseUserUpdate(req.body, current, {
    meId: req.session.user.id,
    activeAdmins: admins.n,
  });
  if (error) return res.status(400).json({ error });
  if (changes.extension_id && !(await extensionExists(changes.extension_id))) {
    return res.status(400).json({ error: 'that extension does not exist' });
  }
  await pool.query('UPDATE users SET role = ?, status = ?, extension_id = ? WHERE id = ?', [
    changes.role,
    changes.status,
    changes.extension_id,
    current.id,
  ]);

  // A deactivated agent leaves their queues straight away, like a logout.
  if (current.role === 'agent' && changes.status === 'inactive' && current.status === 'active') {
    const [open] = await pool.query(
      'SELECT extension_name FROM agent_status_log WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      [current.id],
    );
    if (open[0]) {
      await releasePreviewLocks(current.id, null);
      await closeOpenStatus(current.id);
      await syncQueueMembership(current.id, open[0].extension_name, 'offline', null);
    }
  }
  if (revoke) revokeUserSessions(current.id);
  res.json({ id: current.id, ...changes });
});

// An admin sets a new password; the user's open sessions end.
router.post('/admin/users/:id/password', requireRole('admin'), async (req, res) => {
  const pwError = checkPassword(req.body.password);
  if (pwError) return res.status(400).json({ error: pwError });
  const hash = await bcrypt.hash(req.body.password, 10);
  const [result] = await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'user not found' });
  if (Number(req.params.id) !== req.session.user.id) revokeUserSessions(req.params.id);
  res.json({ status: 'ok' });
});

router.get('/admin/extensions', requireRole('admin'), async (req, res) => {
  // Never sip_password: only the agent's own /agent/extension-credentials
  // hands that out, to the browser that registers the line.
  const [rows] = await pool.query('SELECT id, name, label, created_at FROM extensions ORDER BY id');
  res.json(rows);
});

module.exports = router;
