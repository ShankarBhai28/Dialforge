// Call control (transfer / conference) against a fake Asterisk (ARI + AMI) and a fake DB.
// Each test builds a fresh module instance with setup(); no network, no real calls.
const assert = require('node:assert');
const { test } = require('node:test');
const path = require.resolve('../call-control.js');

function setup({ agents, callRow, c2c } = {}) {
  delete require.cache[require.resolve(path)];
  const cc = require(path);
  const log = [];
  const bridges = new Map(); // id -> Set(channel)
  const hungup = new Set();
  let bridgeSeq = 0;
  const events = [];
  const acw = [];
  const sql = [];
  const ari = {
    async createBridge(type = 'mixing') {
      const id = `br${++bridgeSeq}-${type}`;
      bridges.set(id, new Set());
      return { id };
    },
    async addChannelToBridge(b, c) {
      for (const s of bridges.values()) if (s.has(c)) throw new Error('already in a bridge');
      bridges.get(b).add(c);
    },
    async removeChannelFromBridge(b, c) {
      bridges.get(b) && bridges.get(b).delete(c);
    },
    async destroyBridge(b) {
      bridges.delete(b);
    },
    async startBridgeMoh(b) {
      log.push(`moh+ ${b}`);
    },
    async stopBridgeMoh(b) {
      log.push(`moh- ${b}`);
    },
    async playOnBridge(b, m) {
      log.push(`play ${m}`);
    },
    async stopPlayback() {
      log.push('stop play');
    },
    async hangup(c) {
      hungup.add(c);
      for (const s of bridges.values()) s.delete(c);
    },
    async originate(o) {
      log.push(`originate ${o.endpoint} ${o.appArgs} ${o.channelId}`);
      if (o.endpoint.includes('fail')) throw new Error('no route');
    },
    async getChannel(id) {
      return { id, name: `PJSIP/trunk-${id}` };
    },
    async isEndpointOnline() {
      return true;
    },
    async setChannelVar(c, k, v) {
      log.push(`var ${c} ${k}=${v}`);
    },
    async continueInDialplan(c, o) {
      log.push(`continue ${c} ${o.context}`);
    },
  };
  const ami = {
    async redirect(ch, a, extra) {
      log.push(`redirect ${ch}->${a.exten} + ${extra.channel}->${extra.exten}`);
    },
  };
  const pool = {
    async query(q, params) {
      const s = q.replace(/\s+/g, ' ').trim();
      sql.push([s, params]);
      if (s.startsWith('SELECT id FROM calls WHERE from_extension')) return [[{ id: 42 }]];
      if (s.startsWith('SELECT id, to_number, campaign_id'))
        return [
          [
            callRow || {
              id: 42,
              to_number: '9003220102',
              campaign_id: 1,
              dial_attempt_id: 7,
              channel_name: 'PJSIP/dialforge-nxtra1-0001',
              agent_channel: 'PJSIP/1003-0002',
            },
          ],
        ];
      if (s.includes('FROM agent_status_log asl JOIN users'))
        return [
          agents || [
            { userId: 2, username: 'agent1001', ext: '1001', status: 'available', queueId: 4, busy: 0 },
            { userId: 3, username: 'agent1002', ext: '1002', status: 'available', queueId: 5, busy: 1 },
          ],
        ];
      if (s.startsWith('SELECT q.id, q.name, q.asterisk_name, c.id AS campaign_id FROM queues'))
        return [[{ id: 5, name: 'Real Test Queue', asterisk_name: 'real_test_queue', campaign_id: 4 }]];
      if (s.startsWith('SELECT q.id, q.name, q.asterisk_name, c.id AS campaign_id FROM campaigns'))
        return [[{ id: 4, name: 'Support Queue', asterisk_name: 'support_queue', campaign_id: 1 }]];
      if (s.startsWith('SELECT outbound_caller_id')) return [[{ outbound_caller_id: '8065098690' }]];
      return [{ affectedRows: 1 }];
    },
  };
  const activeCalls = new Map(c2c ? [[42, c2c]] : []);
  const queueCallChannels = new Map();
  cc.init({
    pool,
    ari,
    ami,
    APP_NAME: 'dialforge-app',
    activeCalls,
    queueCallChannels,
    logEvent: async (id, ev, p) => events.push(ev),
    setAgentStatus: async (u, st, r, q, ext) => acw.push(ext),
    findAgentIdByExtension: async (ext) => ({ 1003: 6, 1001: 2, 1002: 3 })[ext],
    resolveDestination: async (n, cid) => ({ endpoint: `PJSIP/${n}@dialforge-nxtra1`, callerId: cid }),
  });
  const start = (id, args, name) => cc.onAriEvent({ type: 'StasisStart', args, channel: { id, name: name || id } });
  const gone = (id) => cc.onAriEvent({ type: 'StasisEnd', channel: { id } });
  // Answer the adopt redirect as Asterisk would.
  async function adopted(promise) {
    await new Promise((r) => setTimeout(r, 5));
    await start('cust-ch', ['adopt', '42', 'cust'], 'PJSIP/dialforge-nxtra1-0001');
    await start('agent-ch', ['adopt', '42', 'agent']);
    return promise;
  }
  const where = (c) => [...bridges.entries()].filter(([, s]) => s.has(c)).map(([b]) => b)[0] || null;
  return { cc, log, bridges, hungup, events, acw, sql, start, gone, adopted, where, queueCallChannels, activeCalls };
}
const partyId = (t) =>
  t.log
    .find((l) => l.startsWith('originate'))
    .split(' ')
    .pop();

