// Restoring a deleted list: its leads (deleted with it) come back, numbers
// active again stay deleted, the list comes back inactive.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { restoreList, deletedLists } = require('../src/services/restore');

const LIST = {
  id: 3,
  name: 'Live Dial Test',
  campaign_id: 1,
  deleted_at: new Date('2026-10-13T18:47:19Z'),
  campaign_deleted_at: null,
};
const CANDS = [
  { id: 12, phone: '9003220102', clash: 0 },
  { id: 13, phone: '8870084698', clash: 0 },
  { id: 17, phone: '8608688838', clash: 1 }, // active again as lead #21
];

function world({ list = LIST, cands = CANDS } = {}) {
  const done = [];
  const conn = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FOR UPDATE')) return [[list].filter(Boolean)];
      if (s.includes('EXISTS (SELECT 1 FROM leads a')) return [cands];
      done.push([s, params]);
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => done.push(['begin']),
    commit: async () => done.push(['commit']),
    rollback: async () => done.push(['rollback']),
    release: () => {},
  };
  return { deps: { pool: { getConnection: async () => conn, query: conn.query } }, done };
}
const all = () => true;

test('restore: the leads deleted with the list come back, a number active again stays deleted, list inactive', async () => {
  const { deps, done } = world();
  const r = await restoreList(3, { inScope: all }, deps);
  assert.deepStrictEqual(r, { id: 3, name: 'Live Dial Test', restored: 2, skipped: 1 });
  const leads = done.find(([s]) => s.startsWith('UPDATE leads'));
  assert.deepStrictEqual(leads[1], [[12, 13]]);
  const list = done.find(([s]) => s.startsWith('UPDATE lists'));
  assert.match(list[0], /deleted_at = NULL, deleted_by = NULL, is_active = 0/);
  assert.deepStrictEqual(done.at(-1), ['commit']);
});

test('refused: not deleted, campaign deleted too, other team - nothing changed', async () => {
  for (const [list, inScope, status] of [
    [{ ...LIST, deleted_at: null }, all, 409],
    [{ ...LIST, campaign_deleted_at: new Date() }, all, 409],
    [LIST, () => false, 404],
    [null, all, 404],
  ]) {
    const { deps, done } = world({ list });
    await assert.rejects(restoreList(3, { inScope }, deps), { status });
    assert.ok(!done.some(([s]) => typeof s === 'string' && s.startsWith('UPDATE')));
    assert.deepStrictEqual(done.at(-1), ['rollback']);
  }
});

test('the deleted lists view: counts what a restore would do; other teams hidden', async () => {
  const deps = {
    pool: {
      async query(sql) {
        if (sql.includes('FROM lists ls')) {
          return [
            [
              {
                id: 3,
                name: 'Live Dial Test',
                campaign_id: 1,
                campaign: 'Sales',
                campaign_deleted_at: null,
                deleted_at: LIST.deleted_at,
                deleted_by: 'admin',
              },
              {
                id: 4,
                name: 'Other team',
                campaign_id: 9,
                campaign: 'X',
                campaign_deleted_at: null,
                deleted_at: LIST.deleted_at,
                deleted_by: 'admin',
              },
            ],
          ];
        }
        return [CANDS];
      },
    },
  };
  const rows = await deletedLists((id) => id === 1, deps);
  assert.deepStrictEqual(
    rows.map((r) => [r.id, r.leads, r.clashes, r.deletedBy, r.campaignDeleted]),
    [[3, 3, 1, 'admin', false]],
  );
});
