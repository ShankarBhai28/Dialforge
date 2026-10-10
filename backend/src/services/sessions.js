// Ending a user's open sessions (role change, deactivation, password reset,
// force logout). Two layers:
// - their rows in the MySQL session store are deleted (setStore below), so
//   the sessions are gone even after a restart;
// - a "everything this user logged in before T is void" mark, checked on
//   each request, covers the moment until the delete has run.
const hub = require('../realtime/hub');

const revokedBefore = new Map(); // userId -> ms timestamp
let store = null;

/** server.js hands over the MySQL session store (tests run without one). */
function setStore(s) {
  store = s;
}

function revokeUserSessions(userId) {
  revokedBefore.set(Number(userId), Date.now());
  hub.disconnectUser(userId);
  if (store) store.destroyUser(Number(userId)).catch((err) => console.error('[session revoke]', err.message));
}

/** True when this session's login predates a revocation for its user. */
function isRevoked(sessionUser) {
  const t = revokedBefore.get(Number(sessionUser.id));
  return t !== undefined && !(sessionUser.loginAt > t);
}

module.exports = { revokeUserSessions, isRevoked, setStore };
