// Ending a user's open sessions (role change, deactivation, password reset).
// Sessions live in memory (express-session's default store), so instead of
// hunting them down we remember "everything this user logged in before T is
// void" and check it on each request. A backend restart drops all sessions
// anyway, so this map never needs to outlive the process.
const hub = require('../realtime/hub');

const revokedBefore = new Map(); // userId -> ms timestamp

function revokeUserSessions(userId) {
  revokedBefore.set(Number(userId), Date.now());
  hub.disconnectUser(userId);
}

/** True when this session's login predates a revocation for its user. */
function isRevoked(sessionUser) {
  const t = revokedBefore.get(Number(sessionUser.id));
  return t !== undefined && !(sessionUser.loginAt > t);
}

module.exports = { revokeUserSessions, isRevoked };
