// Cloud edition, part 2: timers and the dialer engine work for every
// company, each on its own database, and one company's trouble never stops
// the others. Dialer calls carry their company in the channel id.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

process.env.MULTI_TENANT = '1';
process.env.HOME_TENANT_CODE = 'main';
process.env.DB_NAME = 'viztex';

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const tenancy = require('../src/tenancy');

// Each company's database: who is logged in with which line.
const OPEN = {
  viztex: [],
  viztex_t_acme: [{ user_id: 7, status: 'available', extension_name: 'a7', started_at: '2026-10-28 09:00:00' }],
  viztex_t_globex: [{ user_id: 7, status: 'available', extension_name: 'g7', started_at: '2026-10-28 09:00:00' }],
};
const dbNow = () => (tenancy.current() ? tenancy.current().dbName : 'viztex');
fake('db.js', {
  query: async (sql) => (sql.includes('FROM agent_status_log asl JOIN users') ? [OPEN[dbNow()]] : [[]]),
  getConnection: async () => ({ query: async () => [[]], release() {} }),
  platformPool: () => ({ query: async () => [[]] }),
});
fake('ari.js', { endpointState: async () => 'offline' });

const tenants = require('../src/services/tenants');
const { dialerChannelId, parseDialerChannelId } = require('../dialer-common');

const ROWS = [
  { code: 'main', name: 'Main', db_name: 'viztex', status: 'active' },
  { code: 'acme', name: 'Acme', db_name: 'viztex_t_acme', status: 'active' },
  { code: 'globex', name: 'Globex', db_name: 'viztex_t_globex', status: 'active' },
];
const listDeps = (rows) => ({ pool: { query: async () => [rows] }, now: () => Date.now() });

test('every active company runs, as itself; one failing does not stop the rest', async () => {
  tenants.forgetActiveTenants();
  const seen = [];
  await tenants.forEachTenant(
    async () => {
      seen.push(tenancy.key());
      if (tenancy.key() === 'acme') throw new Error('acme is broken');
    },
    { deps: listDeps(ROWS) },
  );
  assert.deepStrictEqual(seen.sort(), ['acme', 'globex', 'main']);
});

test('the home database runs even before it is registered as a company', async () => {
  tenants.forgetActiveTenants();
  const seen = [];
  await tenants.forEachTenant(async () => seen.push(tenancy.current() ? tenancy.current().dbName : 'home'), {
    deps: listDeps(ROWS.slice(1)),
  });
  assert.deepStrictEqual(seen.sort(), ['home', 'viztex_t_acme', 'viztex_t_globex']);
});

test('single-customer install: the job runs once, with no company', async () => {
  process.env.MULTI_TENANT = '0';
  try {
    const seen = [];
    await tenants.forEachTenant(async () => seen.push(tenancy.current()));
    assert.deepStrictEqual(seen, [null]);
  } finally {
    process.env.MULTI_TENANT = '1';
  }
});

test('dialer channel ids carry the company; old ids still read', () => {
  assert.strictEqual(dialerChannelId(15), 'dfd-15');
  assert.strictEqual(dialerChannelId(15, 'acme-2'), 'dfd-acme-2-15');
  assert.deepStrictEqual(parseDialerChannelId('dfd-15'), { company: '', attemptId: 15 });
  assert.deepStrictEqual(parseDialerChannelId('dfd-acme-2-15'), { company: 'acme-2', attemptId: 15 });
  assert.strictEqual(parseDialerChannelId('PJSIP/1001-0000'), null);
});

test('stale agents: user 7 of one company is not user 7 of another', async () => {
  const { sweepStaleAgents } = require('../src/services/agentLogout');
  const as = (code, fn) => tenancy.run({ code, dbName: `viztex_t_${code}` }, fn);
  const t0 = Date.now();
  // Acme's agent 7 is first seen offline at t0; Globex's agent 7 only 9 minutes later.
  await as('acme', () => sweepStaleAgents({ minutes: 10, now: t0 }));
  await as('globex', () => sweepStaleAgents({ minutes: 10, now: t0 + 9 * 60000 }));
  // At t0 + 10 min only Acme's agent has been offline for 10 minutes.
  const acme = await as('acme', () => sweepStaleAgents({ minutes: 10, now: t0 + 10 * 60000 }));
  const globex = await as('globex', () => sweepStaleAgents({ minutes: 10, now: t0 + 10 * 60000 }));
  assert.deepStrictEqual(acme, [7]);
  assert.deepStrictEqual(globex, []);
});
