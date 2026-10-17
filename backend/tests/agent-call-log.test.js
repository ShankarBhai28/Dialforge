// An agent's calls across campaigns: the call log lists every campaign they
// worked (not calls of whoever used their extension before), and a call of
// an earlier campaign still gets its disposition - that campaign's list.
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
let ownCall = null; // what the "this agent's call" lookup finds
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  if (s.startsWith('SELECT ca.id, ca.campaign_id, ca.lead_id FROM calls ca')) return [ownCall ? [ownCall] : []];
  if (s.startsWith('SELECT ca.id, ca.lead_id, ca.to_number')) return [[]];
  if (s.startsWith('SELECT code, label, is_final')) {
    const code = params[0] === 9 ? 'old_sale' : 'sale';
    return [[{ code, label: code, is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0, is_success: 1 }]];
  }
  // The agent works campaign 4 now.
  if (s.startsWith('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: 40 }]];
  if (s.startsWith('SELECT asterisk_name FROM queues')) return [[{ asterisk_name: 'q40' }]];
  if (s.startsWith('SELECT c.* FROM campaigns c JOIN queues q')) return [[{ id: 4 }]];
  if (s.startsWith('SELECT id, phone, campaign_id, status FROM leads'))
    return [[{ id: 7, phone: '9840012345', campaign_id: 9, status: 'new' }]];
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
        res.on('end', () => resolve([res.statusCode, JSON.parse(text)]));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

test("the call log: the agent's calls with their campaign, never by extension alone", async () => {
  sql.length = 0;
  const [code] = await call('GET', '/calls?period=today');
  assert.strictEqual(code, 200);
  const [s, params] = sql.find(([x]) => x.includes('FROM calls ca'));
  assert.match(s, /LEFT JOIN campaigns cmp ON cmp\.id = ca\.campaign_id/);
  assert.match(s, /ca\.agent_user_id = \? OR EXISTS \( SELECT 1 FROM agent_status_log mine/);
  // An extension counts only while this agent was on it at the call's time.
  assert.match(s, /mine\.started_at <= COALESCE\(ca\.end_time, NOW\(\)\)/);
  assert.doesNotMatch(s, /ca\.from_extension = \?/);
  assert.deepStrictEqual(params.slice(0, 2), [2, 2]);
});

test("dispositions for a call of an earlier campaign: that campaign's; someone else's call: 404", async () => {
  ownCall = { id: 59, campaign_id: 9, lead_id: 7 };
  const [code, list] = await call('GET', '/agent/dispositions?callId=59');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual(
    list.map((d) => d.code),
    ['old_sale'],
  );
  const [, now] = await call('GET', '/agent/dispositions');
  assert.deepStrictEqual(
    now.map((d) => d.code),
    ['sale'],
    'without callId: the current campaign',
  );
  ownCall = null;
  const [missing] = await call('GET', '/agent/dispositions?callId=60');
  assert.strictEqual(missing, 404);
});

test("another campaign's lead: refused, unless it's for this agent's own call of that lead", async () => {
  ownCall = null;
  const [refused, body] = await call('POST', '/leads/7/disposition', { status: 'old_sale' });
  assert.strictEqual(refused, 403);
  assert.strictEqual(body.error, 'that lead is not in your current campaign');
  ownCall = { id: 61, campaign_id: 9, lead_id: 8 }; // their call, but of another lead
  const [other] = await call('POST', '/leads/7/disposition', { status: 'old_sale', callId: 61 });
  assert.strictEqual(other, 403);
  ownCall = { id: 59, campaign_id: 9, lead_id: 7 };
  const [ok] = await call('POST', '/leads/7/disposition', { status: 'old_sale', callId: 59 });
  assert.notStrictEqual(ok, 403);
});
