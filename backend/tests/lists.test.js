// Lists: moving a list to another campaign moves its leads; a list's numbers.
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  if (s.startsWith('SELECT id FROM campaigns WHERE id = ?')) return [[{ id: params[0] }]];
  if (s.startsWith('SELECT id, campaign_id FROM lists')) return [[{ id: 7, campaign_id: 1 }]];
  if (s.startsWith('UPDATE leads SET campaign_id')) return [{ affectedRows: 120 }];
  if (s.startsWith('SELECT ls.id, ls.name, ls.source'))
    return [
      [{ id: 7, name: 'Oct', source: 'Vendor X', is_active: 1, campaign_id: 1, campaign: 'Sales', max_attempts: 3 }],
    ];
  if (s.startsWith('SELECT code, label')) return [[{ code: 'sale', label: 'Sale', is_success: 1 }]];
  if (s.startsWith('SELECT COUNT(*) AS total'))
    return [[{ total: 100, fresh: 40, called: 60, dialable: 30, scheduled: 10, done: 20, success: 5, dnc: 1 }]];
  if (s.startsWith('SELECT COUNT(*) AS calls'))
    return [[{ calls: 90, connected: 35, reached: 30, talk_seconds: 4200, last_call_at: null }]];
  if (s.startsWith('SELECT status, COUNT(*)')) return [[{ status: 'sale', n: 5 }]];
  if (s.includes('FROM list_imports'))
    return [[{ id: 1, file_name: 'oct.xlsx', total: 100, imported: 98, updated: 0, skipped: 2, username: 'boss' }]];
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
// Plain node:http (not fetch): see click2call-fail.test.js.
const call = (method, url, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      base + url,
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

test('moving a list to another campaign moves its leads, their pending callbacks, and clears the old hopper', async () => {
  sql.length = 0;
  const [status, body] = await call('PUT', '/admin/lists/7', { name: 'Oct', campaignId: 4, source: ' Vendor X ' });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.notes, ['120 leads moved to the new campaign with the list']);
  assert.ok(sql.some(([s, p]) => /^UPDATE lists SET .*source = \?/.test(s) && p.includes('Vendor X')));
  assert.ok(sql.some(([s, p]) => /^UPDATE leads SET campaign_id = \? WHERE list_id = \?/.test(s) && p[0] === 4));
  assert.ok(
    sql.some(([s, p]) => /^UPDATE callbacks SET campaign_id = \? WHERE status = 'pending'/.test(s) && p[0] === 4),
  );
  assert.ok(sql.some(([s]) => /^DELETE FROM dial_hopper WHERE status = 'ready'/.test(s)));
});

test('same campaign: only the list changes, no lead is touched', async () => {
  sql.length = 0;
  const [, body] = await call('PUT', '/admin/lists/7', { name: 'Oct 2', campaignId: 1 });
  assert.deepStrictEqual(body.notes, []);
  assert.ok(!sql.some(([s]) => s.startsWith('UPDATE leads')));
});

test("a list's numbers: progress, reach, success, calls and its uploads", async () => {
  const [status, body] = await call('GET', '/admin/lists/7/stats');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.list.source, 'Vendor X');
  assert.deepStrictEqual(body.leads, {
    total: 100,
    fresh: 40,
    called: 60,
    reached: 30,
    success: 5,
    dialable: 30,
    scheduled: 10,
    done: 20,
    dnc: 1,
  });
  assert.deepStrictEqual(body.calls, { total: 90, connected: 35, talkSeconds: 4200, lastCallAt: null });
  assert.deepStrictEqual(body.byStatus, [{ status: 'sale', label: 'Sale', count: 5, success: true }]);
  assert.strictEqual(body.imports[0].fileName, 'oct.xlsx');
  assert.strictEqual(body.imports[0].by, 'boss');
});
