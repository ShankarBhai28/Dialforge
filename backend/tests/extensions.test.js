// Extension (SIP line) rules: the provider's ext:add tool, passwords, edits.
const assert = require('node:assert');
const { test } = require('node:test');
const { generateSipPassword, parseExtensionUpdate } = require('../src/services/extensions');
const { planNumbers, addExtensions } = require('../src/tools/add-extensions');

test('ext:add: a run of 3-8 digit numbers, leading zeros kept; bad input refused', () => {
  assert.deepStrictEqual(planNumbers('1001', '3'), ['1001', '1002', '1003']);
  assert.deepStrictEqual(planNumbers('0098', '3'), ['0098', '0099', '0100']);
  assert.deepStrictEqual(planNumbers('2001'), ['2001']);
  assert.throws(() => planNumbers('10', '1'), /3-8 digits/);
  assert.throws(() => planNumbers(undefined, '1'), /--from/);
  assert.throws(() => planNumbers('1001', '0'), /--count/);
  assert.throws(() => planNumbers('1001', '501'), /--count/);
  assert.throws(() => planNumbers('99999999', '2'), /100000000 is not a valid/);
});

test('ext:add: existing numbers skipped, new ones get a strong generated password', async () => {
  const inserted = [];
  const pool = {
    query: async (sql, p) => {
      if (sql.startsWith('SELECT')) return [p[0] === '1002' ? [{ id: 2 }] : []];
      inserted.push(p);
      return [{ insertId: 9 }];
    },
  };
  const r = await addExtensions(pool, ['1001', '1002', '1003'], '  Night shift ');
  assert.deepStrictEqual(r, { added: ['1001', '1003'], skipped: ['1002'] });
  assert.deepStrictEqual(
    inserted.map((p) => [p[0], p[1]]),
    [
      ['1001', 'Night shift'],
      ['1003', 'Night shift'],
    ],
  );
  for (const p of inserted) assert.match(p[2], /^[A-Za-z0-9]{24}$/);
  assert.notStrictEqual(generateSipPassword(), generateSipPassword());
});

test('edit: label and enabled; left-out fields keep their value', () => {
  const cur = { label: 'Desk 1', enabled: 1 };
  assert.deepStrictEqual(parseExtensionUpdate({ enabled: false }, cur).changes, { label: 'Desk 1', enabled: 0 });
  assert.deepStrictEqual(parseExtensionUpdate({ label: '' }, cur).changes, { label: null, enabled: 1 });
  assert.match(parseExtensionUpdate({ enabled: 'no' }, cur).error, /true or false/);
});
