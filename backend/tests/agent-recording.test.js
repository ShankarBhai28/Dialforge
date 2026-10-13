// Agents play recordings of their own calls and of calls on leads they may
// open; their call log carries the outcome and "has a recording" (no path).
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const CALLS = {
  1: { id: 1, lead_id: 7, agent_user_id: 5, from_extension: '1003', transfer_ext: null, recording_path: '/r/1.mp3' },
  2: { id: 2, lead_id: 8, agent_user_id: 6, from_extension: '1001', transfer_ext: null, recording_path: '/r/2.mp3' },
  3: { id: 3, lead_id: 9, agent_user_id: 6, from_extension: '1001', transfer_ext: null, recording_path: '/r/3.mp3' },
};
const LEADS = { 7: { id: 7, campaign_id: 2 }, 8: { id: 8, campaign_id: 2 }, 9: { id: 9, campaign_id: 99 } };
const sql = [];
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT id, lead_id, agent_user_id')) return [[CALLS[params[0]]].filter(Boolean)];
    if (s.startsWith('SELECT id, campaign_id FROM leads')) return [[LEADS[params[0]]].filter(Boolean)];
    if (s.startsWith('SELECT 1 FROM calls WHERE lead_id')) return [[]];
    if (s.startsWith('SELECT ca.id, ca.lead_id')) {
      return [
        [
          { id: 1, outcome: 'interested', outcome_label: null, has_recording: 1 },
          { id: 2, outcome: null, outcome_label: null, has_recording: 0 },
        ],
      ];
    }
    return [[]];
  },
});
fake('src/services/agents.js', {
  ...require(path.join(root, 'src/services/agents.js')),
  findCurrentCampaign: async () => ({ id: 2 }),
});
fake('src/services/recording.js', {
  ...require(path.join(root, 'src/services/recording.js')),
  playableFile: () => ({ file: __filename, type: 'audio/mpeg' }),
});

const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = { user: { id: 5, username: 'a5', role: 'agent', extensionName: '1003', loginAt: Date.now() } };
    next();
  },
  webDistDir: '/nonexistent',
  audit: false,
});
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// node:http, not fetch (fetch's pool crashes Node at exit on Windows).
const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get(`${base}${p}`, { agent: false }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
      })
      .on('error', reject);
  });

test('own call plays; a colleague call on a lead of my campaign plays; others are refused', async () => {
  const own = await get('/agent/calls/1/recording');
  assert.strictEqual(own.status, 200);
  assert.match(own.type, /audio\/mpeg/);
  assert.strictEqual((await get('/agent/calls/2/recording')).status, 200); // lead 8 is in campaign 2
  assert.strictEqual((await get('/agent/calls/3/recording')).status, 403); // lead 9: another campaign, not theirs
  assert.strictEqual((await get('/agent/calls/404/recording')).status, 404);
});

test('agent call log: own calls by agent or extension, outcome label, recording flag only', async () => {
  const r = await get('/calls');
  const rows = JSON.parse(r.text);
  assert.deepStrictEqual(
    rows.map((x) => [x.id, x.outcome_label, x.has_recording]),
    [
      [1, 'Interested', true],
      [2, null, false],
    ],
  );
  assert.ok(rows.every((x) => !('recording_path' in x)));
  assert.deepStrictEqual(
    rows.map((x) => x.is_callback),
    [false, false],
  );
  const [q, params] = sql.find(([s]) => s.startsWith('SELECT ca.id, ca.lead_id'));
  assert.match(q, /WHERE \(ca\.agent_user_id = \? OR ca\.from_extension = \?\) AND ca\.start_time >= \?/);
  assert.deepStrictEqual(params.slice(0, 2), [5, '1003']);
});

test('agent call log period: today = one local day; default 7 days', async () => {
  const { parseRange, localToday } = require('../src/services/reports/time');
  sql.length = 0;
  await get('/calls?period=today');
  const today = parseRange({ from: localToday() });
  assert.deepStrictEqual(sql.find(([s]) => s.startsWith('SELECT ca.id'))[1].slice(2), [today.start, today.end]);
  sql.length = 0;
  await get('/calls');
  const [, p] = sql.find(([s]) => s.startsWith('SELECT ca.id'));
  assert.strictEqual((Date.parse(p[3]) - Date.parse(p[2])) / 86400000, 7);
});
