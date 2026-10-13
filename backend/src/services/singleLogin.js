// One login per agent at a time.
//
// An agent open in two browsers / computers registers the same extension
// twice: Asterisk keeps only the newest registration, so the two screens
// knock each other off the line and calls ring in the wrong one. So:
// - Logging in while the agent's screen is open elsewhere (live
//   connection, or an open status session with the line registered) is
//   refused with code 'already_logged_in'; the login page offers "Log in
//   here", which repeats the login with takeOver: true.
// - Taking over: never during a call; otherwise the other screen is told
//   ('session.ended', it disconnects its phone and goes to the login page),
//   its sessions are deleted and the agent is taken offline (picks a queue
//   again here).
// - Every agent login ends the agent's older sessions anyway, so a browser
//   left logged in can't come back later and grab the line.
// Two tabs of the same browser share one session: the agent screen itself
// lets only one tab work (web/src/features/agent/singleTab.ts).
const pool = require('../../db');
const ari = require('../../ari');
const hub = require('../realtime/hub');
const { openStatus, onActiveCall, takeOffline } = require('./agentLogout');
const { endUserSessions } = require('./sessions');

/** Where this agent is working right now, or null. */
async function activeElsewhere(user, deps = { pool, ari, hub }) {
  const open = await openStatus(user.id, deps);
  const ext = (open && open.extension_name) || user.extension_name || null;
  let lineUp = false;
  if (open && ext) lineUp = (await deps.ari.endpointState(`PJSIP/${ext}`).catch(() => null)) === 'online';
  const screenOpen = deps.hub.isUserConnected(user.id);
  if (!screenOpen && !lineUp) return null;
  return {
    extension: ext,
    since: open ? open.started_at : null,
    onCall: await onActiveCall(ext, deps),
  };
}

/**
 * Called by POST /auth/login for agents after the password check.
 * Returns { refuse: { status, body } } or { loginAt } (the earliest loginAt
 * the new session may have).
 */
async function claimAgentLogin(user, takeOver, deps = { pool, ari, hub, endUserSessions, takeOffline }) {
  const other = await activeElsewhere(user, deps);
  if (other && other.onCall) {
    return {
      refuse: {
        status: 409,
        body: {
          error: 'You are on a call on your other screen - finish it there first, then log in here.',
          code: 'on_call_elsewhere',
        },
      },
    };
  }
  if (other && !takeOver) {
    return {
      refuse: {
        status: 409,
        body: {
          error: 'You are already logged in on another browser or computer.',
          code: 'already_logged_in',
          since: other.since,
        },
      },
    };
  }
  const revokedAt = await deps.endUserSessions(user.id, 'elsewhere');
  if (other) await deps.takeOffline(user.id, other.extension);
  return { loginAt: Math.max(Date.now(), revokedAt + 1), tookOver: !!other };
}

module.exports = { activeElsewhere, claimAgentLogin };
