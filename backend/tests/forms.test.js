// Custom form rules (D2): the admin's form definition, and the agent's answers.
const assert = require('node:assert');
const { test } = require('node:test');
const { validateFormFields, validateFormData } = require('../src/services/forms');

test('form definition: rejects bad field lists', () => {
  assert.deepStrictEqual(validateFormFields([]), { error: 'a form needs at least one field' });
  assert.match(
    validateFormFields([{ fieldKey: 'Loan Amt', label: 'x', fieldType: 'text' }]).error,
    /must be lowercase/,
  );
  assert.deepStrictEqual(
    validateFormFields([
      { fieldKey: 'a', label: 'A', fieldType: 'text' },
      { fieldKey: 'a', label: 'B', fieldType: 'text' },
    ]),
    { error: 'field key "a" is used twice' },
  );
  assert.deepStrictEqual(validateFormFields([{ fieldKey: 'a', label: 'A', fieldType: 'dropdown', options: [' '] }]), {
    error: 'field "a" (dropdown) needs at least one option',
  });
});

test('form definition: cleans a valid field list', () => {
  assert.deepStrictEqual(
    validateFormFields([
      { fieldKey: 'amt', label: 'Amt', fieldType: 'number', isRequired: true },
      { fieldKey: 'p', label: 'P', fieldType: 'radio', options: ['Yes', 'No'] },
    ]),
    {
      fields: [
        { key: 'amt', label: 'Amt', type: 'number', options: null, required: 1, order: 0 },
        { key: 'p', label: 'P', type: 'radio', options: ['Yes', 'No'], required: 0, order: 1 },
      ],
    },
  );
});

const FIELDS = [
  { field_key: 'amt', label: 'Amount', field_type: 'number', is_required: 1 },
  { field_key: 'plan', label: 'Plan', field_type: 'dropdown', options: ['Gold', 'Silver'] },
  { field_key: 'tags', label: 'Tags', field_type: 'checkbox', options: ['A', 'B'] },
  { field_key: 'mail', label: 'Mail', field_type: 'email' },
];

test("agent's answers: each rule gives a clear error", () => {
  assert.deepStrictEqual(validateFormData(FIELDS, {}), { error: '"Amount" is required' });
  assert.deepStrictEqual(validateFormData(FIELDS, { amt: 'abc' }), { error: '"Amount" must be a number' });
  assert.deepStrictEqual(validateFormData(FIELDS, { amt: 5, plan: 'Diamond' }), {
    error: '"Plan" has an invalid choice',
  });
  assert.deepStrictEqual(validateFormData(FIELDS, { amt: 5, tags: ['Z'] }), { error: '"Tags" has an invalid choice' });
  assert.deepStrictEqual(validateFormData(FIELDS, { amt: 5, mail: 'nope' }), { error: '"Mail" must be an email' });
});

test("agent's answers: valid data is typed, unknown keys dropped", () => {
  assert.deepStrictEqual(
    validateFormData(FIELDS, { amt: '12.5', plan: 'Gold', tags: ['A'], mail: 'a@b.co', evil: 'x' }),
    { data: { amt: 12.5, plan: 'Gold', tags: ['A'], mail: 'a@b.co' } },
  );
});
