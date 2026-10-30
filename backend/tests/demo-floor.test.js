// The demo floor: refuses on production; adds only demo… rows and removes
// exactly those.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const file = require.resolve(path.join(root, 'db.js'));
require.cache[file] = { id: file, filename: file, loaded: true, exports: { query: async () => [[]] } };

const { AGENTS, refusal, add } = require('../src/tools/demo-floor');

test('refuses on production, and without add / remove', () => {
  assert.match(refusal({ env: { APP_ENV: 'production' }, args: ['add'] }), /production/);
  assert.match(refusal({ env: {}, args: [] }), /add or remove/);
  assert.strictEqual(refusal({ env: { APP_ENV: 'dev' }, args: ['remove'] }), null);
});

test('add: clears the old demo first, then inserts demo rows only - one call of each type', async () => {
  const seen = [];
  let id = 0;
  const db = {
    async query(sql, params) {
      seen.push([sql, params]);
      if (sql.startsWith('INSERT')) return [{ insertId: ++id }];
      if (sql.includes("role = 'admin'")) return [[{ id: 1 }]];
      return [[]];
    },
  };
  await add(db, Date.parse('2026-10-30T10:00:00Z'));
  // remove first: the old demo agents are looked up by their demo_agent name
  assert.ok(seen[0][0].includes('FROM users WHERE username LIKE') && seen[0][0].includes('demo'), seen[0][0]);
  const inserts = seen.filter(([sql]) => sql.startsWith('INSERT'));
  const rows = (table) => inserts.filter(([sql]) => sql.includes(`INTO ${table} `)).map(([, p]) => p);
  assert.ok(rows('users').every((u) => u.username.startsWith('demo_agent') && u.role === 'agent'));
  assert.strictEqual(rows('users').length, AGENTS.length);
  assert.ok(rows('campaigns').every((c) => c.name.startsWith('demo_')));
  assert.ok(rows('queues').every((q) => q.name.startsWith('demo_')));
  const calls = rows('calls');
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(calls.filter((c) => c.direction === 'inbound').length, 1);
  assert.strictEqual(calls.filter((c) => c.dial_attempt_id).length, 1); // predictive
  assert.strictEqual(rows('callbacks').length, 1);
  // deletes never reach beyond the demo rows
  for (const [sql] of seen.filter(([s]) => s.startsWith('DELETE')))
    assert.match(sql, /IN \(\?\)|LIKE 'demo/, `unscoped delete: ${sql}`);
});
