// Team form rules and which extensions an agent may connect with.
const assert = require('node:assert');
const { test } = require('node:test');
const { parseIds, parseTeam, checkTeamRefs } = require('../src/services/teams');
const { allowedExtensions, combineAllowed } = require('../src/services/extensionGuard');

test('team ids: positive whole numbers, de-duplicated; anything else is refused', () => {
  assert.deepStrictEqual(parseIds(undefined), []);
  assert.deepStrictEqual(parseIds(['3', 1, 3]), [1, 3]);
  assert.strictEqual(parseIds('1,2'), null);
  assert.strictEqual(parseIds([1, 'x']), null);
  assert.strictEqual(parseIds([0]), null);
});

test('team form: name, status and id lists', () => {
  assert.match(parseTeam({ name: '  ' }).error, /name/);
  assert.match(parseTeam({ name: 'A', status: 'gone' }).error, /status/);
  assert.match(parseTeam({ name: 'A', memberIds: [1, -2] }).error, /agents/);
  assert.match(parseTeam({ name: 'A', extensionIds: 'all' }).error, /extensions/);
  assert.deepStrictEqual(parseTeam({ name: ' Sales ', memberIds: [2], campaignIds: [5, 5] }), {
    team: { name: 'Sales', status: 'active', memberIds: [2], campaignIds: [5], extensionIds: [] },
  });
});

// A fake pool that knows agents 1-2, campaign 5 and extension 9.
const known = { users: [1, 2], campaigns: [5], extensions: [9] };
const fakePool = {
  async query(sql, [ids]) {
    const table = /FROM (\w+)/.exec(sql)[1];
    return [known[table].filter((id) => ids.includes(id)).map((id) => ({ id }))];
  },
};

test('team refs: every id must exist, naming the ones that do not', async () => {
  const ok = { memberIds: [1, 2], campaignIds: [5], extensionIds: [9] };
  assert.strictEqual(await checkTeamRefs(ok, { pool: fakePool }), null);
  assert.match(await checkTeamRefs({ ...ok, memberIds: [1, 3] }, { pool: fakePool }), /unknown agent id\(s\): 3/);
  assert.match(
    await checkTeamRefs({ ...ok, extensionIds: [8, 9] }, { pool: fakePool }),
    /unknown extension id\(s\): 8/,
  );
  // nothing to check -> no query at all
  assert.strictEqual(await checkTeamRefs({ memberIds: [], campaignIds: [], extensionIds: [] }, { pool: null }), null);
});

test('allowed extensions: none on any team = any; otherwise the team ones plus your own', () => {
  assert.strictEqual(combineAllowed([], '1001'), null);
  assert.deepStrictEqual(combineAllowed(['1010', '1002'], '1001'), ['1001', '1002', '1010']);
  assert.deepStrictEqual(combineAllowed(['1002'], '1002'), ['1002']);
  assert.deepStrictEqual(combineAllowed(['1002'], undefined), ['1002']);
});

test('allowed extensions: read from the agent teams; admins are never limited', async () => {
  const pool = {
    async query(sql) {
      if (/team_extensions/.test(sql)) return [[{ name: '1005' }]];
      return [[{ name: '1001' }]];
    },
  };
  assert.deepStrictEqual(await allowedExtensions({ id: 7, role: 'agent' }, { pool }), ['1001', '1005']);
  assert.strictEqual(await allowedExtensions({ id: 1, role: 'admin' }, { pool: null }), null);
});
