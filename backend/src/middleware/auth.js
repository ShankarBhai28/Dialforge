function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (req.session.user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

module.exports = { requireAuth, requireRole };
