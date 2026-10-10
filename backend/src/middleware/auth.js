const { isRevoked } = require('../services/sessions');
const { ACTION_LABELS, SCREENS, accessFor, can } = require('../services/access');

// A session ended by an admin (role change, deactivation, password reset)
// is dropped here, on its next request.
function sessionUser(req) {
  const user = req.session.user;
  if (user && isRevoked(user)) {
    req.session.destroy(() => {});
    return null;
  }
  return user;
}

function requireAuth(req, res, next) {
  if (!sessionUser(req)) return res.status(401).json({ error: 'not logged in' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'not logged in' });
    if (user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

/**
 * Agent-side routes (calling, outcomes, the agent's own lists): agents, and
 * Super Admins as before. Staff logins are admin-side only.
 */
function requireCaller(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  if (user.role === 'staff') return res.status(403).json({ error: 'forbidden' });
  next();
}

// Sets req.access (see services/access.js) for an admin-side request.
async function loadAccess(req, res) {
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'not logged in' });
    return null;
  }
  let access;
  try {
    access = await accessFor(user);
  } catch (err) {
    console.error('[access check failed]', err);
    res.status(500).json({ error: 'could not check your access' });
    return null;
  }
  if (!access) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  req.access = access;
  return access;
}

/** Super Admin, or a staff role whose rights on `screen` include `action` (view, create, edit, ...). */
function requirePermission(screen, action) {
  return async (req, res, next) => {
    const access = await loadAccess(req, res);
    if (!access) return;
    if (!can(access, screen, action)) {
      const label = SCREENS.find((s) => s.key === screen)?.label ?? screen;
      return res.status(403).json({ error: `Your role doesn't allow: ${label} - ${ACTION_LABELS[action] ?? action}` });
    }
    next();
  };
}

/** Any admin-side login - for the lookup lists screens use in their dropdowns (still scoped). */
async function requireAdminSide(req, res, next) {
  if (await loadAccess(req, res)) next();
}

/** After requirePermission: actions a team-scoped role may not take (they would reach outside its teams). */
function requireAllScope(what) {
  return (req, res, next) => {
    if (req.access && req.access.scope) {
      return res.status(403).json({ error: `only roles that see all teams can ${what}` });
    }
    next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireCaller,
  requirePermission,
  requireAdminSide,
  requireAllScope,
  sessionUser,
};
