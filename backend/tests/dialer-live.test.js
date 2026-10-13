// Dialer live calls (states, counts, just finished) and a supervisor's Hang up.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { dialerLive, hangupAttempt, liveState } = require('../src/services/dialerLive');

const T = (s) => new Date(`2026-10-14T10:${s}Z`);

test('a call is Dialing, Ringing (180 seen), Waiting (answered) or Connected', () => {
  assert.strictEqual(liveState({ status: 'dialing', ringing_at: null }), 'dialing');
  assert.strictEqual(liveState({ status: 'dialing', ringing_at: T('00:02') }), 'ringing');
  assert.strictEqual(liveState({ status: 'answered' }), 'waiting');
  assert.strictEqual(liveState({ status: 'connected' }), 'connected');
});

test('live list with the time each state began, counts, and the last finished calls', async () => {
  const db = {
    async query(sql) {
      if (sql.includes("a.status <> 'ended'")) {
        return [
          [
            {
              id: 9,
              lead_id: 1,
              phone: '98',
              status: 'connected',
              started_at: T('00:00'),
              connected_at: T('00:20'),
              lead_name: 'Ravi',
              agent: 'agent1001',
              call_id: 70,
            },
            {
              id: 10,
              lead_id: 2,
              phone: '97',
              status: 'dialing',
              started_at: T('00:30'),
              ringing_at: T('00:33'),
              lead_name: null,
              agent: null,
            },
            { id: 11, lead_id: 3, phone: '96', status: 'dialing', started_at: T('00:40'), ringing_at: null },
          ],
        ];
      }
      return [
        [
          {
            id: 5,
            lead_id: 4,
            phone: '95',
            result: 'busy',
            ended_at: T('00:10'),
            lead_name: 'Meena',
            talk_seconds: null,
          },
        ],
      ];
    },
  };
  const r = await dialerLive(1, { pool: db });
  assert.deepStrictEqual(
    r.live.map((x) => [x.id, x.state, x.since.toISOString().slice(14, 19), x.agent]),
    [
      [9, 'connected', '00:20', 'agent1001'],
      [10, 'ringing', '00:33', null],
      [11, 'dialing', '00:40', null],
    ],
  );
  assert.deepStrictEqual(r.counts, { dialing: 1, ringing: 1, waiting: 0, connected: 1 });
  assert.deepStrictEqual(r.finished[0], {
    id: 5,
    leadId: 4,
    leadName: 'Meena',
    phone: '95',
    result: 'busy',
    resultLabel: 'Busy',
    endedAt: T('00:10'),
    agent: null,
    talkSeconds: null,
  });
});

function world(attempt, hangupError = null) {
  const done = [];
  const deps = {
    pool: {
      async query(sql, params) {
        if (sql.startsWith('SELECT id, campaign_id')) return [[attempt].filter(Boolean)];
        done.push(['sql', sql.replace(/\s+/g, ' ').trim(), params]);
        return [{ affectedRows: 1 }];
      },
    },
    ari: {
      hangup: async (ch) => {
        done.push(['hangup', ch]);
        if (hangupError) throw new Error(hangupError);
      },
    },
    finishAttempt: async (pool, id, result) => done.push(['finish', id, result]),
    logEvent: async (callId, type) => done.push(['event', callId, type]),
  };
  return { deps, done };
}
const user = { username: 'tl1' };
const all = () => true;

test('hang up before an agent: cancelled, lead waits an hour, channel hung up', async () => {
  const { deps, done } = world({
    id: 11,
    campaign_id: 1,
    lead_id: 3,
    status: 'dialing',
    channel_id: 'dfd-11',
    call_id: null,
  });
  const r = await hangupAttempt(11, { user, inScope: all }, deps);
  assert.deepStrictEqual(r, { id: 11, was: 'dialing' });
  assert.deepStrictEqual(done[0], ['finish', 11, 'cancelled']);
  assert.match(done[1][1], /UPDATE leads SET next_call_at = GREATEST\(.*INTERVAL 60 MINUTE\)/);
  assert.deepStrictEqual(done.at(-1), ['hangup', 'dfd-11']);
});

test('hang up while with an agent: the call just ends (no cancelled result), call event logged', async () => {
  const { deps, done } = world({
    id: 9,
    campaign_id: 1,
    lead_id: 1,
    status: 'connected',
    channel_id: 'dfd-9',
    call_id: 70,
  });
  await hangupAttempt(9, { user, inScope: all }, deps);
  assert.deepStrictEqual(done, [
    ['event', 70, 'hangup_by_supervisor'],
    ['hangup', 'dfd-9'],
  ]);
});

test('refused: other team, already ended; a channel already gone is fine', async () => {
  await assert.rejects(
    hangupAttempt(11, { user, inScope: () => false }, world({ id: 11, campaign_id: 1, status: 'dialing' }).deps),
    { status: 404 },
  );
  await assert.rejects(
    hangupAttempt(5, { user, inScope: all }, world({ id: 5, campaign_id: 1, status: 'ended' }).deps),
    {
      status: 409,
    },
  );
  const gone = world(
    { id: 12, campaign_id: 1, lead_id: 3, status: 'dialing', channel_id: 'dfd-12' },
    'ARI DELETE failed: 404 {}',
  );
  assert.deepStrictEqual(await hangupAttempt(12, { user, inScope: all }, gone.deps), { id: 12, was: 'dialing' });
  const broken = world(
    { id: 13, campaign_id: 1, lead_id: 3, status: 'dialing', channel_id: 'dfd-13' },
    'ARI DELETE failed: 500 x',
  );
  await assert.rejects(hangupAttempt(13, { user, inScope: all }, broken.deps), { status: 502 });
});
