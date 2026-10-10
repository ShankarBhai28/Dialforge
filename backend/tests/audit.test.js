// Audit log, MySQL sessions, force logout and the stale-agent cleanup -
// against fake db / ami / ari modules put in the require cache first.
const assert = require('node:assert');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
const amiCalls = [];
let openRows = [];
let activeCall = false;
const db = {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT id, name, scope, permissions FROM roles')) {
      return [[{ id: 4, name: 'Supervisor', scope: 'all', permissions: JSON.stringify({ live: ['view', 'logout'] }) }]];
    }
    if (s.startsWith('SELECT * FROM campaigns WHERE id = ?'))
      return [[{ id: Number(params[0]), name: 'Sales', status: 'active' }]];
    if (s.startsWith("SELECT id, username FROM users WHERE id = ? AND role = 'agent'"))
      return [[{ id: 21, username: 'agent21' }]];
    if (s.startsWith('SELECT id, status, extension_name, started_at FROM agent_status_log'))
      return [openRows.slice(0, 1)];
    if (s.includes('FROM agent_status_log asl JOIN users u')) return [openRows];
    if (s.startsWith('SELECT id FROM calls WHERE (from_extension')) return [activeCall ? [{ id: 1 }] : []];
    if (s.includes('asterisk_name FROM queues')) return [[{ asterisk_name: 'support_queue' }]];
    if (s.includes('SELECT queue_id FROM agent_status_log')) return [[{ queue_id: 1 }]];
    if (s.startsWith('SELECT data FROM sessions')) return [[{ data: JSON.stringify({ user: { id: 7 } }) }]];
    return [{ affectedRows: 1 }];
  },
};
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', db);
fake('ami.js', {
  queueRemove: async (q, iface) => amiCalls.push(['remove', q, iface]),
  queueAdd: async () => {},
  queuePause: async () => {},
  on: () => {},
});
const endpoint = { state: 'offline' };
fake('ari.js', {
  endpointState: async () => endpoint.state,
  isEndpointOnline: async () => endpoint.state === 'online',
});

const { redact, parseAdminPath, actionName } = require('../src/services/audit');
const { MySqlSessionStore } = require('../src/services/sessionStore');
const { sweepStaleAgents } = require('../src/services/agentLogout');
const { createApp } = require('../src/app');

