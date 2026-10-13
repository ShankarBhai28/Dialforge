// Call monitoring rules: only an agent on a call, only with a connected
// monitoring line, the right ChanSpy options per mode - against fakes.
const assert = require('node:assert');
const { test } = require('node:test');
const { SPY_OPTIONS, startMonitor } = require('../src/services/monitor');

function deps({
  onCall = true,
  supLine = { id: 9, name: '2001', sip_password: 'x', enabled: 1 },
  lineState = 'online',
} = {}) {
  const originated = [];
  return {
    originated,
    pool: {
      async query(sql, params) {
        const s = sql.replace(/\s+/g, ' ');
        if (s.includes("FROM users WHERE id = ? AND role = 'agent'")) {
          return [params[0] === 21 ? [{ id: 21, username: 'agent04' }] : []];
        }
        if (s.includes('FROM agent_status_log')) return [[{ id: 1, status: 'available', extension_name: '1003' }]];
        if (s.includes('FROM calls WHERE (from_extension')) return [onCall ? [{ id: 5 }] : []];
        if (s.includes('FROM users u JOIN extensions e')) return [supLine ? [supLine] : []];
        throw new Error('unexpected query ' + s);
      },
    },
    ari: { endpointState: async () => lineState },
    ami: { originate: async (o) => originated.push(o) },
  };
}

test('listen / whisper / barge: Asterisk calls the supervisor line into df-monitor with the right ChanSpy options', async () => {
  for (const mode of ['listen', 'whisper', 'barge']) {
    const d = deps();
    const r = await startMonitor({ supervisorId: 1, agentId: 21, mode, scope: null }, d);
    assert.deepStrictEqual(r, { agent: 'agent04', extension: '1003', mode, line: '2001' });
    assert.deepStrictEqual(d.originated[0], {
      channel: 'PJSIP/2001',
      context: 'df-monitor',
      exten: '1003',
      callerId: '"Monitor agent04" <1003>',
      variables: { DF_SPY_OPTS: SPY_OPTIONS[mode] },
    });
  }
  assert.deepStrictEqual(SPY_OPTIONS, { listen: 'qEd', whisper: 'qEdw', barge: 'qEdB' });
});

test('refused with a reason the supervisor can act on', async () => {
  const run = (over, args = {}) =>
    startMonitor({ supervisorId: 1, agentId: 21, mode: 'listen', scope: null, ...args }, deps(over));
  await assert.rejects(run({}, { mode: 'record' }), /mode must be/);
  await assert.rejects(run({}, { agentId: 99 }), { status: 404 });
  await assert.rejects(run({}, { scope: { agentIds: [5], campaignIds: [], teamIds: [] } }), { status: 404 });
  await assert.rejects(run({ onCall: false }), /not on a call/);
  await assert.rejects(run({ supLine: null }), /no monitoring line/);
  await assert.rejects(run({ supLine: { id: 9, name: '2001', enabled: 0 } }), /no monitoring line/);
  await assert.rejects(run({ lineState: 'offline' }), /isn't connected/);
  await assert.rejects(run({ lineState: null }), /isn't connected/);
  await assert.rejects(run({ supLine: { id: 9, name: '1003', enabled: 1 } }), /your own line/);
});
