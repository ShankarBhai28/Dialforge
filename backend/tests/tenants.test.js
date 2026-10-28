// Cloud edition, part 1 (docs/plans/TENANTS_PLAN.md): the company code at
// login, each request on its company's database, per-company memory, the
// company list and the tools. A fake db module stands in for MySQL; its
// answers depend on the current tenant, as two real databases would.
const assert = require('node:assert');
const path = require('node:path');
const { test, before, after } = require('node:test');
const bcrypt = require('bcryptjs');

process.env.MULTI_TENANT = '1';
process.env.HOME_TENANT_CODE = 'main';

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const tenancy = require('../src/tenancy');

// Two companies with a user "boss" each, different passwords (one database each).
const TENANTS = {
  acme: { id: 1, code: 'acme', name: 'Acme', db_name: 'viztex_t_acme', status: 'active' },
  globex: { id: 2, code: 'globex', name: 'Globex', db_name: 'viztex_t_globex', status: 'active' },
  sleepy: { id: 3, code: 'sleepy', name: 'Sleepy', db_name: 'viztex_t_sleepy', status: 'suspended' },
};
const HASH = {
  viztex_t_acme: bcrypt.hashSync('acme-pass-1', 4),
  viztex_t_globex: bcrypt.hashSync('globex-pass-1', 4),
  viztex_t_sleepy: bcrypt.hashSync('sleepy-pass-1', 4),
};
const queriedIn = []; // [db, sql]
const platformQueries = [];
const platform = {
  async query(sql, params) {
    platformQueries.push([sql, params]);
    if (sql.includes('FROM tenants WHERE code')) return [TENANTS[params[0]] ? [TENANTS[params[0]]] : []];
    return [[]];
  },
};
const db = {
  async query(sql) {
    const name = tenancy.current() ? tenancy.current().dbName : 'home';
    queriedIn.push([name, sql]);
    if (sql.includes('FROM users LEFT JOIN extensions')) {
      return [
        HASH[name]
          ? [
              {
                id: 1,
                username: 'boss',
                role: 'admin',
                status: 'active',
                password_hash: HASH[name],
                extension_id: null,
              },
            ]
          : [],
      ];
    }
    return [[]];
  },
  getConnection: async () => ({ query: db.query, release() {} }),
  platformPool: () => platform,
  current: () => null,
};
fake('db.js', db);
fake('ari.js', { endpointState: async () => 'offline' });

const express = require('express');
const session = require('express-session');
const tenants = require('../src/services/tenants');
const { tenantMiddleware } = require('../src/middleware/tenant');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use(tenantMiddleware());
  app.use(require('../src/routes/auth'));
  // Which database a request reaches once logged in.
  app.get('/whoami-db', async (req, res) => {
    await db.query('SELECT 1 -- whoami');
    res.json({ tenant: tenancy.key(), db: queriedIn[queriedIn.length - 1][0] });
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

async function login(body) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, body: await res.json(), cookie };
}

test('the login page is told to ask for the company', async () => {
  const res = await fetch(`${base}/auth/config`);
  assert.deepStrictEqual(await res.json(), { multiTenant: true });
});

test('each company has its own users: the password of one never opens another', async () => {
  const ok = await login({ company: 'Acme ', username: 'boss', password: 'acme-pass-1' });
  assert.strictEqual(ok.status, 200);
  const wrong = await login({ company: 'globex', username: 'boss', password: 'acme-pass-1' });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.body.error, 'invalid company, username or password');
  // The user lookups went to each company's own database.
  const lookups = queriedIn.filter(([, sql]) => sql.includes('FROM users LEFT JOIN')).map(([d]) => d);
  assert.deepStrictEqual(lookups.slice(-2), ['viztex_t_acme', 'viztex_t_globex']);
});

