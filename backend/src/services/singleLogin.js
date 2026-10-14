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
// - Licence seats: no more agents logged in at once than the licence allows
//   (seatRefusal) - checked first, so a refused login changes nothing.
// - Every agent login ends the agent's older sessions anyway, so a browser
//   left logged in can't come back later and grab the line.
// Two tabs of the same browser share one session: the agent screen itself
// lets only one tab work (web/src/features/agent/singleTab.ts).
const pool = require('../../db');
const ari = require('../../ari');
const hub = require('../realtime/hub');
const { openStatus, onActiveCall, takeOffline } = require('./agentLogout');
const { endUserSessions } = require('./sessions');
const { getLicence } = require('./licence');

/**
 * Agents logged in right now (ids): an open status row (available / break /
 * acw) or the agent screen open - the same "logged in" as Live Agents.
 */
async function agentsLoggedIn(deps = { pool, hub }) {
  const [rows] = await deps.pool.query(
    `SELECT DISTINCT asl.user_id FROM agent_status_log asl JOIN users u ON u.id = asl.user_id
     WHERE asl.ended_at IS NULL AND u.role = 'agent'`,
  );
  return new Set([...rows.map((r) => r.user_id), ...deps.hub.connectedUserIds('agent')]);
}

/**
 * Licence seats = agents logged in at the same time (admins / supervisors
 * don't count, nor do extensions). Null when this agent may log in, else the
 * refusal. The agent themself never counts: logging in again or taking over
 * their own other screen doesn't need a new seat.
 */
async function seatRefusal(user, deps = { pool, hub }, seats = getLicence().seats) {
  if (!seats) return null;
  const inUse = await agentsLoggedIn(deps);
  inUse.delete(user.id);
  if (inUse.size < seats) return null;
  return {
    status: 409,
    body: {
      error: `All ${seats} agent seats are in use - an agent has to log out first (or ask your admin).`,
      code: 'seats_full',
    },
  };
}

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
  const full = await seatRefusal(user, deps);
  if (full) return { refuse: full };
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

module.exports = { activeElsewhere, agentsLoggedIn, claimAgentLogin, seatRefusal };
