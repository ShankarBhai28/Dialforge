const { isRevoked } = require('../services/sessions');

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

module.exports = { requireAuth, requireRole, sessionUser };
