// Bulk user import: every row is checked before anything is created.
const assert = require('node:assert');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const { MAX_USER_ROWS, planUserImport, hashPasswords } = require('../src/services/userImport');

const HEADERS = ['username', 'password', 'extension', 'team'];
const row = (rowNum, username, password, extension, team = '') => ({
  rowNum,
  values: { username, password, extension, team },
});
// 1001 free, 1002 agent 21's (in the manager's team), 1003 agent 40's (another team), 1009 disabled.
const ctx = (scope = null) => ({
  scope,
  usernames: new Set(['agent01']),
  extensions: new Map([
    ['1001', { id: 1, enabled: true, userIds: [] }],
    ['1002', { id: 2, enabled: true, userIds: [21] }],
    ['1003', { id: 3, enabled: true, userIds: [40] }],
    ['1009', { id: 9, enabled: false, userIds: [] }],
  ]),
  teams: new Map([
    ['tl 1', 4],
    ['tl 3', 6],
  ]),
});
const MANAGER = { teamIds: [4], agentIds: [21], campaignIds: [] };

test('import: clean rows are ready, with the team and extension ids', () => {
  const plan = planUserImport(
    HEADERS,
    [row(2, 'agent02', 'longenough', '1001', 'TL 1'), row(3, 'agent03', 'longenough', '1001')],
    ctx(),
  );
  assert.deepStrictEqual(plan.problems, []);
  assert.deepStrictEqual(plan.ready, [
    { rowNum: 2, username: 'agent02', password: 'longenough', extensionId: 1, teamId: 4 },
    { rowNum: 3, username: 'agent03', password: 'longenough', extensionId: 1, teamId: null },
  ]);
});

test('import: every problem is named with its row', () => {
  const plan = planUserImport(
    HEADERS,
    [
      row(2, 'a', 'longenough', '1001'),
      row(3, 'Agent01', 'longenough', '1001'),
      row(4, 'agent04', 'longenough', '1001'),
      row(5, 'AGENT04', 'longenough', '1001'),
      row(6, 'agent06', 'short', '1001'),
      row(7, 'agent07', 'longenough', ''),
      row(8, 'agent08', 'longenough', '2000'),
      row(9, 'agent09', 'longenough', '1009'),
      row(10, 'agent10', 'longenough', '1001', 'Nowhere'),
    ],
    ctx(),
  );
  assert.deepStrictEqual(
    plan.problems.map((p) => [p.rowNum, p.error]),
    [
      [2, 'username must be 3-50 letters, digits, dots, dashes or underscores'],
      [3, 'that username is already taken'],
      [5, 'the same username is on row 4'],
      [6, 'password must be at least 8 characters'],
      [7, 'extension is required'],
      [8, 'extension 2000 does not exist'],
      [9, 'extension 1009 is disabled'],
      [10, 'team "Nowhere" does not exist'],
    ],
  );
  assert.deepStrictEqual(
    plan.ready.map((r) => r.username),
    ['agent04'],
  );
});

test("import by a TL / manager: only into their teams, never another team's extension", () => {
  const plan = planUserImport(
    HEADERS,
    [
      row(2, 'agent02', 'longenough', '1002', 'TL 1'),
      row(3, 'agent03', 'longenough', '1001', 'TL 3'),
      row(4, 'agent04', 'longenough', '1003', 'TL 1'),
      row(5, 'agent05', 'longenough', '1001'),
    ],
    ctx(MANAGER),
  );
  assert.deepStrictEqual(
    plan.problems.map((p) => [p.rowNum, p.error]),
    [
      [3, 'team "TL 3" is not one of yours'],
      [4, 'that extension belongs to an agent outside your teams - pick a free one'],
      [5, 'team is required'],
    ],
  );
  assert.deepStrictEqual(
    plan.ready.map((r) => r.username),
    ['agent02'],
  );
  assert.match(planUserImport(['username', 'password', 'extension'], [], ctx(MANAGER)).error, /"team" column/);
});

test('import: the columns and the size of the file', () => {
  assert.match(planUserImport(['name', 'password'], [], ctx()).error, /missing: username, extension/);
  const many = Array.from({ length: MAX_USER_ROWS + 1 }, (_, i) => row(i + 2, `agent${i}`, 'longenough', '1001'));
  assert.match(planUserImport(HEADERS, many, ctx()).error, /max 500 users per file/);
});

test('passwords are hashed off the main thread, in order', async () => {
  const hashes = await hashPasswords(['first-password', 'second-password']);
  assert.strictEqual(hashes.length, 2);
  assert.ok(await bcrypt.compare('first-password', hashes[0]));
  assert.ok(await bcrypt.compare('second-password', hashes[1]));
  assert.ok(!(await bcrypt.compare('first-password', hashes[1])));
});
