// One login per agent: refuse while the screen is open elsewhere, take
// over on request (never during a call), always end older sessions.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });
fake('ari.js', { endpointState: async () => 'offline' });

const { claimAgentLogin } = require('../src/services/singleLogin');

/** A world where the agent has `open` status row, line `line`, screen `screen`, call `onCall`. */
function world({ open = null, line = 'offline', screen = false, onCall = false } = {}) {
  const done = [];
  const deps = {
    pool: {
      async query(sql) {
        if (sql.includes('FROM agent_status_log')) return [open ? [open] : []];
        if (sql.includes('FROM calls')) return [onCall ? [{ id: 1 }] : []];
        return [[]];
      },
    },
    ari: { endpointState: async () => line },
    hub: { isUserConnected: () => screen },
    endUserSessions: async (id, reason) => {
      done.push(['end', id, reason]);
      return 1000;
    },
    takeOffline: async (id, ext) => done.push(['offline', id, ext]),
  };
  return { deps, done };
}
const AGENT = { id: 5, username: 'a1', extension_name: '1003' };
const OPEN = { status: 'available', extension_name: '1003', started_at: '2026-10-13 10:00:00' };

test('nobody else: login goes ahead and still ends any older (stale) sessions', async () => {
  const { deps, done } = world();
  const r = await claimAgentLogin(AGENT, false, deps);
  assert.strictEqual(r.refuse, undefined);
  assert.strictEqual(r.tookOver, false);
  assert.ok(r.loginAt > 1000);
  assert.deepStrictEqual(done, [['end', 5, 'elsewhere']]);
});

test('screen open elsewhere: refused with a code the login page understands', async () => {
  const { deps, done } = world({ screen: true });
  const r = await claimAgentLogin(AGENT, false, deps);
  assert.strictEqual(r.refuse.status, 409);
  assert.strictEqual(r.refuse.body.code, 'already_logged_in');
  assert.deepStrictEqual(done, []);
});

test('logged in with the line registered (screen not connected right now) counts too', async () => {
  const { deps } = world({ open: OPEN, line: 'online' });
  assert.strictEqual((await claimAgentLogin(AGENT, false, deps)).refuse.body.code, 'already_logged_in');
});

test('an open status row whose line is down is a stale session, not a login elsewhere', async () => {
  const { deps } = world({ open: OPEN, line: 'offline' });
  assert.strictEqual((await claimAgentLogin(AGENT, false, deps)).refuse, undefined);
});

test('take over: the other screen is ended and the agent taken offline', async () => {
  const { deps, done } = world({ open: OPEN, line: 'online', screen: true });
  const r = await claimAgentLogin(AGENT, true, deps);
  assert.strictEqual(r.tookOver, true);
  assert.deepStrictEqual(done, [
    ['end', 5, 'elsewhere'],
    ['offline', 5, '1003'],
  ]);
});

test('never take over during a call', async () => {
  const { deps, done } = world({ open: OPEN, line: 'online', screen: true, onCall: true });
  const r = await claimAgentLogin(AGENT, true, deps);
  assert.strictEqual(r.refuse.body.code, 'on_call_elsewhere');
  assert.deepStrictEqual(done, []);
});
