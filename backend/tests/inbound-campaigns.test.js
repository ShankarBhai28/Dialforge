// Inbound campaigns: Inbound dial mode (no dialer), a campaign's queues
// besides its main one, "agents take all queues", and DID numbers routed to
// a queue.
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
const existingQueues = [1, 2, 3];
let campaignQueues = [2, 3]; // campaign 7's queues before an edit
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  if (s.startsWith('SELECT id FROM queues WHERE id IN (?)'))
    return [params[0].filter((id) => existingQueues.includes(id)).map((id) => ({ id }))];
  if (s.startsWith('SELECT id FROM queues WHERE id = ?'))
    return [existingQueues.includes(Number(params[0])) ? [{ id: Number(params[0]) }] : []];
  if (s.startsWith('INSERT INTO campaigns')) return [{ insertId: 7 }];
  if (s.startsWith('SELECT id, status FROM campaigns')) return [[{ id: 7, status: 'active' }]];
  if (s.startsWith('SELECT queue_id FROM campaign_queues')) return [campaignQueues.map((id) => ({ queue_id: id }))];
  if (s.startsWith('SELECT queue_id FROM campaigns WHERE id = ?')) return [[{ queue_id: 1 }]];
  if (s.startsWith('SELECT * FROM campaigns WHERE id = ?'))
    return [[{ id: 7, dial_mode: 'inbound', status: 'active', queue_id: 1, dialer_state: 'stopped' }]];
  if (s.startsWith('SELECT id FROM dids WHERE id = ?')) return [[{ id: 4 }]];
  return [[]];
};
const conn = {
  query: q,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release() {},
};
fake('db.js', { query: q, getConnection: async () => conn });
fake('ami.js', { queueRemove: async () => {}, queueAdd: async () => {}, queuePause: async () => {} });

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
const call = (method, url, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
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
const ran = (re) => sql.filter(([s]) => re.test(s));

test('a new Inbound campaign with three queues, agents take all', async () => {
  sql.length = 0;
  const [code] = await call('POST', '/admin/campaigns', {
    name: 'Care',
    queueId: 1,
    dialMode: 'inbound',
    extraQueueIds: [2, 3, 1, 2],
    takeAllQueues: true,
  });
  assert.strictEqual(code, 201);
  const [, [row]] = ran(/^INSERT INTO campaigns SET/)[0];
  assert.strictEqual(row.dial_mode, 'inbound');
  assert.strictEqual(row.agents_take_all_queues, 1);
  assert.deepStrictEqual(ran(/^INSERT INTO campaign_queues/)[0][1], [
    [
      [7, 2],
      [7, 3],
    ],
  ]);
});

test("a queue that doesn't exist is refused, nothing saved", async () => {
  sql.length = 0;
  const [code, body] = await call('POST', '/admin/campaigns', { name: 'X', queueId: 1, extraQueueIds: [9] });
  assert.strictEqual(code, 400);
  assert.strictEqual(body.error, 'one of the queues does not exist');
  assert.strictEqual(ran(/^INSERT INTO campaigns/).length, 0);
  const [code2, body2] = await call('POST', '/admin/campaigns', { name: 'X', extraQueueIds: [2] });
  assert.strictEqual(code2, 400);
  assert.strictEqual(body2.error, 'pick the main queue first');
});

test('editing: Inbound stops the dialer; a removed queue is left by agents working the campaign', async () => {
  sql.length = 0;
  campaignQueues = [2, 3];
  const [code] = await call('PUT', '/admin/campaigns/7', {
    name: 'Care',
    queueId: 1,
    dialMode: 'inbound',
    extraQueueIds: [2],
  });
  assert.strictEqual(code, 200);
  assert.ok(ran(/^UPDATE campaigns SET dialer_state = 'stopped'/).length);
  assert.deepStrictEqual(ran(/^INSERT INTO campaign_queues/)[0][1], [[[7, 2]]]);
  const left = ran(/^SELECT x\.user_id, x\.queue_id/);
  assert.deepStrictEqual(left[0][1], [[3]], 'agents holding queue 3 are looked up');
});

test('editing without the queue list keeps the queues', async () => {
  sql.length = 0;
  await call('PUT', '/admin/campaigns/7', { name: 'Care', queueId: 1, dialMode: 'manual' });
  assert.strictEqual(ran(/campaign_queues/).length, 0);
});

test("the dialer can't start an Inbound campaign", async () => {
  const [code, body] = await call('POST', '/admin/campaigns/7/dialer', { action: 'start' });
  assert.strictEqual(code, 400);
  assert.match(body.error, /an Inbound campaign doesn't use the dialer/);
});

test('a DID number routes to a queue', async () => {
  sql.length = 0;
  const [code] = await call('POST', '/admin/dids', { number: '04461234567', queueId: 2 });
  assert.strictEqual(code, 201);
  assert.deepStrictEqual(ran(/^INSERT INTO dids/)[0][1], ['04461234567', 2]);
  const [bad, body] = await call('PUT', '/admin/dids/4', { queueId: 9 });
  assert.strictEqual(bad, 400);
  assert.strictEqual(body.error, 'queue not found');
  const [ok] = await call('PUT', '/admin/dids/4', { queueId: 3 });
  assert.strictEqual(ok, 200);
  assert.deepStrictEqual(ran(/^UPDATE dids SET queue_id/)[0][1], [3, '4']);
});
