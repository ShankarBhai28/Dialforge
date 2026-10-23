// Team form rules.
const assert = require('node:assert');
const { test } = require('node:test');
const { MAX_DEPTH, parseIds, parseTeam, checkTeamRefs, subtree, parentProblem } = require('../src/services/teams');
const { scopedTeamIds } = require('../src/services/access');

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
    team: { name: 'Sales', status: 'active', parentId: null, memberIds: [2], campaignIds: [5] },
  });
  assert.strictEqual(parseTeam({ name: 'TL 1', parentId: '4' }).team.parentId, 4);
  assert.strictEqual(parseTeam({ name: 'TL 1', parentId: '' }).team.parentId, null, 'empty = top level');
  assert.match(parseTeam({ name: 'TL 1', parentId: 'x' }).error, /parent team/);
  assert.match(parseTeam({ name: 'TL 1', parentId: -1 }).error, /parent team/);
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

// tecdata's shape: Head (1) > Manager A (2) > TL 1 (4), TL 2 (5); Head > Manager B (3) > TL 3 (6).
const TREE = [
  { id: 1, parent_id: null, status: 'active' },
  { id: 2, parent_id: 1, status: 'active' },
  { id: 3, parent_id: 1, status: 'active' },
  { id: 4, parent_id: 2, status: 'active' },
  { id: 5, parent_id: 2, status: 'active' },
  { id: 6, parent_id: 3, status: 'active' },
  { id: 9, parent_id: null, status: 'active' }, // another top-level team
];
const sorted = (set) => [...set].sort((a, b) => a - b);

test('hierarchy: a team and everything below it', () => {
  assert.deepStrictEqual(sorted(subtree(TREE, [1])), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(sorted(subtree(TREE, [2])), [2, 4, 5]);
  assert.deepStrictEqual(sorted(subtree(TREE, [4])), [4]);
  assert.deepStrictEqual(sorted(subtree(TREE, [2, 6])), [2, 4, 5, 6]);
  // A loop in bad data doesn't hang it.
  assert.deepStrictEqual(
    sorted(
      subtree(
        [
          { id: 1, parent_id: 2 },
          { id: 2, parent_id: 1 },
        ],
        [1],
      ),
    ),
    [1, 2],
  );
});

test('hierarchy: who sees what - down the tree, never up or sideways', () => {
  assert.deepStrictEqual(scopedTeamIds(TREE, [4]), [4], 'TL: own team only');
  assert.deepStrictEqual(scopedTeamIds(TREE, [2]), [2, 4, 5], 'manager A: own TLs, not manager B');
  assert.deepStrictEqual(scopedTeamIds(TREE, [1]), [1, 2, 3, 4, 5, 6], 'head: all below');
  assert.deepStrictEqual(scopedTeamIds(TREE, []), []);
  // An inactive team gives nothing itself; the active teams under it still count for those above.
  const off = TREE.map((t) => (t.id === 2 ? { ...t, status: 'inactive' } : t));
  assert.deepStrictEqual(scopedTeamIds(off, [1]), [1, 3, 4, 5, 6]);
  assert.deepStrictEqual(scopedTeamIds(off, [2]), [], 'a member of only an inactive team sees nothing');
});

test('hierarchy: no loops, no unknown parent, at most MAX_DEPTH levels', () => {
  assert.strictEqual(parentProblem(TREE, null, null), null, 'top level is always fine');
  assert.strictEqual(parentProblem(TREE, null, 4), null, 'a new team under TL 1');
  assert.strictEqual(parentProblem(TREE, 6, 2), null, 'TL 3 moves to manager A');
  assert.match(parentProblem(TREE, 2, 2), /its own parent/);
  assert.match(parentProblem(TREE, 1, 4), /own sub-teams/, 'the head under one of its TLs = a loop');
  assert.match(parentProblem(TREE, null, 99), /unknown parent team id: 99/);
  // A chain 1 > 2 > ... > MAX_DEPTH: nothing more fits under the last one.
  const chain = Array.from({ length: MAX_DEPTH }, (_, i) => ({ id: i + 1, parent_id: i ? i : null }));
  assert.match(parentProblem(chain, null, MAX_DEPTH), /at most 6 levels/);
  assert.strictEqual(parentProblem(chain, null, MAX_DEPTH - 1), null);
  // Moving a team with sub-teams counts their levels too.
  const two = [...chain.slice(0, MAX_DEPTH - 1), { id: 50, parent_id: null }, { id: 51, parent_id: 50 }];
  assert.match(parentProblem(two, 50, MAX_DEPTH - 1), /levels/);
  assert.strictEqual(parentProblem(two, 50, MAX_DEPTH - 2), null);
});
