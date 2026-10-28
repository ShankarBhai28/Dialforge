// Cloud edition, part 3: in Asterisk every company's extensions and queues
// carry the company in front (acme_1001, acme_sales); our tables keep the
// plain names. Asterisk reads one realtime database that joins all companies.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

process.env.MULTI_TENANT = '1';
process.env.HOME_TENANT_CODE = 'main';

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const amiCalls = [];
fake('db.js', {
  query: async (sql) => (sql.includes('SELECT asterisk_name FROM queues') ? [[{ asterisk_name: 'sales' }]] : [[]]),
  getConnection: async () => ({ query: async () => [[]], release() {} }),
  platformPool: () => ({ query: async () => [[]] }),
});
fake('ami.js', {
  queueAdd: async (q, i) => amiCalls.push(['add', q, i]),
  queuePause: async (q, i, p) => amiCalls.push(['pause', q, i, p]),
  queueRemove: async (q, i) => amiCalls.push(['remove', q, i]),
  on: () => {},
});
fake('ari.js', { endpointState: async () => 'offline' });

const tenancy = require('../src/tenancy');
const names = require('../src/telephony/names');
const as = (code, fn) => tenancy.run({ code, dbName: `viztex_t_${code}` }, fn);

test('names in Asterisk: the company in front, only for extensions and queues', () => {
  as('acme', () => {
    assert.strictEqual(names.endpoint('1001'), 'acme_1001');
    assert.strictEqual(names.pjsip('1001'), 'PJSIP/acme_1001');
    assert.strictEqual(names.queue('sales'), 'acme_sales');
    assert.deepStrictEqual(names.fromAsterisk('acme_1001'), { company: 'acme', name: '1001' });
    assert.strictEqual(names.ownName('acme_1001'), '1001');
    assert.strictEqual(names.ownName('globex_1001'), null);
    assert.deepStrictEqual(
      names.ownEndpointStates({
        acme_1001: 'online',
        globex_1001: 'online',
        acme_1002: 'offline',
        loadtrunk: 'online',
      }),
      { 1001: 'online', 1002: 'offline' },
    );
  });
  // Outside a request: the home company.
  assert.strictEqual(names.pjsip('1001'), 'PJSIP/main_1001');
});

test('single install: names stay exactly as they are', () => {
  process.env.MULTI_TENANT = '0';
  try {
    assert.strictEqual(names.pjsip('1001'), 'PJSIP/1001');
    assert.strictEqual(names.queue('sales'), 'sales');
    assert.strictEqual(names.ownName('1001'), '1001');
    const states = { 1001: 'online' };
    assert.strictEqual(names.ownEndpointStates(states), states);
  } finally {
    process.env.MULTI_TENANT = '1';
  }
});

test('queue membership uses the company names in Asterisk', async () => {
  const { syncQueueMembership } = require('../src/services/agents');
  amiCalls.length = 0;
  await as('acme', () => syncQueueMembership(5, '1001', 'available', 3));
  assert.deepStrictEqual(amiCalls, [
    ['add', 'acme_sales', 'PJSIP/acme_1001'],
    ['pause', 'acme_sales', 'PJSIP/acme_1001', false],
  ]);
});

test('recordings go to a folder per company', () => {
  const { recordingBase } = require('../src/services/recording');
  const at = new Date('2026-10-28T10:15:00Z');
  const p = as('acme', () => recordingBase(42, at));
  assert.match(p, /\/acme\/2026\/10\/28\/call-42-20261028-101500$/);
});

test('Asterisk realtime: one view per kind joins every company, names prefixed, lines in tenant-internal', () => {
  const { realtimeSql } = require('../src/tools/tenant');
  const sql = realtimeSql(
    [
      { code: 'main', db_name: 'viztex' },
      { code: 'acme', db_name: 'viztex_t_acme' },
      { code: 'bad name', db_name: 'x' },
      { code: 'evil', db_name: 'x`; DROP DATABASE y; --' },
    ],
    'viztex_rt',
  );
  assert.match(sql[0], /CREATE DATABASE IF NOT EXISTS `viztex_rt`/);
  const endpoints = sql.find((s) => s.includes('`ps_endpoints` AS'));
  assert.match(endpoints, /CONCAT\('main_', id\)[\s\S]*FROM `viztex`\.ps_endpoints/);
  assert.match(endpoints, /CONCAT\('acme_', id\)[\s\S]*FROM `viztex_t_acme`\.ps_endpoints/);
  assert.strictEqual(endpoints.split('UNION ALL').length, 2);
  assert.match(endpoints, /'tenant-internal' AS context/);
  assert(!sql.join('\n').includes('DROP'));
  assert.match(
    sql.find((s) => s.includes('`ast_queues` AS')),
    /CONCAT\('acme_', name\) AS name/,
  );
  assert.deepStrictEqual(realtimeSql([], 'viztex_rt'), []);
  assert.throws(() => realtimeSql([{ code: 'acme', db_name: 'viztex_t_acme' }], 'rt; drop'), /RT_DB_NAME/);
});