let t;
let r;
let pid;

test('Dialer call: warm transfer to agent1001 -> answer -> complete'.replace(/'/g, "'"), async () => {
  t = setup();
  r = await t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'agent', target: 2 }));
  assert.strictEqual(r.status, 'consulting');
  assert(t.log[0].startsWith('redirect PJSIP/dialforge-nxtra1-0001->cus42 + PJSIP/1003-0002->agt42'));
  assert(t.cc.isControlled(42));
  assert(/holding/.test(t.where('cust-ch')), 'customer parked in holding bridge');
  pid = partyId(t);
  assert(t.log.some((l) => l === 'originate PJSIP/1001 xfer,42 ' + pid));
  assert(t.log.includes('play tone:ring;tonezone=in'));
  assert.strictEqual(t.cc.viewFor('1003').parties[0].state, 'ringing');
  await t.start(pid, ['xfer', '42']);
  assert.strictEqual(t.where(pid), t.where('agent-ch'), 'agent talks to target');
  assert.strictEqual(t.cc.viewFor('1003').parties[0].state, 'up');
  await t.cc.completeTransfer('1003');
  assert.strictEqual(t.where('cust-ch'), t.where(pid), 'customer with target');
  assert(t.hungup.has('agent-ch'), 'agent dropped');
  assert.deepStrictEqual(t.acw, ['1003']);
  assert(
    t.sql.some(([s, p]) => s.startsWith('UPDATE calls SET from_extension = ?, transfer_ext = NULL') && p[0] === '1001'),
    'owner -> 1001',
  );
  assert.strictEqual(t.cc.viewFor('1001').controlled, true, 'target now controls the call');
  // customer hangs up -> call ends, target gets ACW
  await t.gone('cust-ch');
  assert(t.hungup.has(pid));
  assert(t.events.includes('ended'));
  assert.deepStrictEqual(t.acw, ['1003', '1001']);
  assert.strictEqual(t.cc.isControlled(42), false);
});

test('Warm -> target hangs up during consult -> customer back with agent'.replace(/'/g, "'"), async () => {
  t = setup();
  await t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'number', target: '98400 12345' }));
  pid = partyId(t);
  assert(t.log.some((l) => l.startsWith('originate PJSIP/9840012345@dialforge-nxtra1')));
  await t.start(pid, ['xfer', '42']);
  await t.gone(pid);
  assert.strictEqual(t.where('cust-ch'), t.where('agent-ch'), 'back to the customer');
  assert.strictEqual(t.bridges.size, 1, 'hold bridge destroyed');
});

test(
  'Warm -> merge -> conference -> agent leaves; customer + external continue; external leaves -> end'.replace(
    /'/g,
    "'",
  ),
  async () => {
    t = setup();
    await t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'number', target: '9840012345' }));
    pid = partyId(t);
    await t.start(pid, ['xfer', '42']);
    await t.cc.merge('1003');
    const b = t.where('agent-ch');
    assert(t.where('cust-ch') === b && t.where(pid) === b, '3-way');
    await t.cc.leave('1003');
    assert(t.hungup.has('agent-ch'));
    assert.strictEqual(t.where('cust-ch'), t.where(pid));
    assert.strictEqual(t.cc.isControlled(42), true);
    await t.gone(pid);
    assert(t.hungup.has('cust-ch'), 'customer alone -> ended');
    assert.strictEqual(t.cc.isControlled(42), false);
  },
);

