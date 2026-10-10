// Admin roles: role rules, what a staff login may reach, and team scope in
// the queries. A fake db module is put in the require cache first, so the
// real routes run without MySQL.
const assert = require('node:assert');
const path = require('node:path');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
const ROLES = {
  4: {
    id: 4,
    name: 'Supervisor',
    scope: 'all',
    permissions: {
      leads: ['view', 'import'],
      campaigns: ['view', 'create'],
      users: ['view', 'create', 'edit', 'password'],
    },
  },
  // Saved in the first format ('manage'): read as every action, minus what own-teams roles can't have.
  5: { id: 5, name: 'Team Leader', scope: 'team', permissions: { calls: 'view', campaigns: 'manage', dialer: 'view' } },
};
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT id, name, scope, permissions FROM roles')) {
      const r = ROLES[params[0]];
      return [r ? [{ ...r, permissions: JSON.stringify(r.permissions) }] : []];
    }
    if (s.includes('tc.campaign_id AS id')) return [[{ id: 7 }]];
    if (s.includes('a.user_id AS id')) return [[{ id: 21 }, { id: 22 }]];
    if (s.includes('tm.team_id AS id')) return [[{ id: 3 }]];
    if (s.includes('COUNT(*)')) return [[{ n: 0, c: 0 }]];
    if (s.startsWith('SELECT id, role FROM users WHERE id')) return [[{ id: params[0], role: 'admin' }]];
    return [[]];
  },
});

const { createApp } = require('../src/app');
const { parseRole, scopeCondition, campaignInScope } = require('../src/services/access');
const { staffView } = require('../src/realtime/hub');

