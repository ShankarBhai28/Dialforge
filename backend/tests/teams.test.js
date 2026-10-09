// Team form rules.
const assert = require('node:assert');
const { test } = require('node:test');
const { parseIds, parseTeam, checkTeamRefs } = require('../src/services/teams');

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
  assert.match(parseTeam({ name: 'A', campaignIds: 'all' }).error, /campaigns/);
  assert.deepStrictEqual(parseTeam({ name: ' Sales ', memberIds: [2], campaignIds: [5, 5] }), {
    team: { name: 'Sales', status: 'active', memberIds: [2], campaignIds: [5] },
  });
});

// A fake pool that knows agents 1-2 and campaign 5.
const known = { users: [1, 2], campaigns: [5] };
const fakePool = {
  async query(sql, [ids]) {
    const table = /FROM (\w+)/.exec(sql)[1];
    return [known[table].filter((id) => ids.includes(id)).map((id) => ({ id }))];
  },
};

test('team refs: every id must exist, naming the ones that do not', async () => {
  const ok = { memberIds: [1, 2], campaignIds: [5] };
  assert.strictEqual(await checkTeamRefs(ok, { pool: fakePool }), null);
  assert.match(await checkTeamRefs({ ...ok, memberIds: [1, 3] }, { pool: fakePool }), /unknown member id\(s\): 3/);
  assert.match(await checkTeamRefs({ ...ok, campaignIds: [6] }, { pool: fakePool }), /unknown campaign id\(s\): 6/);
  // nothing to check -> no query at all
  assert.strictEqual(await checkTeamRefs({ memberIds: [], campaignIds: [] }, { pool: null }), null);
});
