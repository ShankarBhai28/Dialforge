// Click-to-call teardown in src/telephony/events.js, with fake ARI / AMI /
// DB modules put in the require cache before events.js loads them.
const assert = require('node:assert');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
const hungUp = [];
const events = [];
const acw = [];
let ariHandler = null;

function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', {
  async query(q, params) {
    sql.push([q.replace(/\s+/g, ' ').trim(), params]);
    if (/^SELECT from_extension FROM calls/.test(q)) return [[{ from_extension: '1001' }]];
    if (/SELECT to_number, campaign_id FROM calls/.test(q)) return [[{ to_number: '9840012345', campaign_id: null }]];
    return [{ affectedRows: 1 }];
  },
});
fake('ari.js', {
  connectEvents: (app, fn) => (ariHandler = fn),
  answer: async () => {},
  hangup: async (id) => hungUp.push(id),
  originate: async (o) => ({ id: o.appArgs.endsWith('dest') ? 'dest-ch' : 'agent-ch' }),
  createBridge: async () => ({ id: 'br1' }),
  addChannelToBridge: async () => {},
  destroyBridge: async () => {},
});
fake('ami.js', { on: () => {} });
fake('call-control.js', { init: () => {}, onAriEvent: async () => false, isControlled: () => false });
fake('src/services/agents.js', {
  findAgentIdByExtension: async () => 6,
  setAgentStatus: async (u, status, r, q, ext) => acw.push([status, ext]),
});
fake('src/services/calls.js', {
  logEvent: async (callId, type, payload) => events.push([callId, type, payload]),
  resolveDestination: async (n) => ({ endpoint: `PJSIP/${n}@trunk`, callerId: null }),
});

const { activeCalls } = require('../src/state');
require('../src/telephony/events').start();

beforeEach(() => {
  sql.length = hungUp.length = events.length = acw.length = 0;
  activeCalls.clear();
});
const send = (e) => ariHandler(e);
const lastUpdate = () => sql.filter(([q]) => q.startsWith('UPDATE calls SET end_time')).pop();

test('agent line never answers: call closed as agent_unanswered, no ACW', async () => {
  activeCalls.set(42, { agentChannelId: 'agent-ch', destChannelId: null, bridgeId: null });
  await send({ type: 'ChannelDestroyed', channel: { id: 'agent-ch' }, cause: 19, cause_txt: 'No answer' });
  assert.strictEqual(activeCalls.has(42), false);
  assert.deepStrictEqual(lastUpdate(), [
    "UPDATE calls SET end_time = NOW(), disposition = 'agent_unanswered' WHERE id = ?",
    [42],
  ]);
  assert.deepStrictEqual(events.at(-1), [42, 'agent_unanswered', { cause: 19, causeText: 'No answer' }]);
  assert.deepStrictEqual(acw, []);
});

test('customer busy: agent leg is hung up, call ends as busy, agent to ACW', async () => {
  activeCalls.set(43, { agentChannelId: 'agent-ch', destChannelId: null, bridgeId: null });
  await send({ type: 'StasisStart', args: ['click2call', '43', 'agent'], channel: { id: 'agent-ch' } });
  assert.strictEqual(activeCalls.get(43).destChannelId, 'dest-ch');
  await send({ type: 'ChannelDestroyed', channel: { id: 'dest-ch' }, cause: 17, cause_txt: 'User busy' });
  assert.deepStrictEqual(hungUp, ['agent-ch']);
  // Asterisk then ends the agent leg's Stasis session:
  await send({ type: 'StasisEnd', channel: { id: 'agent-ch' } });
  assert.deepStrictEqual(lastUpdate(), [
    'UPDATE calls SET end_time = NOW(), disposition = ? WHERE id = ?',
    ['busy', 43],
  ]);
  assert.deepStrictEqual(acw, [['acw', '1001']]);
});

test('normal answered call is untouched by ChannelDestroyed after StasisEnd', async () => {
  activeCalls.set(44, { agentChannelId: 'agent-ch', destChannelId: null, bridgeId: null });
  await send({ type: 'StasisStart', args: ['click2call', '44', 'agent'], channel: { id: 'agent-ch' } });
  await send({ type: 'StasisStart', args: ['click2call', '44', 'dest'], channel: { id: 'dest-ch' } });
  await send({ type: 'StasisEnd', channel: { id: 'dest-ch' } });
  await send({ type: 'ChannelDestroyed', channel: { id: 'dest-ch' }, cause: 16 });
  await send({ type: 'ChannelDestroyed', channel: { id: 'agent-ch' }, cause: 16 });
  assert.deepStrictEqual(lastUpdate(), [
    'UPDATE calls SET end_time = NOW(), disposition = ? WHERE id = ?',
    ['ended', 44],
  ]);
  assert.strictEqual(sql.filter(([q]) => q.startsWith('UPDATE calls SET end_time')).length, 1);
  assert.deepStrictEqual(acw, [['acw', '1001']]);
});