const USERS = {
  super: { id: 1, username: 'boss', role: 'admin' },
  sup: { id: 30, username: 'sup', role: 'staff', roleId: 4 },
  tl: { id: 31, username: 'tl', role: 'staff', roleId: 5 },
  agent: { id: 21, username: 'agent', role: 'agent', extensionName: '1001' },
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

async function call(who, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'x-test-user': who, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('role rules: ticked actions per screen; any action brings View; unknown ones are refused', () => {
  const { role } = parseRole({
    name: ' Team Leader ',
    scope: 'team',
    permissions: { live: ['view'], dialer: ['control'], leads: ['edit', 'import'] },
  });
  assert.strictEqual(role.name, 'Team Leader');
  assert.deepStrictEqual(role.permissions.live, ['view']);
  assert.deepStrictEqual(role.permissions.dialer, ['view', 'control']); // control brings view
  assert.deepStrictEqual(role.permissions.leads, ['view', 'edit', 'import']);
  assert.deepStrictEqual(role.permissions.users, []);
  assert.strictEqual(Object.keys(role.permissions).length, 15);
  assert.match(parseRole({ name: 'X', permissions: { roles: ['view'] } }).error, /unknown screen/);
  assert.match(parseRole({ name: 'X', permissions: { live: ['delete'] } }).error, /no "delete" action/);
  assert.match(parseRole({ name: 'X', permissions: { live: 'view' } }).error, /list of actions/);
  // own-teams roles can't have what reaches outside their teams - said, not silently dropped
  assert.match(
    parseRole({ name: 'X', scope: 'team', permissions: { campaigns: ['create'] } }).error,
    /Campaigns: Create needs a role that sees all teams/,
  );
  assert.ok(parseRole({ name: 'X', scope: 'all', permissions: { campaigns: ['create'] } }).role);
  assert.match(parseRole({ name: 'Super Admin', permissions: { live: ['view'] } }).error, /built-in/);
  assert.match(parseRole({ name: 'X', permissions: {} }).error, /at least one screen/);
  assert.match(parseRole({ name: 'X', scope: 'region', permissions: { live: ['view'] } }).error, /scope/);
});

test('scope helpers: all = no condition; team = only its ids (none = matches nothing)', () => {
  assert.deepStrictEqual(scopeCondition(null, 'campaigns', 'c.id'), ['', []]);
  assert.deepStrictEqual(scopeCondition({ campaignIds: [7], agentIds: [] }, 'campaigns', 'c.id'), [
    'c.id IN (?)',
    [[7]],
  ]);
  assert.deepStrictEqual(scopeCondition({ campaignIds: [], agentIds: [] }, 'agents', 'u.id'), ['u.id IN (?)', [[-1]]]);
  assert.strictEqual(campaignInScope(null, 9), true);
  assert.strictEqual(campaignInScope({ campaignIds: [7] }, '7'), true);
  assert.strictEqual(campaignInScope({ campaignIds: [7] }, 9), false);
});

test('staff: each change needs its own tick; no tick at all hides the screen', async () => {
  assert.strictEqual((await call('sup', 'GET', '/admin/leads')).status, 200);
  const edit = await call('sup', 'PUT', '/admin/leads/1', { phone: '9840012345' });
  assert.strictEqual(edit.status, 403);
  assert.match(edit.body.error, /Leads & Lists - Edit/);
  // Campaigns: Create ticked, Delete not
  assert.notStrictEqual((await call('sup', 'POST', '/admin/campaigns', {})).status, 403);
  assert.strictEqual((await call('sup', 'DELETE', '/admin/campaigns/1')).status, 403);
  assert.strictEqual((await call('sup', 'GET', '/admin/dnc')).status, 403);
  assert.strictEqual((await call('sup', 'GET', '/admin/campaigns')).status, 200); // lookup list
  assert.strictEqual((await call('agent', 'GET', '/admin/campaigns')).status, 403);
});

test('only a Super Admin manages roles and admin-side accounts', async () => {
  assert.strictEqual(
    (await call('sup', 'POST', '/admin/roles', { name: 'X', permissions: { live: ['view'] } })).status,
    403,
  );
  const r = await call('sup', 'POST', '/admin/users', { username: 'newboss', password: 'longenough', role: 'admin' });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /only manage agent accounts/);
  // resetting a Super Admin's password: refused for staff
  assert.strictEqual((await call('sup', 'POST', '/admin/users/1/password', { password: 'longenough' })).status, 403);
});

test('staff logins are admin-side only: no calling, no agent routes', async () => {
  assert.strictEqual((await call('sup', 'POST', '/calls/click2call', { toNumber: '9840012345' })).status, 403);
  assert.strictEqual((await call('sup', 'GET', '/agent/extension-credentials')).status, 403);
});

test('team scope: queries are limited to the teams; reaching outside is refused', async () => {
  sql.length = 0;
  assert.strictEqual((await call('tl', 'GET', '/admin/calls')).status, 200);
  const calls = sql.find(([s]) => s.startsWith('SELECT ca.*'));
  assert.match(calls[0], /ca\.campaign_id IN \(\?\)/);
  assert.deepStrictEqual(calls[1][0], [7]);

  const create = await call('tl', 'POST', '/admin/campaigns', { name: 'Mine' });
  assert.strictEqual(create.status, 403);
  assert.match(create.body.error, /Campaigns - Create/);
  // a campaign outside the team answers like a missing one
  assert.strictEqual((await call('tl', 'GET', '/admin/campaigns/9/dispositions')).status, 404);
});

test('/auth/me tells the screens what a staff login may do', async () => {
  const me = await call('tl', 'GET', '/auth/me');
  assert.strictEqual(me.body.roleName, 'Team Leader');
  assert.strictEqual(me.body.scope, 'team');
  assert.deepStrictEqual(me.body.permissions.dialer, ['view']);
  assert.strictEqual(me.body.teamCount, 1);
  // the old 'manage' became every action except the ones own-teams roles can't have
  assert.deepStrictEqual(me.body.permissions.campaigns, ['view', 'edit']);
  const boss = await call('super', 'GET', '/auth/me');
  assert.strictEqual(boss.body.roleName, 'Super Admin');
  assert.strictEqual(boss.body.permissions, null);
});

test('live updates: staff get only what their role and teams cover', () => {
  const actions = (p) => (screen) => p[screen] || [];
  const all = { actions: actions({ live: ['view'] }), scope: null };
  const team = {
    actions: actions({ live: ['view'], dialer: ['view'] }),
    scope: { campaignIds: [7], agentIds: [21], teamIds: [3] },
  };
  assert.deepStrictEqual(staffView('agent.status', { userId: 99 }, all), { userId: 99 });
  assert.strictEqual(staffView('agent.status', { userId: 99 }, team), null);
  assert.deepStrictEqual(staffView('agent.status', { userId: 21 }, team), { userId: 21 });
  assert.deepStrictEqual(staffView('call.event', { callId: 5, payload: { to: '98400' } }, team), { callId: 5 });
  assert.strictEqual(staffView('dialer.status', { engine: {}, campaigns: [] }, all), null);
  assert.deepStrictEqual(
    staffView('dialer.status', { engine: { alive: true }, campaigns: [{ id: 7 }, { id: 8 }] }, team).campaigns,
    [{ id: 7 }],
  );
  assert.strictEqual(staffView('agent.status', { userId: 21 }, null), null);
});