test('an unknown company gets the same answer as a wrong password, and no database is asked', async () => {
  const before = queriedIn.length;
  const r = await login({ company: 'nobody', username: 'boss', password: 'x-x-x-x-x' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error, 'invalid company, username or password');
  assert.strictEqual(queriedIn.length, before);
});

test('the company code is required', async () => {
  const r = await login({ username: 'boss', password: 'acme-pass-1' });
  assert.strictEqual(r.status, 400);
});

test('a suspended company cannot log in, even with the right password', async () => {
  const r = await login({ company: 'sleepy', username: 'boss', password: 'sleepy-pass-1' });
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /suspended/);
});

test('after login every request runs on that company database', async () => {
  const { cookie } = await login({ company: 'globex', username: 'boss', password: 'globex-pass-1' });
  const res = await fetch(`${base}/whoami-db`, { headers: { cookie } });
  assert.deepStrictEqual(await res.json(), { tenant: 'globex', db: 'viztex_t_globex' });
  const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
  assert.strictEqual((await me.json()).username, 'boss');
});

test('a company suspended after login: its session ends at the next request', async () => {
  const { cookie } = await login({ company: 'acme', username: 'boss', password: 'acme-pass-1' });
  TENANTS.acme.status = 'suspended';
  tenants.forgetTenant('acme');
  try {
    const res = await fetch(`${base}/whoami-db`, { headers: { cookie } });
    assert.strictEqual(res.status, 401);
    assert.match((await res.json()).error, /suspended/);
  } finally {
    TENANTS.acme.status = 'active';
    tenants.forgetTenant('acme');
  }
});

test('not logged in: the request runs as the home company', async () => {
  const res = await fetch(`${base}/whoami-db`);
  assert.deepStrictEqual(await res.json(), { tenant: 'main', db: 'home' });
});

test('tenancy: key per company, home outside a request, nothing when not multi-tenant', () => {
  assert.strictEqual(tenancy.key(), 'main');
  tenancy.run({ code: 'acme', dbName: 'viztex_t_acme' }, () => assert.strictEqual(tenancy.key(), 'acme'));
  process.env.MULTI_TENANT = '0';
  try {
    tenancy.run({ code: 'acme', dbName: 'viztex_t_acme' }, () => {
      assert.strictEqual(tenancy.key(), '');
      assert.strictEqual(tenancy.current(), null);
    });
  } finally {
    process.env.MULTI_TENANT = '1';
  }
});

test('company codes: lower case, letters digits dashes, database name derived', () => {
  assert.strictEqual(tenants.normalizeCode('  Acme-2 '), 'acme-2');
  for (const bad of ['a', '-acme', 'acme-', 'ac me', 'acme_x', 'x'.repeat(31)]) {
    assert(!tenants.CODE_RE.test(bad), bad);
  }
  assert.strictEqual(tenants.dbNameFor('north-star'), 'viztex_t_north_star');
});

test('the company list is cached for a while, and forgetTenant reads it again', async () => {
  let now = 1000;
  let reads = 0;
  const deps = {
    now: () => now,
    pool: { query: async () => (reads++, [[TENANTS.globex]]) },
  };
  tenants.forgetTenant();
  await tenants.findTenant('globex', deps);
  await tenants.findTenant('globex', deps);
  assert.strictEqual(reads, 1);
  now += 31000;
  await tenants.findTenant('globex', deps);
  assert.strictEqual(reads, 2);
  assert.strictEqual(await tenants.findTenant('not a code!', deps), null);
  assert.strictEqual(reads, 2);
});

test('revoked sessions are per company: the same user id elsewhere stays logged in', () => {
  const { revokeUserSessions, isRevoked } = require('../src/services/sessions');
  const user = { id: 7, loginAt: Date.now() - 1000 };
  tenancy.run({ code: 'acme', dbName: 'viztex_t_acme' }, () => revokeUserSessions(7));
  tenancy.run({ code: 'acme', dbName: 'viztex_t_acme' }, () => assert.strictEqual(isRevoked(user), true));
  tenancy.run({ code: 'globex', dbName: 'viztex_t_globex' }, () => assert.strictEqual(isRevoked(user), false));
});

