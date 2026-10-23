const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const { requirePermission, requireAdminSide } = require('../middleware/auth');
const { scopeCondition } = require('../services/access');
const { closeOpenStatus, syncQueueMembership } = require('../services/agents');
const { releasePreviewLocks } = require('../services/preview');
const { revokeUserSessions } = require('../services/sessions');
const { checkPassword, extensionOutsideScope, parseNewUser, parseUserUpdate } = require('../services/users');
const hub = require('../realtime/hub');
const { readLeadUpload, receiveLeadFile } = require('../services/leadImport');
const { hashPasswords, planUserImport } = require('../services/userImport');

const router = express.Router();

async function extensionExists(id) {
  const [rows] = await pool.query('SELECT 1 FROM extensions WHERE id = ? AND deleted_at IS NULL', [id]);
  return rows.length > 0;
}

/** Ids of the accounts that have this extension now. */
async function extensionUsers(id) {
  const [rows] = await pool.query('SELECT id FROM users WHERE extension_id = ?', [id]);
  return rows.map((r) => r.id);
}

async function teamExists(id) {
  const [rows] = await pool.query('SELECT 1 FROM teams WHERE id = ?', [id]);
  return rows.length > 0;
}

async function roleExists(id) {
  const [rows] = await pool.query('SELECT 1 FROM roles WHERE id = ?', [id]);
  return rows.length > 0;
}

// Only a Super Admin creates, edits or resets admin-side logins (Super
// Admins and staff), so a staff role with Users: manage can't give itself
// or anyone else more rights. Such a role manages agent accounts only.
const AGENTS_ONLY = 'your role can only manage agent accounts - ask a Super Admin';
const touchesAdminSide = (...roles) => roles.some((r) => r && r !== 'agent');

// An own-teams login (TL, manager, head) manages only the agents of its teams
// (and of every team below them): new agents go into one of those teams,
// edits and password resets only reach those agents, and an agent's
// extension must be free or already one of theirs.
const NOT_YOURS = 'that agent is not in your teams';
const outOfScope = (scope, userId) => !!scope && !scope.agentIds.includes(userId);

// --- Admin: user accounts. A team-scoped role sees its teams' agents and itself. ---
router.get('/admin/users', requireAdminSide, async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'agents', 'users.id');
  const [rows] = await pool.query(
    `SELECT users.id, users.username, users.role, users.status, users.created_at,
            users.extension_id, extensions.name AS extension_name, users.role_id, roles.name AS role_name
     FROM users
     LEFT JOIN extensions ON users.extension_id = extensions.id
     LEFT JOIN roles ON roles.id = users.role_id
     ${cond ? `WHERE (${cond} OR users.id = ?)` : ''}
     ORDER BY users.id`,
    cond ? [...params, req.session.user.id] : [],
  );
  res.json(rows);
});

// New account; with teamId it joins that team in the same step.
router.post('/admin/users', requirePermission('users', 'create'), async (req, res) => {
  const { scope } = req.access;
  const { error, user } = parseNewUser(req.body);
  if (error) return res.status(400).json({ error });
  if (!req.access.superAdmin && touchesAdminSide(user.role)) return res.status(403).json({ error: AGENTS_ONLY });
  if (scope && !user.teamId) return res.status(400).json({ error: 'pick the team the new agent joins' });
  if (scope && !scope.teamIds.includes(user.teamId))
    return res.status(403).json({ error: 'that team is not one of yours' });
  if (!scope && user.teamId && !(await teamExists(user.teamId)))
    return res.status(400).json({ error: 'that team does not exist' });
  if (user.extensionId && !(await extensionExists(user.extensionId))) {
    return res.status(400).json({ error: 'that extension does not exist' });
  }
  if (user.extensionId) {
    const outside = extensionOutsideScope(scope, await extensionUsers(user.extensionId));
    if (outside) return res.status(403).json({ error: outside });
  }
  if (user.roleId && !(await roleExists(user.roleId)))
    return res.status(400).json({ error: 'that role does not exist' });
  const hash = await bcrypt.hash(user.password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO users (tenant_id, username, password_hash, role, role_id, extension_id) VALUES (1, ?, ?, ?, ?, ?)',
      [user.username, hash, user.role, user.roleId, user.extensionId],
    );
    if (user.teamId)
      await conn.query('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [user.teamId, result.insertId]);
    await conn.commit();
    if (user.teamId) hub.refreshAccess(); // the team's leaders see the new agent live
    res.status(201).json({ id: result.insertId, username: user.username, role: user.role });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'that username is already taken' });
    }
    throw err;
  } finally {
    conn.release();
  }
});

