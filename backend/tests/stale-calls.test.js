// Stale-call cleanup: open calls with no channel left in Asterisk are closed
// on the second check in a row - against fake deps (no MySQL, no Asterisk).
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });
fake('ari.js', {});
const { sweepStaleCalls, stillUp } = require('../src/services/staleCalls');

const dialerCall = {
  id: 7,
  channel_name: 'PJSIP/loadtrunk-0000001a',
  agent_channel: 'PJSIP/5001-0000001b',
  from_extension: '5001',
  dial_attempt_id: 70,
  agent_user_id: 21,
  agent_connect_time: new Date('2026-10-29T15:00:05Z'),
  start_time: new Date('2026-10-29T15:00:00Z'),
};

function setup({ calls, live, status = 'available' }) {
  const sql = [];
  const events = [];
  const statuses = [];
  const audits = [];
  const deps = {
    pool: {
      async query(q, params) {
        const s = q.replace(/\s+/g, ' ').trim();
        sql.push([s, params]);
        if (s.startsWith('SELECT id, channel_name')) return [calls];
        return [{ affectedRows: 1 }];
      },
    },
    ari: { liveChannels: async () => live },
    logEvent: async (...a) => events.push(a),
    setAgentStatus: async (...a) => statuses.push(a),
    openStatus: async () => (status ? { status } : null),
    audit: async (a) => audits.push(a),
  };
  return { deps, sql, events, statuses, audits };
}

test('a call whose channels are gone is closed on the second check, agent to wrap-up', async () => {
  const t = setup({ calls: [dialerCall], live: new Set(['PJSIP/5002-00000020']) });
  assert.deepStrictEqual(await sweepStaleCalls({ now: 1000, deps: t.deps }), []); // first sighting: wait
  assert.deepStrictEqual(await sweepStaleCalls({ now: 61000, deps: t.deps }), [7]);
  const update = t.sql.find(([s]) => s.startsWith('UPDATE calls SET end_time = NOW()'));
  assert.deepStrictEqual(update[1], [7]);
  assert.ok(t.sql.some(([s, p]) => s.startsWith("UPDATE dial_attempts SET status = 'ended'") && p[0] === 70));
  assert.deepStrictEqual(t.events, [[7, 'ended', { by: 'cleanup', reason: 'no channel left in Asterisk' }]]);
  assert.deepStrictEqual(t.statuses, [[21, 'acw', null, null, '5001']]);
  assert.strictEqual(t.audits[0].action, 'call.auto_close');
});

test('a call still up in Asterisk, or Asterisk not answering, is left alone', async () => {
  const up = setup({ calls: [dialerCall], live: new Set(['PJSIP/loadtrunk-0000001a']) });
  await sweepStaleCalls({ now: 1000, deps: up.deps });
  assert.deepStrictEqual(await sweepStaleCalls({ now: 61000, deps: up.deps }), []);

  const noAri = setup({ calls: [dialerCall], live: null });
  await sweepStaleCalls({ now: 1000, deps: noAri.deps });
  assert.deepStrictEqual(await sweepStaleCalls({ now: 61000, deps: noAri.deps }), []);
  assert.ok(!noAri.sql.some(([s]) => s.startsWith('UPDATE')));
});

test('back up between checks (a channel came) starts the count again', async () => {
  const call = { ...dialerCall, id: 8 };
  const gone = setup({ calls: [call], live: new Set() });
  await sweepStaleCalls({ now: 1000, deps: gone.deps });
  const back = setup({ calls: [call], live: new Set(['PJSIP/5001-0000001b']) });
  await sweepStaleCalls({ now: 61000, deps: back.deps });
  const again = setup({ calls: [call], live: new Set() });
  assert.deepStrictEqual(await sweepStaleCalls({ now: 121000, deps: again.deps }), []); // first sighting again
});

test('an agent already on break is not put into wrap-up', async () => {
  const t = setup({ calls: [{ ...dialerCall, id: 9 }], live: new Set(), status: 'break' });
  await sweepStaleCalls({ now: 1000, deps: t.deps });
  assert.deepStrictEqual(await sweepStaleCalls({ now: 61000, deps: t.deps }), [9]);
  assert.deepStrictEqual(t.statuses, []);
});

test('click-to-call rows without a channel name are judged by their extension', () => {
  const c2c = { id: 10, channel_name: null, agent_channel: null, from_extension: '1001', transfer_ext: null };
  assert.strictEqual(stillUp(c2c, new Set(['PJSIP/1001-00000031'])), true);
  assert.strictEqual(stillUp(c2c, new Set(['PJSIP/10010-00000031'])), false); // another extension
  assert.strictEqual(stillUp({ ...c2c, from_extension: null }, new Set()), true); // nothing to judge by
});
