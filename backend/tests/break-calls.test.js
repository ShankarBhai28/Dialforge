// An agent on a break makes no calls (inbound and the dialer already skip
// them: the queue pauses them); in wrap-up they still may.
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
let status = 'break';
const sql = [];
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT status FROM agent_status_log')) return [[{ status }]];
    if (s.startsWith('INSERT INTO calls')) return [{ insertId: 90 }];
    return [[]];
  },
});
fake('ari.js', {
  originate: async () => ({ id: 'chan-1' }),
  isEndpointOnline: async () => true,
  endpointState: async () => 'online',
  endpointStates: async () => ({}),
  endpointChannelCount: async () => 0,
});

const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = {
      user: { id: 2, username: 'agent1001', role: 'agent', extensionName: '1001', loginAt: Date.now() },
    };
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

test('on a break: a manual call is refused with what to do, and nothing is dialled', async () => {
  status = 'break';
  sql.length = 0;
  const [code, body] = await call({ toNumber: '9840012345' });
  assert.strictEqual(code, 403);
  assert.deepStrictEqual(body, { error: "You're on Break - choose Available to make calls.", code: 'on_break' });
  assert.ok(!sql.some(([s]) => s.startsWith('INSERT INTO calls')));
});

test('in wrap-up (and Available) the agent may call', async () => {
  for (const s of ['acw', 'available']) {
    status = s;
    const [code] = await call({ toNumber: '9840012345' });
    assert.strictEqual(code, 202, s);
  }
});