// --- Bulk import: agent accounts from an Excel / CSV file ---
// Without commit: the check - how many are ready and every problem (row,
// username, reason); nothing is saved. With commit=1: the same check, and
// only if the whole file is clean, every account is created in one go
// (all or nothing). Passwords never come back in the answer.
async function importContext(scope) {
  const [users] = await pool.query('SELECT username FROM users');
  const [exts] = await pool.query(
    `SELECT e.id, e.name, e.enabled, GROUP_CONCAT(u.id) AS user_ids
     FROM extensions e LEFT JOIN users u ON u.extension_id = e.id
     WHERE e.deleted_at IS NULL GROUP BY e.id`,
  );
  const [teams] = await pool.query('SELECT id, name FROM teams');
  return {
    scope,
    usernames: new Set(users.map((u) => u.username.toLowerCase())),
    extensions: new Map(
      exts.map((e) => [
        e.name,
        { id: e.id, enabled: !!e.enabled, userIds: e.user_ids ? String(e.user_ids).split(',').map(Number) : [] },
      ]),
    ),
    teams: new Map(teams.map((t) => [t.name.toLowerCase(), t.id])),
  };
}

router.post('/admin/users/import', requirePermission('users', 'create'), receiveLeadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'choose an .xlsx or .csv file' });
  const parsed = await readLeadUpload(req.file);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const plan = planUserImport(parsed.headers, parsed.rows, await importContext(req.access.scope));
  if (plan.error) return res.status(400).json({ error: plan.error });
  const { ready, problems } = plan;
  const summary = { ready: ready.length, problems };
  if (req.body.commit !== '1') return res.json(summary);
  if (problems.length)
    return res.status(400).json({ ...summary, error: 'fix the rows with problems first - nothing was created' });
  if (!ready.length) return res.status(400).json({ ...summary, error: 'the file has no users to create' });

  const hashes = await hashPasswords(ready.map((r) => r.password));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [i, r] of ready.entries()) {
      const [result] = await conn.query(
        "INSERT INTO users (tenant_id, username, password_hash, role, extension_id) VALUES (1, ?, ?, 'agent', ?)",
        [r.username, hashes[i], r.extensionId],
      );
      if (r.teamId)
        await conn.query('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [r.teamId, result.insertId]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    // Someone took a username between the check and now.
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'a username in the file was just taken - check the file again' });
    throw err;
  } finally {
    conn.release();
  }
  hub.refreshAccess();
  res.status(201).json({ created: ready.length });
});

// Role, extension and active/inactive. No delete: calls, status history,
// form answers and callbacks point at users - deactivate instead.
router.put('/admin/users/:id', requirePermission('users', 'edit'), async (req, res) => {
  const { scope } = req.access;
  const [rows] = await pool.query('SELECT id, role, role_id, status, extension_id FROM users WHERE id = ?', [
    req.params.id,
  ]);
  const current = rows[0];
  if (!current) return res.status(404).json({ error: 'user not found' });
  if (outOfScope(scope, current.id)) return res.status(403).json({ error: NOT_YOURS });
  const [[admins]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'");
  const { error, changes, revoke } = parseUserUpdate(req.body, current, {
    meId: req.session.user.id,
    activeAdmins: admins.n,
  });
  if (error) return res.status(400).json({ error });
  if (!req.access.superAdmin && touchesAdminSide(current.role, changes.role)) {
    return res.status(403).json({ error: AGENTS_ONLY });
  }
  if (changes.extension_id && !(await extensionExists(changes.extension_id))) {
    return res.status(400).json({ error: 'that extension does not exist' });
  }
  if (changes.extension_id && changes.extension_id !== current.extension_id) {
    const outside = extensionOutsideScope(scope, await extensionUsers(changes.extension_id), current.id);
    if (outside) return res.status(403).json({ error: outside });
  }
  if (changes.role_id && !(await roleExists(changes.role_id))) {
    return res.status(400).json({ error: 'that role does not exist' });
  }
  await pool.query('UPDATE users SET role = ?, role_id = ?, status = ?, extension_id = ? WHERE id = ?', [
    changes.role,
    changes.role_id,
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
router.post('/admin/users/:id/password', requirePermission('users', 'password'), async (req, res) => {
  const pwError = checkPassword(req.body.password);
  if (pwError) return res.status(400).json({ error: pwError });
  const [rows] = await pool.query('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  if (!req.access.superAdmin && touchesAdminSide(rows[0].role)) return res.status(403).json({ error: AGENTS_ONLY });
  if (outOfScope(req.access.scope, rows[0].id)) return res.status(403).json({ error: NOT_YOURS });
  const hash = await bcrypt.hash(req.body.password, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, rows[0].id]);
  if (rows[0].id !== req.session.user.id) revokeUserSessions(rows[0].id);
  res.json({ status: 'ok' });
});

module.exports = router;
