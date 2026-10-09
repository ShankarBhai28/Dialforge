// Account rules (create / edit / deactivate) and ending a user's sessions.
const assert = require('node:assert');
const { test } = require('node:test');
const { parseNewUser, parseUserUpdate, checkPassword } = require('../src/services/users');
const { revokeUserSessions, isRevoked } = require('../src/services/sessions');

test('new user: checks username, password, role and extension', () => {
  assert.match(
    parseNewUser({ username: 'a', password: 'longenough', role: 'agent', extensionId: 1 }).error,
    /username/,
  );
  assert.match(
    parseNewUser({ username: 'ravi', password: 'short', role: 'agent', extensionId: 1 }).error,
    /8 characters/,
  );
  assert.match(parseNewUser({ username: 'ravi', password: 'longenough', role: 'boss' }).error, /role/);
  assert.match(parseNewUser({ username: 'ravi', password: 'longenough', role: 'agent' }).error, /extension/);
  assert.deepStrictEqual(
    parseNewUser({ username: ' ravi.k ', password: 'longenough', role: 'admin', extensionId: 3 }),
    {
      user: { username: 'ravi.k', password: 'longenough', role: 'admin', extensionId: null },
    },
  );
  assert.strictEqual(checkPassword('12345678'), null);
});

const agent = { id: 7, role: 'agent', status: 'active', extension_id: 3 };
const admin = { id: 1, role: 'admin', status: 'active', extension_id: null };

test('edit: changes role / extension / status, and says when sessions must end', () => {
  assert.deepStrictEqual(parseUserUpdate({ extensionId: 2 }, agent, { meId: 1, activeAdmins: 1 }), {
    changes: { role: 'agent', status: 'active', extension_id: 2 },
    revoke: false,
  });
  assert.deepStrictEqual(parseUserUpdate({ status: 'inactive' }, agent, { meId: 1, activeAdmins: 1 }), {
    changes: { role: 'agent', status: 'inactive', extension_id: 3 },
    revoke: true,
  });
  // Promoted to admin: no extension, sessions end (new rights apply on next login)
  assert.deepStrictEqual(parseUserUpdate({ role: 'admin' }, agent, { meId: 1, activeAdmins: 1 }), {
    changes: { role: 'admin', status: 'active', extension_id: null },
    revoke: true,
  });
  assert.match(parseUserUpdate({ role: 'agent' }, admin, { meId: 9, activeAdmins: 2 }).error, /extension/);
});

test('edit: never locks everyone out', () => {
  assert.match(parseUserUpdate({ status: 'inactive' }, admin, { meId: 1, activeAdmins: 3 }).error, /your own admin/);
  assert.match(
    parseUserUpdate({ role: 'agent', extensionId: 3 }, admin, { meId: 9, activeAdmins: 1 }).error,
    /at least one active admin/,
  );
  assert.ok(parseUserUpdate({ status: 'inactive' }, admin, { meId: 9, activeAdmins: 2 }).changes);
});

test('revoking ends sessions that started before it, not later logins', () => {
  const before = { id: 42, loginAt: Date.now() - 1000 };
  const legacy = { id: 42 }; // logged in before loginAt existed
  assert.strictEqual(isRevoked(before), false);
  revokeUserSessions(42);
  assert.strictEqual(isRevoked(before), true);
  assert.strictEqual(isRevoked(legacy), true);
  assert.strictEqual(isRevoked({ id: 42, loginAt: Date.now() + 1 }), false);
  assert.strictEqual(isRevoked({ id: 43, loginAt: 0 }), false);
});
