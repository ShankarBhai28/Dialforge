// Live updates pushed to browsers over a WebSocket at /ws, replacing
// polling as screens move to the React app.
//
// - The connection is authenticated with the same login session as the
//   REST API (the session cookie is checked during the upgrade).
// - Messages are JSON: { type, data, at }.
// - Who gets what:
//     Super Admin - everything
//     agent       - only messages addressed to their own user id
//     staff       - what their role allows (staffView below), limited to
//                   their teams for a team-scoped role
// - Cloud edition: each connection belongs to one company (its session's);
//   a message goes only to the connections of the company it is sent for
//   (the current tenant, src/tenancy.js), and so does every lookup here.
const { WebSocketServer } = require('ws');
const { accessFor, can } = require('../services/access');
const { scopeOverview } = require('../services/dialer');
const tenancy = require('../tenancy');

const clients = new Set(); // { ws, user, access, tenant }

/** Connections of the company the code is running for now. */
const mine = (client) => client.tenant === tenancy.key();

/** Runs fn as this connection's company (its events arrive outside any request). */
function asTenantOf(client, fn) {
  return require('../services/tenants')
    .runAsTenant(client.tenant, fn)
    .catch((err) => console.error('[ws tenant]', err.message));
}
let wss = null;

/** A staff client's copy of a message, or null when their role doesn't cover it. */
function staffView(type, data, access) {
  if (!access) return null;
  const { scope } = access;
  switch (type) {
    case 'agent.status':
      if (!can(access, 'live', 'view')) return null;
      return !scope || scope.agentIds.includes(data.userId) ? data : null;
    case 'call.event':
      if (!can(access, 'live', 'view') && !can(access, 'calls', 'view')) return null;
      // Team scope: only a "something changed" hint; the screen re-reads its own (scoped) data.
      return scope ? { callId: data.callId } : data;
    case 'dialer.status':
      return can(access, 'dialer', 'view') ? scopeOverview(data, scope) : null;
    default:
      return null;
  }
}

async function loadAccess(client) {
  await asTenantOf(client, async () => {
    try {
      client.access = await accessFor(client.user);
    } catch (err) {
      console.error('[ws access]', err.message);
    }
  });
}

function attach(server, sessionMiddleware) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return; // not ours (none today; keeps room for others)
    sessionMiddleware(req, {}, () => {
      const user = req.session && req.session.user;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const tenant = tenancy.isMulti() ? req.session.tenant || tenancy.homeCode() : '';
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user, access: null, tenant };
        clients.add(client);
        const presenceChanged = () => asTenantOf(client, () => require('../services/presence').presenceChanged());
        presenceChanged(); // live_agents.screen_open
        if (user.role === 'staff') void loadAccess(client);
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        ws.on('close', () => {
          clients.delete(client);
          presenceChanged();
        });
        ws.on('error', () => clients.delete(client));
        ws.send(JSON.stringify({ type: 'hello', data: { user: user.username, role: user.role }, at: Date.now() }));
      });
    });
  });

  // Drop connections that stopped answering pings (laptop slept, network
  // gone), and re-read staff rights (team membership may have changed).
  const timer = setInterval(() => {
    for (const client of clients) {
      const { ws } = client;
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    refreshAccess();
  }, 30000);
  timer.unref();
}

/** Re-reads every staff connection's rights (a role or team just changed). */
function refreshAccess() {
  for (const client of clients) if (client.user.role === 'staff') void loadAccess(client);
}

// toUserId: also deliver to that agent (Super Admins always get it).
function publish(type, data, { toUserId = null } = {}) {
  if (!clients.size) return;
  const full = JSON.stringify({ type, data, at: Date.now() });
  for (const client of clients) {
    const { ws, user, access } = client;
    if (ws.readyState !== ws.OPEN || !mine(client)) continue;
    if (user.role === 'admin' || (toUserId != null && user.id === toUserId)) {
      ws.send(full);
    } else if (user.role === 'staff') {
      const view = staffView(type, data, access);
      if (view) ws.send(JSON.stringify({ type, data: view, at: Date.now() }));
    }
  }
}

/** Ids of users with a screen open now (optionally only this role). */
function connectedUserIds(role = null) {
  const ids = new Set();
  for (const c of clients)
    if (c.ws.readyState === c.ws.OPEN && mine(c) && (!role || c.user.role === role)) ids.add(c.user.id);
  return [...ids];
}

/** Has this user a screen open right now (a live connection)? */
function isUserConnected(userId) {
  for (const c of clients) if (mine(c) && c.user.id === Number(userId) && c.ws.readyState === c.ws.OPEN) return true;
  return false;
}

/** Sends one message to this user's open screens only. */
function sendToUser(userId, type, data) {
  const full = JSON.stringify({ type, data, at: Date.now() });
  for (const c of clients)
    if (mine(c) && c.user.id === Number(userId) && c.ws.readyState === c.ws.OPEN) c.ws.send(full);
}

/** Closes a user's live connections (their access was just revoked). */
function disconnectUser(userId) {
  for (const client of clients) {
    if (mine(client) && client.user.id === Number(userId)) {
      client.ws.close(4001, 'session ended');
      clients.delete(client);
    }
  }
}

function connectedCount() {
  return clients.size;
}

/** How many connections may see `screen` (e.g. 'dialer' - the feed only reads while someone watches). */
function watchingCount(screen) {
  let n = 0;
  for (const client of clients) {
    const { user, access } = client;
    if (!mine(client)) continue;
    if (user.role === 'admin' || (user.role === 'staff' && can(access, screen, 'view'))) n++;
  }
  return n;
}

module.exports = {
  attach,
  publish,
  disconnectUser,
  isUserConnected,
  connectedUserIds,
  sendToUser,
  connectedCount,
  watchingCount,
  refreshAccess,
  staffView,
};
