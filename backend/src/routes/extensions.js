const express = require('express');
const { deleteExtension } = require('../services/softDelete');
const { revokeUserSessions } = require('../services/sessions');
const pool = require('../../db');
const ari = require('../../ari');
const names = require('../telephony/names');
const { requireAdminSide, requirePermission } = require('../middleware/auth');
const { generateSipPassword, parseExtensionUpdate } = require('../services/extensions');

const router = express.Router();

// --- Admin: extensions (agent SIP lines) ---
// Asterisk reads these rows directly (migration 0002), so creating,
// disabling or changing a password here takes effect without touching any
// Asterisk file. The SIP password is only ever returned once - right after
// create / new password - for a desk phone; the agent screen fetches its own.

// Also the lookup list for Users / Teams, so any admin-side login may read it.
router.get('/admin/extensions', requireAdminSide, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.id, e.name, e.label, e.enabled, e.created_at,
            (e.sip_password IS NOT NULL AND e.sip_password <> '') AS has_password,
            (SELECT GROUP_CONCAT(u.username ORDER BY u.username SEPARATOR ', ')
               FROM users u WHERE u.extension_id = e.id) AS used_by,
            (SELECT GROUP_CONCAT(u.id) FROM users u WHERE u.extension_id = e.id) AS user_ids
     FROM extensions e WHERE e.deleted_at IS NULL ORDER BY e.name`,
  );
  // An own-teams login sees only the free extensions and those of its own
  // agents (and its own monitoring line) - not other teams' lines.
  const { scope } = req.access;
  const mine = (r) => {
    if (!scope || !r.user_ids) return true;
    return String(r.user_ids)
      .split(',')
      .map(Number)
      .every((id) => scope.agentIds.includes(id) || id === req.session.user.id);
  };
  const visible = rows.filter(mine).map(({ user_ids, ...r }) => r);
  // Registered right now (a browser or phone is connected)? null = Asterisk didn't answer.
  const states = names.ownEndpointStates(await ari.endpointStates());
  res.json(
    visible.map((r) => ({
      ...r,
      enabled: !!r.enabled,
      has_password: !!Number(r.has_password),
      registered: states ? states[r.name] === 'online' : null,
    })),
  );
});

// No create here: extensions are the client's agent seats, added by the
// provider on the server (npm run ext:add) - not by the client's admin.

// Label and enabled. A disabled extension disappears from Asterisk: it
// can't register again (a browser already connected stays until its
// registration ends - force-logout the agent to cut it at once).
router.put('/admin/extensions/:id', requirePermission('extensions', 'edit'), async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, name, label, enabled FROM extensions WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'extension not found' });
  const { error, changes } = parseExtensionUpdate(req.body, rows[0]);
  if (error) return res.status(400).json({ error });
  await pool.query('UPDATE extensions SET label = ?, enabled = ? WHERE id = ?', [
    changes.label,
    changes.enabled,
    rows[0].id,
  ]);
  res.json({ id: rows[0].id, name: rows[0].name, ...changes, enabled: !!changes.enabled });
});

// A new SIP password (e.g. a desk phone was lost). The agent screen picks
// it up on its next connect.
router.post('/admin/extensions/:id/password', requirePermission('extensions', 'edit'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, name FROM extensions WHERE id = ? AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'extension not found' });
  const password = generateSipPassword();
  await pool.query('UPDATE extensions SET sip_password = ? WHERE id = ?', [password, rows[0].id]);
  res.json({ id: rows[0].id, name: rows[0].name, sipPassword: password });
});

// Only while no user has it as their extension (calls keep the number as text, so history stays).
// Delete always works and keeps history (calls keep the number): its users
// lose it and are logged out, Asterisk no longer knows it.
router.delete('/admin/extensions/:id', requirePermission('extensions', 'delete'), async (req, res) => {
  const result = await deleteExtension(Number(req.params.id), req.session.user.id);
  if (result === null) return res.status(404).json({ error: 'extension not found' });
  for (const id of result.userIds) revokeUserSessions(id);
  res.json({ status: 'ok', notes: result.notes });
});

module.exports = router;
