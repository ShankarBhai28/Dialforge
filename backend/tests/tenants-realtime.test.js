// Cloud edition: live updates stay inside a company - the same user id in
// two companies is two different people. And the database switch itself:
// one pool per company database, the home pool outside a request.
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { test, before, after } = require('node:test');
const WebSocket = require('ws');

process.env.MULTI_TENANT = '1';
process.env.HOME_TENANT_CODE = 'main';

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const TENANTS = {
  acme: { code: 'acme', name: 'Acme', db_name: 'viztex_t_acme', status: 'active' },
  globex: { code: 'globex', name: 'Globex', db_name: 'viztex_t_globex', status: 'active' },
};
const platform = { query: async (sql, params) => [TENANTS[params[0]] ? [TENANTS[params[0]]] : []] };

const tenancy = require('../src/tenancy');
const realDb = require('../db'); // loaded before the fake, for the pool test below
fake('db.js', { query: async () => [[]], platformPool: () => platform });
fake('ari.js', { endpointState: async () => 'offline', getEndpoints: async () => [] });
fake('src/services/presence.js', { presenceChanged: () => {} });
const hub = require('../src/realtime/hub');

const fakeSession = (req, res, next) => {
  const [tenant, role, id] = (req.headers['x-test-user'] || '').split(':');
  req.session = role ? { tenant, user: { id: Number(id), username: `${role}${id}`, role } } : {};
  next();
};

let server;
let url;
before(async () => {
  server = http.createServer((req, res) => res.end());
  hub.attach(server, fakeSession);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await realDb.end();
});

function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-test-user': user } });
    const messages = [];
    ws.on('message', (m) => messages.push(JSON.parse(m)));
    ws.on('open', () => {
      const wait = () => (messages.length ? resolve({ ws, messages }) : setTimeout(wait, 5));
      wait();
    });
    ws.on('error', reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const types = (c) => c.messages.slice(1).map((m) => m.type);
const as = (code, fn) => tenancy.run({ code, dbName: TENANTS[code].db_name }, fn);

test('messages and lookups reach only the company they are for', async () => {
  const acmeAdmin = await connect('acme:admin:1');
  const globexAdmin = await connect('globex:admin:1');
  const acme7 = await connect('acme:agent:7');
  const globex7 = await connect('globex:agent:7');

  as('acme', () => hub.publish('call.event', { callId: 1 }));
  as('globex', () => hub.sendToUser(7, 'session.ended', { reason: 'elsewhere' }));
  await settle();

  assert.deepStrictEqual(types(acmeAdmin), ['call.event']);
  assert.deepStrictEqual(types(globexAdmin), []);
  assert.deepStrictEqual(types(acme7), []);
  assert.deepStrictEqual(types(globex7), ['session.ended']);

  as('acme', () => {
    assert.strictEqual(hub.isUserConnected(7), true);
    assert.deepStrictEqual(hub.connectedUserIds('agent'), [7]);
  });
  // Outside a request (home company): none of these connections.
  assert.strictEqual(hub.isUserConnected(7), false);

  as('globex', () => hub.disconnectUser(7));
  await settle();
  assert.strictEqual(acme7.ws.readyState, WebSocket.OPEN);
  assert.notStrictEqual(globex7.ws.readyState, WebSocket.OPEN);
  for (const c of [acmeAdmin, globexAdmin, acme7]) c.ws.close();
});

test('db.js: one pool per company database, the home pool outside a request', () => {
  const home = realDb.current();
  const acme = as('acme', () => realDb.current());
  assert.notStrictEqual(acme, home);
  assert.strictEqual(
    as('acme', () => realDb.current()),
    acme,
  );
  assert.notStrictEqual(
    as('globex', () => realDb.current()),
    acme,
  );
});
