// A click-to-call that can't even ring the agent's line is closed at once,
// gives the lead its attempt back, and says why in plain words.
const assert = require('node:assert');
const path = require('node:path');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('INSERT INTO calls')) return [{ insertId: 68 }];
    if (s.startsWith('SELECT status, deleted_at FROM leads')) return [[{ status: 'new' }]];
    // 9840055555 typed on the dialpad is lead 44
    if (s.startsWith('SELECT id FROM leads WHERE (phone = ? OR alt_phone = ?)'))
      return [params[0] === '9840055555' ? [{ id: 44 }] : []];
    return [[]];
  },
});
let failWith = 'ARI POST /channels failed: 500 {"error":"Allocation failed"}';
fake('ari.js', {
  originate: async () => {
    throw new Error(failWith);
  },
  isEndpointOnline: async () => true,
  endpointState: async () => 'online',
  endpointStates: async () => ({}),
});

const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = { user: { id: 1, username: 'boss', role: 'admin', loginAt: Date.now() } };
    next();
  },
  webDistDir: '/nonexistent',
  audit: false,
});
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// Plain node:http (not fetch): fetch's connection pool keeps handles that
// make Node crash at exit on Windows with --test-force-exit.
const http = require('node:http');
const call = (body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${base}/calls/click2call`,
      {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve([res.statusCode, JSON.parse(text)]));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

test("agent's line not reachable: plain message, call closed, lead attempt given back", async () => {
  sql.length = 0;
  const [status, body] = await call({ toNumber: '7339332413', fromExtension: '1003', leadId: 9 });
  assert.strictEqual(status, 502);
  assert.match(body.error, /phone line isn't connected/);
  assert.ok(
    sql.some(
      ([s, p]) => /UPDATE calls SET end_time = NOW\(\), disposition = 'agent_unanswered'/.test(s) && p[0] === 68,
    ),
  );
  // The lead was held for the call's outcome (dialer leaves it alone) ...
  assert.ok(sql.some(([s, p]) => /UPDATE leads SET next_call_at = GREATEST/.test(s) && p[0] === 30 && p[1] === 9));
  // ... and, the call never starting, gets its attempt and its old redial time back.
  assert.ok(
    sql.some(
      ([s, p]) => /UPDATE leads SET attempts = GREATEST\(attempts - 1, 0\), next_call_at = \?/.test(s) && p[1] === 9,
    ),
  );
});

test('any other failure: closed too, with the reason', async () => {
  failWith = 'ARI not reachable';
  const [status, body] = await call({ toNumber: '7339332413', fromExtension: '1003' });
  assert.strictEqual(status, 502);
  assert.match(body.error, /Could not start the call: ARI not reachable/);
});

test('a dialpad number that is a known lead counts as its attempt (given back when the call fails to start)', async () => {
  sql.length = 0;
  failWith = 'ARI not reachable';
  const [status] = await call({ toNumber: '9840055555', fromExtension: '1003' });
  assert.strictEqual(status, 502);
  assert.ok(sql.some(([s, p]) => /UPDATE leads SET attempts = attempts \+ 1/.test(s) && p[0] === 44));
  assert.ok(sql.some(([s, p]) => /INSERT INTO calls/.test(s) && p[0] === 44));
  assert.ok(sql.some(([s, p]) => /attempts = GREATEST\(attempts - 1, 0\)/.test(s) && p[1] === 44));
});
