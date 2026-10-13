// live_agents (who is logged in, from the real sources) and db:check --fix.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { buildPresence, syncPresence } = require('../src/services/presence');
const { findProblems, applyFixes, CHECKS } = require('../src/tools/db-check');

const T = new Date('2026-10-14T05:00:00Z');
const SOURCES = {
  open: [
    {
      user_id: 2,
      username: 'agent1001',
      ext: '1001',
      status: 'available',
      reason: null,
      started_at: T,
      extension_name: '1001',
      queue_id: 4,
      last_queue_id: 4,
    },
    {
      user_id: 3,
      username: 'agent1002',
      ext: '1002',
      status: 'break',
      reason: 'Lunch',
      started_at: T,
      extension_name: '1002',
      queue_id: null,
      last_queue_id: 4,
    },
  ],
  connected: [2, 5],
  users: [{ id: 5, username: 'agent1003', ext: '1003' }],
  calls: [
    {
      id: 80,
      to_number: '9840012345',
      from_extension: '1001',
      transfer_ext: null,
      start_time: T,
      agent_connect_time: T,
    },
  ],
  lines: { 1001: 'online', 1002: 'offline', 1003: 'online' },
  queues: [{ id: 4, name: 'Sales Queue' }],
  campaigns: [{ id: 1, queue_id: 4, name: 'Sales' }],
  logins: { 2: T },
};

test('live agents: on a call / on break / logged in without a queue; line and screen', () => {
  const rows = buildPresence(SOURCES);
  const by = Object.fromEntries(rows.map((r) => [r.username, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['agent1001', 'agent1002', 'agent1003']);
  assert.deepStrictEqual(
    {
      state: by.agent1001.state,
      call: by.agent1001.call_id,
      campaign: by.agent1001.campaign_name,
      line: by.agent1001.line,
      screen: by.agent1001.screen_open,
    },
    { state: 'on_call', call: 80, campaign: 'Sales', line: 'registered', screen: 1 },
  );
  // On break: the queue they were working still shows; screen closed, line down.
  assert.deepStrictEqual(
    {
      state: by.agent1002.state,
      reason: by.agent1002.reason,
      queue: by.agent1002.queue_name,
      line: by.agent1002.line,
      screen: by.agent1002.screen_open,
      seen: by.agent1002.seen,
    },
    { state: 'break', reason: 'Lunch', queue: 'Sales Queue', line: 'unregistered', screen: 0, seen: false },
  );
  assert.deepStrictEqual(
    { state: by.agent1003.state, status: by.agent1003.status, queue: by.agent1003.queue_id },
    { state: 'logged_in', status: null, queue: null },
  );
  // Asterisk not reachable: line unknown, nobody assumed offline.
  assert.ok(buildPresence({ ...SOURCES, lines: null }).every((r) => r.line === 'unknown'));
});

test('sync: upserts every logged-in agent and removes the ones who left', async () => {
  const sql = [];
  const db = {
    async query(q, params) {
      const s = q.replace(/\s+/g, ' ').trim();
      sql.push([s, params]);
      if (s.includes('FROM agent_status_log asl')) return [SOURCES.open];
      if (s.includes('FROM users u LEFT JOIN extensions')) return [SOURCES.users];
      if (s.startsWith('SELECT id, to_number')) return [SOURCES.calls];
      if (s.startsWith('SELECT id, name FROM queues')) return [SOURCES.queues];
      if (s.startsWith('SELECT MIN(id) AS id, queue_id')) return [SOURCES.campaigns];
      return [[]];
    },
  };
  const ari = {
    endpointStates: async () => ({ 1001: 'online' }),
    endpointState: async (r) => (r === 'PJSIP/1003' ? 'online' : 'offline'),
  };
  const hub = { connectedUserIds: () => [2, 5] };
  const rows = await syncPresence({ pool: db, ari, hub });
  assert.strictEqual(rows.length, 3);
  const upserts = sql.filter(([s]) => s.startsWith('INSERT INTO live_agents'));
  assert.strictEqual(upserts.length, 3);
  assert.match(upserts[0][0], /ON DUPLICATE KEY UPDATE .*last_seen_at = IF\(\?, NOW\(\), last_seen_at\)/);
  const del = sql.find(([s]) => s.startsWith('DELETE FROM live_agents'));
  assert.deepStrictEqual(del[1], [[2, 3, 5]]);
  // Endpoints ARI didn't list were asked one by one.
  assert.strictEqual(rows.find((r) => r.user_id === 5).line, 'registered');
  assert.strictEqual(rows.find((r) => r.user_id === 3).line, 'unregistered');
});

test('db:check --fix: backs up the touched tables first, fixes only fixable problems', async () => {
  const stuck = CHECKS.find((c) => c.title.startsWith('Call still open after 2 h'));
  const dup = CHECKS.find((c) => c.title === 'Same phone twice in one campaign');
  const ran = [];
  const db = {
    async query(q) {
      ran.push(q.replace(/\s+/g, ' ').trim());
      if (q === stuck.sql) return [[{ id: 68 }]];
      if (q === dup.sql) return [[{ campaign_id: 1, phone: '98', n: 2 }]];
      if (/^\s*UPDATE calls/.test(q)) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
  const quiet = () => {};
  const found = await findProblems(db, quiet);
  assert.deepStrictEqual(
    found.map((f) => f.check.title),
    [stuck.title, dup.title],
  );
  const backedUp = [];
  const done = await applyFixes(db, found, { backup: (t) => (backedUp.push(...t), '/tmp/x.sql'), log: quiet });
  assert.deepStrictEqual(backedUp, ['calls']);
  assert.deepStrictEqual(done, [{ title: stuck.title, changed: 1 }]);
  assert.ok(ran.some((s) => s.startsWith('UPDATE calls SET end_time')));
  assert.ok(!ran.some((s) => /^(DELETE|UPDATE) leads/.test(s))); // duplicates are only reported
});

test('every fix has tables to back up and SQL that only writes them', () => {
  for (const c of CHECKS.filter((x) => x.fix)) {
    assert.ok(c.fix.tables.length && c.fix.sql.length && c.fix.note, c.title);
    for (const s of c.fix.sql) {
      const target = /^\s*(?:UPDATE|DELETE \w+ FROM|DELETE FROM)\s+(\w+)/.exec(s)[1];
      assert.ok(c.fix.tables.includes(target), `${c.title}: writes ${target}`);
    }
  }
});
