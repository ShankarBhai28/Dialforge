// The agent's form as typed is kept (form_drafts) so closing the lead or a
// reload loses nothing: restored until saved or discarded, rows kept for support.
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
let draftRow = null;
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  // The agent works campaign 4, whose form is 3 (fields amount, plan).
  if (s.startsWith('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: 40 }]];
  if (s.startsWith('SELECT asterisk_name FROM queues')) return [[{ asterisk_name: 'q40' }]];
  if (s.startsWith('SELECT c.* FROM campaigns c JOIN queues q')) return [[{ id: 4, form_id: 3 }]];
  if (s.startsWith('SELECT * FROM forms')) return [[{ id: 3, name: 'Loan', status: 'active' }]];
  if (s.startsWith('SELECT * FROM form_fields'))
    return [
      [
        { form_id: 3, field_key: 'amount', label: 'Amount', field_type: 'number', is_required: 0, options: null },
        { form_id: 3, field_key: 'plan', label: 'Plan', field_type: 'text', is_required: 0, options: null },
      ],
    ];
  if (s.startsWith('SELECT data, updated_at FROM form_drafts')) return [draftRow ? [draftRow] : []];
  if (s.startsWith('INSERT INTO form_responses')) return [{ insertId: 70 }];
  return [[]];
};
fake('db.js', {
  query: q,
  getConnection: async () => ({
    query: q,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
  }),
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
const call = (method, url, body) =>
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
        res.on('end', () => resolve([res.statusCode, text ? JSON.parse(text) : null]));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
const ran = (re) => sql.filter(([s]) => re.test(s));

test("typing is kept per lead: only the form's fields; again it updates the same row and reopens it", async () => {
  sql.length = 0;
  const [code] = await call('PUT', '/agent/form-draft', {
    leadId: 7,
    callId: 55,
    data: { amount: '4500', plan: 'Gold', sneaky: 'x' },
  });
  assert.strictEqual(code, 200);
  const [s, params] = ran(/^INSERT INTO form_drafts/)[0];
  assert.match(s, /ON DUPLICATE KEY UPDATE .*saved_at = NULL, discarded_at = NULL/);
  assert.deepStrictEqual(params, [2, 'lead:7', 3, 4, 7, 55, JSON.stringify({ amount: '4500', plan: 'Gold' })]);
  // No lead: under the call; neither: the blank form.
  await call('PUT', '/agent/form-draft', { callId: 55, data: {} });
  await call('PUT', '/agent/form-draft', { data: {} });
  assert.deepStrictEqual(
    ran(/^INSERT INTO form_drafts/).map(([, p]) => p[1]),
    ['lead:7', 'call:55', 'blank'],
  );
});

test('a bad or oversized draft is refused', async () => {
  const [bad] = await call('PUT', '/agent/form-draft', { leadId: 7, data: [1] });
  assert.strictEqual(bad, 400);
  const [big, body] = await call('PUT', '/agent/form-draft', { leadId: 7, data: { plan: 'x'.repeat(70000) } });
  assert.strictEqual(big, 400);
  assert.strictEqual(body.error, 'the form is too large to keep');
});

test('reopening: the unsaved draft of this form comes back; none -> null', async () => {
  sql.length = 0;
  draftRow = { data: JSON.stringify({ amount: 4500 }), updated_at: '2026-10-20T09:32:00.000Z' };
  const [code, d] = await call('GET', '/agent/form-draft?leadId=7');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(d, { data: { amount: 4500 }, updatedAt: '2026-10-20T09:32:00.000Z' });
  const [s, params] = ran(/^SELECT data, updated_at FROM form_drafts/)[0];
  assert.match(s, /saved_at IS NULL AND discarded_at IS NULL/);
  assert.deepStrictEqual(params, [2, 'lead:7', 3]);
  draftRow = null;
  const [, none] = await call('GET', '/agent/form-draft?leadId=7');
  assert.strictEqual(none, null);
});

test('Discard marks it discarded; Save Form marks the screen draft saved (rows kept)', async () => {
  sql.length = 0;
  await call('DELETE', '/agent/form-draft?leadId=7');
  assert.deepStrictEqual(ran(/^UPDATE form_drafts SET discarded_at = NOW\(\)/)[0][1], [2, 'lead:7']);
  // A first call without a lead: the answers stay with the call; its draft is done.
  const [code] = await call('POST', '/agent/form-responses', { callId: 55, data: { amount: 10 } });
  assert.strictEqual(code, 400, 'call 55 is not this agent in the fake'); // the call check runs first
  await call('POST', '/agent/form-responses', { data: { amount: 10 } });
  assert.deepStrictEqual(ran(/^UPDATE form_drafts SET saved_at = NOW\(\)/)[0][1], [2, 'blank']);
  assert.ok(!ran(/^DELETE FROM form_drafts/).length, 'drafts are never deleted');
});