const USERS = {
  super: { id: 1, username: 'boss', role: 'admin' },
  sup: { id: 30, username: 'sup', role: 'staff', roleId: 4 },
};
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    const u = USERS[req.headers['x-test-user']];
    req.session = u ? { user: { ...u, loginAt: Date.now() }, destroy: (cb) => cb() } : {};
    next();
  },
  webDistDir: '/nonexistent',
});
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  sql.length = 0;
  amiCalls.length = 0;
  openRows = [];
  activeCall = false;
});
const call = async (who, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'x-test-user': who, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const auditRows = () => sql.filter(([s]) => s.startsWith('INSERT INTO audit_log'));
const settle = () => new Promise((r) => setTimeout(r, 30));

test('audit helpers: secrets hidden, admin paths named', () => {
  assert.deepStrictEqual(redact({ username: 'x', password: 'p', nested: [{ sip_password: 's' }] }), {
    username: 'x',
    password: '[hidden]',
    nested: [{ sip_password: '[hidden]' }],
  });
  assert.deepStrictEqual(parseAdminPath('/admin/campaigns/5'), {
    resource: 'campaigns',
    table: 'campaigns',
    id: '5',
    sub: null,
  });
  assert.strictEqual(actionName('PUT', parseAdminPath('/admin/campaigns/5')), 'campaigns.edit');
  assert.strictEqual(actionName('POST', parseAdminPath('/admin/campaigns/5/dialer')), 'campaigns.dialer');
  assert.strictEqual(actionName('POST', parseAdminPath('/admin/leads/import')), 'leads.import');
  assert.strictEqual(actionName('POST', parseAdminPath('/admin/users/9/password')), 'users.password');
  assert.strictEqual(parseAdminPath('/agent/status'), null);
});

test('every admin change is logged with who, the row before and after, and the request (no passwords)', async () => {
  await call('super', 'PUT', '/admin/campaigns/5', { name: 'Sales 2', status: 'paused' });
  await settle();
  const [row] = auditRows();
  assert.ok(row, 'audit row written');
  const [, p] = row;
  // user_id, username, action, entity, entity_id, status, summary, request, before, after, ip
  assert.strictEqual(p[0], 1);
  assert.strictEqual(p[1], 'boss');
  assert.strictEqual(p[2], 'campaigns.edit');
  assert.strictEqual(p[3], 'campaigns');
  assert.strictEqual(p[4], '5');
  assert.match(p[7], /"name":"Sales 2"/);
  assert.match(p[8], /"name":"Sales"/); // before

  sql.length = 0;
  await call('super', 'POST', '/admin/users/9/password', { password: 'n3w-secret-pw' });
  await settle();
  const [, pw] = auditRows()[0];
  assert.strictEqual(pw[2], 'users.password');
  assert.doesNotMatch(pw[7], /n3w-secret-pw/);
});

test('refused requests are logged too, with the reason', async () => {
  await call('sup', 'DELETE', '/admin/campaigns/5');
  await settle();
  const [, p] = auditRows()[0];
  assert.strictEqual(p[1], 'sup');
  assert.strictEqual(p[5], 403);
  assert.match(p[6], /refused: Your role doesn't allow: Campaigns - Delete/);
});

test('force logout: closes the status, leaves the queue, ends the login; not during a call', async () => {
  openRows = [{ id: 3, user_id: 21, status: 'available', extension_name: '1001' }];
  activeCall = true;
  const busy = await call('sup', 'POST', '/admin/live-agents/21/logout');
  assert.strictEqual(busy.status, 409);
  assert.match(busy.body.error, /on a call/);

  activeCall = false;
  const r = await call('sup', 'POST', '/admin/live-agents/21/logout');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.was, 'available');
  assert.ok(sql.some(([s]) => s.startsWith('UPDATE agent_status_log SET ended_at = NOW() WHERE user_id = ?')));
  assert.deepStrictEqual(amiCalls, [['remove', 'support_queue', 'PJSIP/1001']]);
});

test('stale agents: logged out only after the line is gone for the whole grace time, never on an ARI hiccup', async () => {
  openRows = [{ user_id: 21, status: 'break', extension_name: '1001' }];
  const t0 = 1_000_000;
  endpoint.state = null; // ARI didn't answer
  assert.deepStrictEqual(await sweepStaleAgents({ minutes: 10, now: t0 }), []);
  endpoint.state = 'offline';
  assert.deepStrictEqual(await sweepStaleAgents({ minutes: 10, now: t0 }), []); // first seen offline
  endpoint.state = 'online';
  assert.deepStrictEqual(await sweepStaleAgents({ minutes: 10, now: t0 + 5 * 60000 }), []); // came back: clock resets
  endpoint.state = 'offline';
  assert.deepStrictEqual(await sweepStaleAgents({ minutes: 10, now: t0 + 6 * 60000 }), []);
  assert.deepStrictEqual(await sweepStaleAgents({ minutes: 10, now: t0 + 17 * 60000 }), [21]);
  assert.ok(auditRows().some(([, p]) => p[2] === 'agent.auto_logout' && p[1] === 'system'));
});

test('sessions in MySQL: saved with the user id, read back, removed per user', async () => {
  const store = new MySqlSessionStore({ pool: db, cleanupMs: 0 });
  await new Promise((r) => store.set('abc', { cookie: { expires: new Date(Date.now() + 1000) }, user: { id: 7 } }, r));
  const insert = sql.find(([s]) => s.startsWith('INSERT INTO sessions'));
  assert.deepStrictEqual(insert[1].slice(0, 2), ['abc', 7]);
  const got = await new Promise((r) => store.get('abc', (err, s) => r(s)));
  assert.deepStrictEqual(got, { user: { id: 7 } });
  await store.destroyUser(7);
  assert.ok(sql.some(([s, p]) => s === 'DELETE FROM sessions WHERE user_id = ?' && p[0] === 7));
});
