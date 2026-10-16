// Live Agents wallboard: each agent's campaign, team, line, current call and
// today's numbers; callers waiting and today's totals.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { liveAgents, floorSummary } = require('../src/services/liveFloor');

const NOW = new Date('2026-10-17T06:00:00Z'); // 11:30 IST
function db(tables) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push([sql.replace(/\s+/g, ' '), params]);
      for (const [needle, rows] of tables) if (sql.includes(needle)) return [rows];
      return [[]];
    },
  };
}

test('each agent: campaign, team, line, login, current call (lead, kind, timer start) and today with avg handle time', async () => {
  const d = db([
    [
      'FROM users u',
      [
        {
          id: 2,
          username: 'agent1001',
          extension_name: '1001',
          status: 'available',
          started_at: NOW,
          queue_name: 'Sales Q',
          campaign_name: 'Home Loans',
          wrapup_sec: 10,
          teams: 'Team A',
          line: 'registered',
          login_at: NOW,
        },
        { id: 3, username: 'agent1002', extension_name: '1002', status: null, line: null, login_at: null },
      ],
    ],
    [
      'FROM calls ca LEFT JOIN leads',
      [
        {
          id: 70,
          from_extension: '1001',
          to_number: '9003220102',
          direction: 'outbound',
          dial_attempt_id: 12,
          start_time: NOW,
          agent_connect_time: NOW,
          lead_name: 'Ravi',
        },
      ],
    ],
    ['GROUP BY agent_user_id', [{ id: 2, calls: 12, connected: 6, talk: 900 }]],
    ["status = 'acw'", [{ id: 2, acw: 120 }]],
  ]);
  const [a, b] = await liveAgents(null, { pool: d }, NOW);
  assert.strictEqual(a.campaign_name, 'Home Loans');
  assert.strictEqual(a.teams, 'Team A');
  assert.strictEqual(a.line, 'registered');
  assert.deepStrictEqual(a.call, {
    id: 70,
    number: '9003220102',
    leadName: 'Ravi',
    kind: 'dialer',
    startedAt: NOW,
    connectedAt: NOW,
  });
  assert.strictEqual(a.active_call_number, '9003220102'); // kept for the Dashboard
  assert.deepStrictEqual(a.today, { calls: 12, connected: 6, talkSeconds: 900, avgHandleSeconds: 170 }); // (900+120)/6
  assert.strictEqual(b.line, null); // not logged in: no line shown
  assert.deepStrictEqual(b.today, { calls: 0, connected: 0, talkSeconds: 0, avgHandleSeconds: null });
  // "today" starts at local midnight (IST) = 18:30 UTC the day before
  const todayQuery = d.seen.find(([s]) => s.includes('GROUP BY agent_user_id'));
  assert.strictEqual(todayQuery[1][1], '2026-10-16 18:30:00');
});

test('summary: inbound callers in the queue + answered dialer calls waiting, the longest wait, today within the teams', async () => {
  const d = db([
    ["direction = 'inbound'", [{ n: 2, oldest: new Date('2026-10-17T05:59:15Z') }]],
    ["status = 'answered'", [{ n: 1, oldest: new Date('2026-10-17T05:59:50Z') }]],
    ['FROM calls WHERE start_time >=', [{ calls: 40, connected: 22, talk: 3600 }]],
  ]);
  const s = await floorSummary({ campaignIds: [4], agentIds: [] }, { pool: d }, NOW);
  assert.deepStrictEqual(s, {
    waiting: 3,
    waitingInbound: 2,
    waitingDialer: 1,
    longestWaitSeconds: 45,
    today: { calls: 40, connected: 22, talkSeconds: 3600 },
  });
  assert.ok(
    d.seen.every(([sql]) => sql.includes('campaign_id IN (?)')),
    'every count stays within the role scope',
  );
});
