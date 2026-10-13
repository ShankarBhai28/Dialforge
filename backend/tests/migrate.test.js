// Migration runner: order, history, baseline, refusing unsafe runs - with a
// fake connection and a temporary folder of migration files.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { plan, run, checksum } = require('../src/tools/migrate');
const { randomPassword } = require('../src/tools/create-admin');

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

/** A fake MySQL connection: schema_migrations rows + a count of other tables. */
function fakeConn({ applied = [], tables = 0 } = {}) {
  const ran = [];
  const history = new Map(applied.map((a) => [a.name, a]));
  return {
    ran,
    history,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return [{}];
      if (s.startsWith('SELECT name, checksum, applied_at FROM schema_migrations')) return [[...history.values()]];
      if (s.startsWith('SELECT COUNT(*) AS n FROM information_schema.tables')) return [[{ n: tables }]];
      if (s.startsWith('INSERT INTO schema_migrations')) {
        history.set(params[0], { name: params[0], checksum: params[1], applied_at: new Date() });
        return [{}];
      }
      ran.push(sql);
      if (sql.includes('BOOM')) throw new Error('syntax error near BOOM');
      return [{}];
    },
  };
}

const FILES = {
  '0001_baseline.sql': 'CREATE TABLE a (id INT);',
  '0002_add_b.sql': 'CREATE TABLE b (id INT);',
  'notes.txt': 'ignored',
  'migration-old.sql': 'ignored too (not numbered)',
};
const quiet = () => {};

test('empty database: every file runs in number order and is recorded', async () => {
  const conn = fakeConn();
  assert.strictEqual(await run(conn, [], quiet, dirWith(FILES)), 0);
  assert.deepStrictEqual(conn.ran, ['CREATE TABLE a (id INT);', 'CREATE TABLE b (id INT);']);
  assert.deepStrictEqual([...conn.history.keys()], ['0001_baseline.sql', '0002_add_b.sql']);
  // second run: nothing to do
  assert.strictEqual(await run(conn, [], quiet, dirWith(FILES)), 0);
  assert.strictEqual(conn.ran.length, 2);
});

test('existing database without history: refused until --baseline, which records 0001 without running it', async () => {
  const conn = fakeConn({ tables: 20 });
  await assert.rejects(run(conn, [], quiet, dirWith(FILES)), /run once:\s+npm run db:migrate -- --baseline/);
  assert.strictEqual(conn.ran.length, 0);
  await run(conn, ['--baseline'], quiet, dirWith(FILES));
  assert.deepStrictEqual([...conn.history.keys()], ['0001_baseline.sql']);
  assert.strictEqual(conn.ran.length, 0);
  await run(conn, [], quiet, dirWith(FILES));
  assert.deepStrictEqual(conn.ran, ['CREATE TABLE b (id INT);']);
});

test('--baseline refuses an empty database and a second baseline', async () => {
  await assert.rejects(run(fakeConn(), ['--baseline'], quiet, dirWith(FILES)), /empty/);
  const done = fakeConn({ tables: 5, applied: [{ name: '0001_baseline.sql', checksum: 'x' }] });
  await assert.rejects(run(done, ['--baseline'], quiet, dirWith(FILES)), /already has a migration history/);
});

test('a failing file stops the run there and is not recorded', async () => {
  const conn = fakeConn();
  const dir = dirWith({ ...FILES, '0003_bad.sql': 'BOOM', '0004_after.sql': 'CREATE TABLE d (id INT);' });
  await assert.rejects(run(conn, [], quiet, dir), /0003_bad.sql failed: syntax error near BOOM/);
  assert.ok(!conn.history.has('0003_bad.sql'));
  assert.ok(!conn.ran.includes('CREATE TABLE d (id INT);'));
});

test('--status lists applied and pending, and warns about a file edited after it was applied', async () => {
  const lines = [];
  const conn = fakeConn({
    tables: 5,
    applied: [{ name: '0001_baseline.sql', checksum: 'old', applied_at: new Date() }],
  });
  const code = await run(conn, ['--status'], (l) => lines.push(l), dirWith(FILES));
  assert.strictEqual(code, 1); // something pending
  assert.ok(lines.some((l) => /WARNING 0001_baseline.sql was changed/.test(l)));
  assert.ok(lines.some((l) => /^PENDING\s+0002_add_b.sql/.test(l)));
  assert.strictEqual(conn.ran.length, 0);
});

test('plan + checksum: line endings do not count as a change', () => {
  assert.strictEqual(checksum('a;\r\nb;'), checksum('a;\nb;'));
  const migs = [{ name: '0001_baseline.sql', checksum: 'c1' }];
  assert.strictEqual(plan(migs, new Map(), { tablesExist: false }).error, null);
  assert.match(plan(migs, new Map(), { tablesExist: true }).error, /--baseline/);
});

test('create-admin: generated passwords are long and readable', () => {
  const p = randomPassword();
  assert.strictEqual(p.length, 16);
  assert.doesNotMatch(p, /[0O1lI]/);
  assert.notStrictEqual(p, randomPassword());
});
