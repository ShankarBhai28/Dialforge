// Live updates pushed to browsers over a WebSocket at /ws, replacing
// polling as screens move to the React app.
//
// - The connection is authenticated with the same login session as the
//   REST API (the session cookie is checked during the upgrade).
// - Messages are JSON: { type, data, at }.
// - Admins receive everything; an agent receives only messages addressed
//   to their own user id.
const { WebSocketServer } = require('ws');

const clients = new Set(); // { ws, user }
let wss = null;

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
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user };
        clients.add(client);
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        ws.on('close', () => clients.delete(client));
        ws.on('error', () => clients.delete(client));
        ws.send(JSON.stringify({ type: 'hello', data: { user: user.username, role: user.role }, at: Date.now() }));
      });
    });
  });

  // Drop connections that stopped answering pings (laptop slept, network gone).
  const timer = setInterval(() => {
    for (const { ws } of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  timer.unref();
}

// toUserId: also deliver to that agent (admins always get it).
function publish(type, data, { toUserId = null } = {}) {
  if (!clients.size) return;
  const msg = JSON.stringify({ type, data, at: Date.now() });
  for (const { ws, user } of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (user.role === 'admin' || (toUserId != null && user.id === toUserId)) ws.send(msg);
  }
}

function connectedCount() {
  return clients.size;
}

module.exports = { attach, publish, connectedCount };
