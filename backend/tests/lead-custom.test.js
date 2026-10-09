// Admin edit of a lead's custom form fields (services/leadImport.js).
const assert = require('node:assert');
const { test } = require('node:test');
const { applyCustomEdits } = require('../src/services/leadImport');

const FIELDS = [
  { field_key: 'amount', label: 'Amount', field_type: 'number', options: null },
  { field_key: 'plan', label: 'Plan', field_type: 'dropdown', options: ['Gold', 'Silver'] },
  { field_key: 'tags', label: 'Tags', field_type: 'checkbox', options: ['vip', 'new'] },
];

test('values are checked and converted like import; empty removes the field', () => {
  assert.deepStrictEqual(
    applyCustomEdits(FIELDS, { amount: 1, plan: 'Gold' }, { amount: ' 5000 ', plan: '', tags: ['vip', 'new'] }),
    { value: { amount: 5000, tags: ['vip', 'new'] } },
  );
  assert.deepStrictEqual(applyCustomEdits(FIELDS, { plan: 'Gold' }, { plan: '' }), { value: null });
  assert.deepStrictEqual(applyCustomEdits(FIELDS, null, { tags: [] }), { value: null });
});

test('bad values and unknown fields are refused with the field name', () => {
  assert.match(applyCustomEdits(FIELDS, null, { amount: 'lots' }).error, /Amount must be a number/);
  assert.match(applyCustomEdits(FIELDS, null, { plan: 'Bronze' }).error, /Plan must be one of: Gold, Silver/);
  assert.match(applyCustomEdits(FIELDS, null, { city: 'Chennai' }).error, /city is not a field/);
  assert.match(applyCustomEdits(FIELDS, null, ['x']).error, /object/);
});

test("saved values for fields not on the form are kept, so moving campaign doesn't drop them", () => {
  assert.deepStrictEqual(applyCustomEdits(FIELDS, { city: 'Chennai' }, { plan: 'Silver' }), {
    value: { city: 'Chennai', plan: 'Silver' },
  });
  assert.deepStrictEqual(applyCustomEdits([], { city: 'Chennai' }, {}), { value: { city: 'Chennai' } });
});
