// Editing a pending callback (admin and agent): time rules, who may take it,
// and the lead's next call moving with the new time.
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
let cb = { id: 5, lead_id: 7, campaign_id: 4, user_id: null, callback_at: '2026-10-21 10:00:00', note: 'old' };
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  if (s.startsWith('SELECT campaign_id FROM callbacks')) return [cb ? [{ campaign_id: cb.campaign_id }] : []];
  if (s.startsWith('SELECT id, lead_id, campaign_id, user_id, callback_at, note FROM callbacks'))
    return [cb ? [cb] : []];
  if (s.startsWith('SELECT DISTINCT u.id, u.username FROM users u'))
    return [
      [
        { id: 11, username: 'agent1001' },
        { id: 12, username: 'agent1002' },
      ],
    ];
  if (s.startsWith("SELECT id FROM users WHERE id = ? AND role = 'agent'")) return [[{ id: params[0] }]];
  // The agent (user 2) works campaign 4.
  if (s.startsWith('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: 40 }]];
  if (s.startsWith('SELECT asterisk_name FROM queues')) return [[{ asterisk_name: 'q40' }]];
  if (s.startsWith('SELECT c.* FROM campaigns c JOIN queues q')) return [[{ id: 4 }]];
  if (s.startsWith('SELECT id FROM callbacks WHERE id = ?')) {
    const [, me, campaign] = params;
    const visible = cb && (cb.user_id === me || (cb.user_id === null && cb.campaign_id === campaign));
    return [visible ? [{ id: cb.id }] : []];
  }
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

let role = 'admin';
const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = {
      user:
        role === 'admin'
          ? { id: 1, username: 'boss', role: 'admin', loginAt: Date.now() }
          : { id: 2, username: 'agent1001', role: 'agent', extensionName: '1001', loginAt: Date.now() },
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
const put = (url, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${base}${url}`,
      {
        method: 'PUT',
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
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

test('admin: new time, note and agent; the lead is called at the new time', async () => {
  role = 'admin';
  sql.length = 0;
  const when = inHours(3);
  const [code, body] = await put('/admin/callbacks/5', { callbackAt: when, note: '  call after lunch ', userId: 12 });
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(body.callback.note, 'call after lunch');
  const [, p] = ran(/^UPDATE callbacks SET callback_at = \?, note = \?, user_id = \?/)[0];
  assert.strictEqual(new Date(p[0]).toISOString(), when);
  assert.deepStrictEqual(p.slice(1), ['call after lunch', 12, 5]);
  const [, lead] = ran(/^UPDATE leads SET next_call_at = \? WHERE id = \? AND is_final = 0/)[0];
  assert.strictEqual(new Date(lead[0]).toISOString(), when);
  assert.strictEqual(lead[1], 7);
});

test("admin: a time in the past / over 90 days / an agent outside the campaign's teams is refused", async () => {
  role = 'admin';
  sql.length = 0;
  const [past, a] = await put('/admin/callbacks/5', { callbackAt: inHours(-2) });
  assert.strictEqual(past, 400);
  assert.strictEqual(a.error, 'callback time is in the past');
  const [far, b] = await put('/admin/callbacks/5', { callbackAt: inHours(24 * 100) });
  assert.strictEqual(far, 400);
  assert.strictEqual(b.error, 'callback must be within 90 days');
  const [other, c] = await put('/admin/callbacks/5', { callbackAt: inHours(2), userId: 99 });
  assert.strictEqual(other, 400);
  assert.strictEqual(c.error, "that agent isn't in a team working this campaign");
  assert.strictEqual(ran(/^UPDATE callbacks/).length, 0, 'nothing changed');
});

test('admin: "anyone in the campaign" (userId null); a done / missing callback -> 404', async () => {
  role = 'admin';
  sql.length = 0;
  await put('/admin/callbacks/5', { callbackAt: inHours(2), note: '', userId: null });
  assert.deepStrictEqual(ran(/^UPDATE callbacks SET/)[0][1].slice(1), [null, null, 5]);
  const saved = cb;
  cb = null;
  const [code] = await put('/admin/callbacks/5', { callbackAt: inHours(2) });
  assert.strictEqual(code, 404);
  cb = saved;
});

test('agent: their "anyone" callback - reschedule and keep it for themselves; not theirs -> 404', async () => {
  role = 'agent';
  sql.length = 0;
  cb = { ...cb, user_id: null, campaign_id: 4 };
  const [code] = await put('/agent/callbacks/5', { callbackAt: inHours(1), note: 'asked for evening', mine: true });
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(ran(/^UPDATE callbacks SET/)[0][1].slice(1), ['asked for evening', 2, 5]);
  // Another agent's callback is not theirs to change.
  cb = { ...cb, user_id: 11 };
  const [theirs] = await put('/agent/callbacks/5', { callbackAt: inHours(1) });
  assert.strictEqual(theirs, 404);
  // Their own callback: give it to anyone in the campaign.
  sql.length = 0;
  cb = { ...cb, user_id: 2 };
  await put('/agent/callbacks/5', { callbackAt: inHours(1), mine: false });
  assert.strictEqual(ran(/^UPDATE callbacks SET/)[0][1][2], null);
});
