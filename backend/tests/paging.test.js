// Shared paging helpers used by every admin list.
const assert = require('node:assert');
const { test } = require('node:test');
const { parsePaging, pageResult, whereClause, likeTerm } = require('../src/services/paging');

test('paging: defaults, caps and bad input', () => {
  assert.deepStrictEqual(parsePaging({}), { page: 1, pageSize: 50, offset: 0 });
  assert.deepStrictEqual(parsePaging({ page: '3', pageSize: '20' }), { page: 3, pageSize: 20, offset: 40 });
  assert.deepStrictEqual(parsePaging({ page: '-2', pageSize: '100000' }), { page: 1, pageSize: 200, offset: 0 });
  assert.deepStrictEqual(parsePaging({ page: 'abc', pageSize: '0' }), { page: 1, pageSize: 50, offset: 0 });
  assert.deepStrictEqual(pageResult([1], '7', { page: 2, pageSize: 5 }), { rows: [1], total: 7, page: 2, pageSize: 5 });
});

test('where clause: only the filters that are set, params in order', () => {
  assert.deepStrictEqual(
    whereClause([
      ['', [1]],
      ['a = ?', ['x']],
      ['b IN (?, ?)', [1, 2]],
    ]),
    {
      sql: 'WHERE a = ? AND b IN (?, ?)',
      params: ['x', 1, 2],
    },
  );
  assert.deepStrictEqual(whereClause([['', ['ignored']]]), { sql: '', params: [] });
});

test('LIKE search treats % and _ literally', () => {
  assert.strictEqual(likeTerm('50%_off'), String.raw`%50\%\_off%`);
});
