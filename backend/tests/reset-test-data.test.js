// The test-data reset: refuses on production / without --yes / with live
// activity; clears only activity tables, never setup.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const file = require.resolve(path.join(root, 'db.js'));
require.cache[file] = { id: file, filename: file, loaded: true, exports: { query: async () => [[]] } };

const { CLEAR, refusal, clearTables } = require('../src/tools/reset-test-data');

const quiet = (open = 0, agents = 0) => ({
  async query(sql) {
    if (sql.includes('FROM calls')) return [[{ n: open }]];
    if (sql.includes('FROM agent_status_log')) return [[{ n: agents }]];
    return [[]];
  },
});

test('refuses on production, without --yes, with an open call or a logged-in agent (unless --force)', async () => {
  assert.match(
    await refusal({ env: { APP_ENV: 'production' }, args: ['--yes', '--force'], db: quiet() }),
    /production/,
  );
  assert.match(await refusal({ env: {}, args: [], db: quiet() }), /--yes/);
  assert.match(await refusal({ env: {}, args: ['--yes'], db: quiet(1) }), /call\(s\) open/);
  assert.match(await refusal({ env: {}, args: ['--yes'], db: quiet(0, 2) }), /agent\(s\) logged in/);
  assert.strictEqual(await refusal({ env: {}, args: ['--yes', '--force'], db: quiet(1, 2) }), null);
  assert.strictEqual(await refusal({ env: { APP_ENV: 'dev' }, args: ['--yes'], db: quiet() }), null);
});

test('clears only activity tables - setup (users, extensions, campaigns, DNC ...) is never touched', async () => {
  for (const keep of [
    'users',
    'extensions',
    'queues',
    'campaigns',
    'campaign_dispositions',
    'forms',
    'form_fields',
    'dids',
    'dnc_numbers',
    'teams',
    'roles',
    'schema_migrations',
  ]) {
    assert.ok(!CLEAR.includes(keep), keep);
  }
  const ran = [];
  const conn = {
    async query(sql) {
      ran.push(sql);
      return [{ affectedRows: 3 }];
    },
    beginTransaction: async () => ran.push('BEGIN'),
    commit: async () => ran.push('COMMIT'),
    rollback: async () => ran.push('ROLLBACK'),
    release: () => {},
  };
  const counts = await clearTables({ getConnection: async () => conn });
  assert.deepStrictEqual(Object.keys(counts), CLEAR);
  const deletes = ran.filter((s) => s.startsWith('DELETE'));
  assert.strictEqual(deletes.length, CLEAR.length);
  assert.ok(ran.indexOf('COMMIT') > ran.lastIndexOf(deletes.at(-1)));
  assert.ok(ran.includes("UPDATE campaigns SET dialer_state = 'stopped' WHERE dialer_state <> 'stopped'"));
  assert.strictEqual(ran.at(-1), 'SET FOREIGN_KEY_CHECKS = 1');
});
