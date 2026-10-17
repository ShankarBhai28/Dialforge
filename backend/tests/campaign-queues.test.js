// Campaign queues: a campaign has a main queue and can have more queues. An
// agent working it takes the main one and (unless the campaign says "take
// all") picks which of the others - all rung alike, paused / left with the
// main one, forgotten at logout.
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
let mainQueue = 1; // the last status row's queue
let takeAll = false;
let shiftRows = []; // agents holding removed queues (leaveRemovedCampaignQueues)
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
    if (s.startsWith('SELECT x.user_id, x.queue_id')) return [shiftRows];
    if (s.startsWith('DELETE FROM agent_extra_queues')) {
      extras = [];
      return [{}];
    }
    if (s.startsWith('INSERT INTO agent_extra_queues')) {
      extras = params[0].map(([, q]) => q);
      return [{}];
    }
    // The agent's teams work Care (main: sales; also support + billing) and Collect (main: support).
    if (s.includes('FROM team_members tm'))
      return [
        [
          { id: 1, name: 'sales', campaign_name: 'Care', campaign_id: 10, take_all: takeAll ? 1 : 0 },
          { id: 2, name: 'support', campaign_name: 'Collect', campaign_id: 20, take_all: 0 },
        ],
      ];
    if (s.includes('FROM campaign_queues cq'))
      return [
        [
          { campaign_id: 10, id: 2, name: 'support' },
          { campaign_id: 10, id: 3, name: 'billing' },
        ],
      ];
    if (s.startsWith('SELECT queue_id FROM campaigns WHERE id = ?')) return [[{ queue_id: 1 }]];
    if (s.startsWith('SELECT status FROM agent_status_log')) return [[{ status: 'available' }]];
    if (s.startsWith('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: mainQueue }]];
    return [[]];
  },
});
fake('ami.js', {
  queueAdd: async (q) => ami.push(['add', q]),
  queuePause: async (q, iface, paused) => ami.push([paused ? 'pause' : 'unpause', q]),
  queueRemove: async (q, iface) => ami.push(['remove', q, iface]),
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
const request = (method, url, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      `${base}${url}`,
      {
        method,
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
const post = (url, body) => request('POST', url, body);
const reset = () => {
  ami.length = 0;
  mainQueue = 1;
  takeAll = false;
};

test("the agent's queue list: each campaign's main queue with its other queues", async () => {
  const [code, rows] = await request('GET', '/queues');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(
    rows.map((r) => [r.campaign_name, r.id, r.extra_queues.map((q) => q.id), r.take_all]),
    [
      ['Care', 1, [2, 3], false],
      ['Collect', 2, [], false],
    ],
  );
});

test('Available on a campaign with some of its queues: all joined alike; a break pauses them all', async () => {
  reset();
  extras = [];
  const [code] = await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [2, 1] });
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(extras, [2], 'the main queue is never its own extra');
  assert.deepStrictEqual(ami, [
    ['add', 'sales'],
    ['unpause', 'sales'],
    ['add', 'support'],
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

test("a queue that isn't the campaign's is refused, nothing changes", async () => {
  reset();
  extras = [];
  mainQueue = 2;
  const [code, body] = await post('/agent/status', { status: 'available', queueId: 2, extraQueueIds: [3] });
  assert.strictEqual(code, 403);
  assert.strictEqual(body.error, 'one of the queues is not in the Collect campaign');
  assert.deepStrictEqual(extras, []);
  assert.deepStrictEqual(ami, []);
});

test('"agents take all queues": every queue of the campaign, whatever was ticked', async () => {
  reset();
  takeAll = true;
  extras = [];
  await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [] });
  assert.deepStrictEqual(extras, [2, 3]);
});

test('unticking a queue leaves it in Asterisk right away', async () => {
  reset();
  extras = [2];
  await post('/agent/status', { status: 'available', queueId: 1, extraQueueIds: [] });
  assert.deepStrictEqual(extras, []);
  assert.deepStrictEqual(ami[0], ['remove', 'support', 'PJSIP/1001']);
  assert.ok(!ami.some(([op, q]) => op === 'add' && q === 'support'));
});

test("switching campaign leaves the old campaign's queues", async () => {
  reset();
  extras = [3];
  await post('/agent/status', { status: 'available', queueId: 2, extraQueueIds: [] });
  assert.deepStrictEqual(ami, [
    ['remove', 'sales', 'PJSIP/1001'],
    ['remove', 'billing', 'PJSIP/1001'],
    ['add', 'support'],
    ['unpause', 'support'],
  ]);
});

test('logout leaves every queue and forgets the choice', async () => {
  reset();
  extras = [2];
  await agents.syncQueueMembership(2, '1001', 'offline', 1);
  assert.deepStrictEqual(ami, [
    ['remove', 'sales', 'PJSIP/1001'],
    ['remove', 'support', 'PJSIP/1001'],
  ]);
  assert.deepStrictEqual(extras, []);
});

test("a queue taken off a campaign: its agents leave it; agents of another campaign that has it don't", async () => {
  reset();
  sql.length = 0;
  shiftRows = [
    { user_id: 2, queue_id: 3, asterisk_name: 'billing', ext: '1001', main_queue: 1 }, // works Care
    { user_id: 5, queue_id: 3, asterisk_name: 'billing', ext: '1005', main_queue: 2 }, // works Collect
  ];
  await agents.leaveRemovedCampaignQueues(10, [3]);
  assert.deepStrictEqual(ami, [['remove', 'billing', 'PJSIP/1001']]);
  const deletes = sql.filter(([s]) => s.startsWith('DELETE FROM agent_extra_queues'));
  assert.deepStrictEqual(
    deletes.map(([, p]) => p),
    [[2, 3]],
  );
});
