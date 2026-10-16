// Blended agents: besides their main queue an agent can take calls from extra
// queues of their teams - joined with penalty 1 (that queue's own agents
// first), paused / left with the main one, forgotten at logout; and while on
// (or wrapping up) a call from an extra queue, its campaign is the one worked.
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const sql = [];
const ami = [];
let extras = []; // agent_extra_queues rows (queue ids)
let status = 'available';
let lastCall = null; // the campaign of the agent's latest call
let callLive = false;
let mainQueue = 1; // the last status row's queue
const QUEUES = { 1: 'sales', 2: 'support', 3: 'billing' };
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT asterisk_name FROM queues WHERE id = ?')) return [[{ asterisk_name: QUEUES[params[0]] }]];
    if (s.startsWith('SELECT q.asterisk_name FROM agent_extra_queues'))
      return [extras.map((id) => ({ asterisk_name: QUEUES[id] }))];
    if (s.startsWith('SELECT x.queue_id, q.asterisk_name FROM agent_extra_queues'))
      return [extras.map((id) => ({ queue_id: id, asterisk_name: QUEUES[id] }))];
    if (s.startsWith('DELETE FROM agent_extra_queues')) {
      extras = [];
      return [{}];
    }
    if (s.startsWith('INSERT INTO agent_extra_queues')) {
      extras = params[0].map(([, q]) => q);
      return [{}];
    }
    if (s.includes('FROM team_members tm')) return [[1, 2].map((id) => ({ id, name: QUEUES[id] }))];
    if (s.startsWith('SELECT status FROM agent_status_log')) return [[{ status }]];
    if (s.startsWith('SELECT c.* FROM calls ca JOIN campaigns c')) return [lastCall ? [lastCall] : []];
    if (s.startsWith('SELECT 1 AS live FROM calls')) return [callLive ? [{ live: 1 }] : []];
    if (s.startsWith('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: mainQueue }]];
    if (s.startsWith('SELECT c.* FROM campaigns c JOIN queues q')) return [[{ id: 10, name: 'Sales' }]];
    return [[]];
  },
});
fake('ami.js', {
  queueAdd: async (q, iface, penalty) => ami.push(['add', q, penalty]),
  queuePause: async (q, iface, paused) => ami.push([paused ? 'pause' : 'unpause', q]),
  queueRemove: async (q) => ami.push(['remove', q]),
});

const agents = require('../src/services/agents');
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
const post = (url, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${base}${url}`,
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

test('Available with an extra queue: main at penalty 0, extra at penalty 1; break pauses both', async () => {
  extras = [];
  ami.length = 0;
  const [code] = await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [2, 1] });
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(extras, [2], 'the main queue is never its own extra');
  assert.deepStrictEqual(ami, [
    ['add', 'sales', 0],
    ['unpause', 'sales'],
    ['add', 'support', 1],
    ['unpause', 'support'],
  ]);
  ami.length = 0;
  await post('/agent/status', { status: 'break', reason: 'Lunch', queueId: 1 });
  assert.deepStrictEqual(ami, [
    ['pause', 'sales'],
    ['pause', 'support'],
  ]);
  assert.deepStrictEqual(extras, [2], 'a break keeps the shift choice');
});

test("an extra queue outside the agent's teams is refused, nothing changes", async () => {
  extras = [2];
  ami.length = 0;
  const [code, body] = await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [3] });
  assert.strictEqual(code, 403);
  assert.match(body.error, /extra queues/);
  assert.deepStrictEqual(extras, [2]);
  assert.deepStrictEqual(ami, []);
});

test('unticking an extra queue leaves it in Asterisk right away', async () => {
  extras = [2];
  ami.length = 0;
  await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [] });
  assert.deepStrictEqual(extras, []);
  assert.deepStrictEqual(ami[0], ['remove', 'support']);
  assert.ok(!ami.some(([op, q]) => op === 'add' && q === 'support'));
});

test('switching the main queue leaves the old one; kept as an extra it comes back at penalty 1', async () => {
  extras = [];
  mainQueue = 1;
  ami.length = 0;
  await post('/agent/status', { status: 'available', queueId: 2, extraQueueIds: [1] });
  assert.deepStrictEqual(ami, [
    ['remove', 'sales'],
    ['add', 'support', 0],
    ['unpause', 'support'],
    ['add', 'sales', 1],
    ['unpause', 'sales'],
  ]);
});

test('logout leaves every queue and forgets the extras', async () => {
  extras = [2];
  ami.length = 0;
  await agents.syncQueueMembership(2, '1001', 'offline', 1);
  assert.deepStrictEqual(ami, [
    ['remove', 'sales'],
    ['remove', 'support'],
  ]);
  assert.deepStrictEqual(extras, []);
});

test("working campaign: the call's while on it / wrapping up; the main one once Available and the call is over", async () => {
  lastCall = { id: 20, name: 'Support' };
  status = 'acw';
  assert.strictEqual((await agents.findWorkingCampaign(2, '1001')).id, 20);
  status = 'available';
  callLive = true;
  assert.strictEqual((await agents.findWorkingCampaign(2, '1001')).id, 20, 'a call going on counts');
  callLive = false;
  assert.strictEqual((await agents.findWorkingCampaign(2, '1001')).id, 10);
  lastCall = null;
  status = 'acw';
  assert.strictEqual((await agents.findWorkingCampaign(2, '1001')).id, 10, 'no recent call: main campaign');
});