test('session store: the company is saved with each session, and logouts stay inside it', async () => {
  const { MySqlSessionStore } = require('../src/services/sessionStore');
  const seen = [];
  const store = new MySqlSessionStore({
    pool: { query: async (sql, params) => (seen.push([sql, params]), [[]]) },
    cleanupMs: 0,
    tenants: true,
  });
  await new Promise((r) => store.set('sid1', { tenant: 'acme', user: { id: 4 }, cookie: {} }, r));
  assert.match(seen[0][0], /tenant_code/);
  assert.strictEqual(seen[0][1][4], 'acme');
  await tenancy.run({ code: 'globex', dbName: 'viztex_t_globex' }, () => store.destroyUser(4));
  assert.deepStrictEqual(seen[1][1], [4, 'globex']);
});

test('db:migrate picks the platform database, one company or all of them', async () => {
  const { targetsFor, PLATFORM_DIR, DIR } = require('../src/tools/migrate');
  const env = { DB_NAME: 'viztex', PLATFORM_DB_NAME: 'viztex_platform' };
  const connect = async () => ({
    query: async (sql, params) =>
      sql.includes('WHERE code') ? [params[0] === 'acme' ? [TENANTS.acme] : []] : [[TENANTS.acme, TENANTS.globex]],
    end: async () => {},
  });
  assert.deepStrictEqual(await targetsFor([], connect, env), [{ label: '', database: 'viztex', dir: DIR }]);
  assert.deepStrictEqual(await targetsFor(['--platform'], connect, env), [
    { label: 'platform (viztex_platform)', database: 'viztex_platform', dir: PLATFORM_DIR },
  ]);
  assert.deepStrictEqual(
    (await targetsFor(['--tenant', 'ACME'], connect, env)).map((t) => t.database),
    ['viztex_t_acme'],
  );
  assert.deepStrictEqual(
    (await targetsFor(['--all-tenants'], connect, env)).map((t) => t.database),
    ['viztex_t_acme', 'viztex_t_globex'],
  );
  await assert.rejects(targetsFor(['--tenant', 'nobody'], connect, env), /no company "nobody"/);
});

test('tenant create: database, migrations, Super Admin, then the list; nothing left if a step fails', async () => {
  const { create } = require('../src/tools/tenant');
  function world({ failAdmin = false } = {}) {
    const steps = [];
    const conn = (name) => ({
      query: async (sql, params) => {
        steps.push([name, sql.split(' ').slice(0, 2).join(' '), params]);
        return [[]];
      },
      end: async () => {},
    });
    const platformDb = conn('platform');
    const deps = {
      connect: async (database) => conn(database || 'server'),
      migrate: async () => steps.push(['migrate']),
      createAdmin: async (c, username) => {
        if (failAdmin) throw new Error('admin failed');
        steps.push(['admin', username]);
      },
    };
    return { steps, platformDb, deps };
  }
  const ok = world();
  const log = [];
  await create(
    ok.platformDb,
    ['create', '--code', 'north-star', '--name', 'North Star', '--admin', 'boss'],
    (l) => log.push(l),
    ok.deps,
  );
  const kinds = ok.steps.map((s) => `${s[0]} ${s[1] || ''}`.trim());
  assert(kinds.includes('server CREATE DATABASE'));
  assert(kinds.indexOf('migrate') < kinds.indexOf('admin boss'));
  const insert = ok.steps.find((s) => s[0] === 'platform' && s[1] === 'INSERT INTO');
  assert.deepStrictEqual(insert[2], ['north-star', 'North Star', 'viztex_t_north_star']);
  assert(log.some((l) => l.includes('company code: north-star')));

  const bad = world({ failAdmin: true });
  await assert.rejects(
    create(bad.platformDb, ['create', '--code', 'oops', '--name', 'Oops', '--admin', 'boss'], () => {}, bad.deps),
    /admin failed/,
  );
  assert(bad.steps.some((s) => s[0] === 'server' && s[1] === 'DROP DATABASE'));
  assert(!bad.steps.some((s) => s[0] === 'platform' && s[1] === 'INSERT INTO'));
});