test('Conference add agent -> drop them'.replace(/'/g, "'"), async () => {
  t = setup();
  r = await t.adopted(t.cc.transfer('1003', { mode: 'conference', targetType: 'agent', target: 2 }));
  pid = partyId(t);
  assert.strictEqual(t.where('cust-ch'), t.where('agent-ch'), 'customer stays with agent while adding');
  await t.start(pid, ['xfer', '42']);
  assert.strictEqual(t.cc.viewFor('1003').parties[0].role, 'member');
  await t.cc.dropParty('1003', pid);
  assert(t.hungup.has(pid));
  assert.strictEqual(t.where('cust-ch'), t.where('agent-ch'));
});

test('Blind to agent: agent dropped at once, MOH, target answers -> controls'.replace(/'/g, "'"), async () => {
  t = setup();
  await t.adopted(t.cc.transfer('1003', { mode: 'blind', targetType: 'agent', target: 2 }));
  pid = partyId(t);
  assert(t.hungup.has('agent-ch'));
  assert(t.log.some((l) => l.startsWith('moh+')));
  assert.deepStrictEqual(t.acw, ['1003']);
  await t.start(pid, ['xfer', '42']);
  assert.strictEqual(t.where('cust-ch'), t.where(pid));
  assert.strictEqual(t.cc.viewFor('1001').controlled, true);
});

test('Blind to number, nobody answers -> customer back to the campaign queue'.replace(/'/g, "'"), async () => {
  t = setup();
  await t.adopted(t.cc.transfer('1003', { mode: 'blind', targetType: 'number', target: '9840012345' }));
  pid = partyId(t);
  await t.cc.onAriEvent({ type: 'ChannelDestroyed', channel: { id: pid } });
  assert(t.log.includes('var cust-ch QUEUENAME=support_queue'));
  assert(t.log.includes('continue cust-ch queue-dispatch'));
  assert.strictEqual(t.queueCallChannels.get('PJSIP/dialforge-nxtra1-0001'), 42);
  assert.strictEqual(t.cc.isControlled(42), false);
});

test('Blind to queue'.replace(/'/g, "'"), async () => {
  t = setup();
  r = await t.adopted(t.cc.transfer('1003', { mode: 'blind', targetType: 'queue', target: 5 }));
  assert.strictEqual(r.status, 'transferred');
  assert(t.log.includes('var cust-ch QUEUENAME=real_test_queue'));
  assert(t.hungup.has('agent-ch'));
  assert(
    t.sql.some(([s, p]) => s.startsWith('UPDATE calls SET from_extension = NULL') && p[0] === 4),
    'campaign switched',
  );
});

test(
  'Warm to queue: busy agent skipped -> no free agent error; free -> picks 1001 in queue 4'.replace(/'/g, "'"),
  async () => {
    t = setup();
    await assert.rejects(
      t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'queue', target: 5 })),
      /no free agent/,
    );
    t = setup({
      agents: [{ userId: 2, username: 'agent1001', ext: '1001', status: 'available', queueId: 5, busy: 0 }],
    });
    await t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'queue', target: 5 }));
    assert(t.log.some((l) => l.startsWith('originate PJSIP/1001')));
  },
);

test('Agent hangs up while consult rings -> becomes blind transfer'.replace(/'/g, "'"), async () => {
  t = setup();
  await t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'agent', target: 2 }));
  pid = partyId(t);
  await t.gone('agent-ch');
  assert.strictEqual(t.cc.isControlled(42), true);
  await t.start(pid, ['xfer', '42']);
  assert.strictEqual(t.where('cust-ch'), t.where(pid));
});

test('Click-to-call adopted without AMI; errors'.replace(/'/g, "'"), async () => {
  t = setup({ c2c: { agentChannelId: 'a1', destChannelId: 'd1', bridgeId: 'brX' } });
  t.bridges.set('brX', new Set(['a1', 'd1']));
  await t.cc.transfer('1003', { mode: 'conference', targetType: 'number', target: '9840012345' });
  assert(!t.log.some((l) => l.startsWith('redirect')));
  assert.strictEqual(t.activeCalls.size, 0);
  await assert.rejects(
    t.cc.transfer('1003', { mode: 'conference', targetType: 'number', target: '1234' }),
    /finish the transfer/,
  );
  await assert.rejects(
    t.cc.transfer('1003', { mode: 'warm', targetType: 'number', target: '12' }),
    /finish the transfer|valid number/,
  );
});

test('Target failure while agent still connected -> error, nothing changed'.replace(/'/g, "'"), async () => {
  t = setup();
  await assert.rejects(
    t.adopted(t.cc.transfer('1003', { mode: 'warm', targetType: 'number', target: 'fail' })),
    /valid number/,
  );
});
