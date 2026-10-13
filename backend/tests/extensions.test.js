// Extension (SIP line) rules: number format, generated / given passwords, edits.
const assert = require('node:assert');
const { test } = require('node:test');
const { generateSipPassword, parseExtensionUpdate, parseNewExtension } = require('../src/services/extensions');

test('new extension: 3-8 digit number; a strong password is generated when none is given', () => {
  assert.match(parseNewExtension({ name: '10' }).error, /3-8 digits/);
  assert.match(parseNewExtension({ name: '10a1' }).error, /3-8 digits/);
  const { extension } = parseNewExtension({ name: ' 1004 ', label: ' Desk 4 ' });
  assert.strictEqual(extension.name, '1004');
  assert.strictEqual(extension.label, 'Desk 4');
  assert.match(extension.password, /^[A-Za-z0-9]{24}$/);
  assert.notStrictEqual(generateSipPassword(), generateSipPassword());
});

test('a given SIP password must be 12-64 letters and digits (nothing that breaks a SIP config)', () => {
  assert.match(parseNewExtension({ name: '1004', password: 'short1' }).error, /12-64/);
  assert.match(parseNewExtension({ name: '1004', password: 'has space in it 123' }).error, /12-64/);
  assert.strictEqual(parseNewExtension({ name: '1004', password: 'Abcdefgh1234' }).extension.password, 'Abcdefgh1234');
});

test('edit: label and enabled; left-out fields keep their value', () => {
  const cur = { label: 'Desk 1', enabled: 1 };
  assert.deepStrictEqual(parseExtensionUpdate({ enabled: false }, cur).changes, { label: 'Desk 1', enabled: 0 });
  assert.deepStrictEqual(parseExtensionUpdate({ label: '' }, cur).changes, { label: null, enabled: 1 });
  assert.match(parseExtensionUpdate({ enabled: 'no' }, cur).error, /true or false/);
});
