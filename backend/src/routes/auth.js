const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const { closeOpenStatus, syncQueueMembership } = require('../services/agents');
const { releasePreviewLocks } = require('../services/preview');
const { sessionUser } = require('../middleware/auth');
const { accessFor } = require('../services/access');
const { audit } = require('../services/audit');
const { guard } = require('../services/loginGuard');
const { claimAgentLogin } = require('../services/singleLogin');

const router = express.Router();

// --- Auth ---
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  // Too many wrong passwords for this username or from this address: wait.
  const wait = guard.blockedFor(username, req.ip);
  if (wait) {
    return res
      .status(429)
      .json({ error: `Too many failed logins - try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
  }

  const [rows] = await pool.query(
    `SELECT users.*, extensions.name AS extension_name
     FROM users LEFT JOIN extensions ON users.extension_id = extensions.id
     WHERE username = ?`,
    [username],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const locked = guard.fail(username, req.ip);
    void audit({
      username: String(username).slice(0, 50),
      action: locked ? 'auth.login_locked' : 'auth.login_failed',
      status: 401,
      summary: locked ? 'too many failed logins - locked for 15 minutes' : null,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'invalid username or password' });
  }
  guard.succeed(username);
  if (user.status === 'inactive') {
    void audit({ user, action: 'auth.login_refused', status: 403, summary: 'account disabled', ip: req.ip });
    return res.status(403).json({ error: 'this account is disabled - ask your admin' });
  }
  if (user.role === 'staff' && !(await accessFor({ role: 'staff', roleId: user.role_id, id: user.id }))) {
    return res.status(403).json({ error: 'your account has no role yet - ask your Super Admin' });
  }

  // Agents: one login at a time (services/singleLogin.js).
  let loginAt = Date.now();
  if (user.role === 'agent') {
    const claim = await claimAgentLogin(user, req.body.takeOver === true);
    if (claim.refuse) {
      void audit({ user, action: 'auth.login_refused', status: 409, summary: claim.refuse.body.code, ip: req.ip });
      return res.status(claim.refuse.status).json(claim.refuse.body);
    }
    loginAt = claim.loginAt;
    if (claim.tookOver) {
      void audit({
        user,
        action: 'auth.login_takeover',
        entity: 'users',
        entityId: user.id,
        status: 200,
        summary: 'logged in here; the other browser was logged out',
        ip: req.ip,
      });
    }
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    roleId: user.role_id,
    extensionId: user.extension_id,
    extensionName: user.extension_name,
    // Sessions started before an admin revokes this user's access end (services/sessions.js).
    loginAt,
  };

  // No auto-Available here anymore - an agent must pick a queue first
  // (enforced client-side via a popup, and server-side below).
  void audit({
    user,
    action: 'auth.login',
    entity: 'users',
    entityId: user.id,
    status: 200,
    summary: user.role,
    ip: req.ip,
  });
  res.json({ status: 'ok', user: await withAccess(req.session.user) });
});

router.post('/auth/logout', async (req, res) => {
  if (req.session.user) {
    void audit({
      user: req.session.user,
      action: 'auth.logout',
      entity: 'users',
      entityId: req.session.user.id,
      ip: req.ip,
    });
  }
  if (req.session.user && req.session.user.role === 'agent') {
    await releasePreviewLocks(req.session.user.id, null);
    await closeOpenStatus(req.session.user.id);
    await syncQueueMembership(req.session.user.id, req.session.user.extensionName, 'offline', null);
  }
  req.session.destroy(() => res.json({ status: 'ok' }));
});

// The session user plus, for admin-side logins, what they may do - the
// screens show and hide from this; the server checks every request anyway.
async function withAccess(user) {
  const access = await accessFor(user);
  if (!access) return user;
  return {
    ...user,
    roleName: access.superAdmin ? 'Super Admin' : access.role.name,
    scope: access.scope ? 'team' : 'all',
    // Own-teams role: how many teams they're in (0 = they see nothing yet).
    teamCount: access.scope ? access.scope.teamIds.length : null,
    permissions: access.superAdmin ? null : access.role.permissions,
  };
}

router.get('/auth/me', async (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  res.json(await withAccess(user));
});

module.exports = router;
