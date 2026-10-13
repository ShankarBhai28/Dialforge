// Reports: local-day ranges, the math behind the figures, the CSV, the route.
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
const sql = [];
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', {
  async query(q, params) {
    const s = q.replace(/\s+/g, ' ').trim();
    sql.push([s, params]);
    if (s.startsWith('SELECT COUNT(*) AS calls')) return [[{ calls: 0, connected: 0, talk: 0, duration: 0 }]];
    return [[]];
  },
});

const { parseRange, offsetSql, localToday } = require('../src/services/reports/time');
const { shapeAgent } = require('../src/services/reports/agentReports');
const { shapeCampaign } = require('../src/services/reports/campaignReports');
const { resultLabel } = require('../src/services/reports/common');
const { catalog } = require('../src/services/reports');
const { toCsv } = require('../src/routes/reports');

const BOM = String.fromCharCode(0xfeff);

test('a report day is the local (India) day, sent to MySQL as the UTC window', () => {
  const now = new Date('2026-10-13T20:00:00Z'); // 01:30 on the 14th in India
  assert.strictEqual(localToday(now), '2026-10-14');
  const r = parseRange({}, now);
  assert.deepStrictEqual(
    { from: r.from, to: r.to, start: r.start, end: r.end, offset: r.offset },
    {
      from: '2026-10-14',
      to: '2026-10-14',
      start: '2026-10-13 18:30:00',
      end: '2026-10-14 18:30:00',
      offset: '+05:30',
    },
  );
  const week = parseRange({ from: '2026-10-01', to: '2026-10-07' }, now);
  assert.strictEqual(week.days, 7);
  assert.strictEqual(week.start, '2026-09-30 18:30:00');
  assert.strictEqual(week.end, '2026-10-07 18:30:00');
});

test('bad ranges are refused; other zones work', () => {
  assert.match(parseRange({ from: '2026-10-05', to: '2026-10-01' }).error, /on or before/);
  assert.match(parseRange({ from: '13-10-2026' }).error, /YYYY-MM-DD/);
  assert.match(parseRange({ from: '2025-01-01', to: '2026-10-01' }).error, /at most 366 days/);
  assert.strictEqual(offsetSql(-300), '-05:00');
  const ny = parseRange({ from: '2026-07-01' }, new Date(), 'America/New_York');
  assert.strictEqual(ny.start, '2026-07-01 04:00:00'); // summer time, UTC-4
});

test('agent figures: ready excludes talk, handle = talk + wrap, occupancy leaves out breaks', () => {
  const a = shapeAgent({
    agent: 'a1',
    login: 3600,
    available: 2400,
    wrap: 600,
    brk: 600,
    talk: 1200,
    outbound: 10,
    inbound: 2,
    connected: 8,
    outcomes: 8,
    successes: 2,
    callbacks: 1,
  });
  assert.strictEqual(a.ready_seconds, 1200);
  assert.strictEqual(a.avg_talk_seconds, 150);
  assert.strictEqual(a.avg_handle_seconds, 225);
  assert.strictEqual(a.occupancy, 60); // (1200 + 600) / (3600 - 600)
  assert.strictEqual(a.conversion, 25);
  const idle = shapeAgent({
    agent: 'b',
    login: 0,
    available: 0,
    wrap: 0,
    brk: 0,
    talk: 0,
    outbound: 0,
    inbound: 0,
    connected: 0,
    outcomes: 0,
    successes: 0,
    callbacks: 0,
  });
  assert.strictEqual(idle.occupancy, null);
  assert.strictEqual(idle.avg_talk_seconds, null);
});

test('campaign figures: contact % of calls, abandon % of answered, conversion % of talked-to', () => {
  const c = shapeCampaign({
    campaign: 'X',
    leads: 200,
    dialed: 50,
    calls: 80,
    answered: 40,
    connected: 30,
    abandoned: 2,
    machine: 5,
    talk: 3000,
    outcomes: 30,
    successes: 6,
  });
  assert.strictEqual(c.penetration, 25);
  assert.strictEqual(c.contact_rate, 50);
  assert.strictEqual(c.abandon_rate, 5);
  assert.strictEqual(c.avg_talk_seconds, 100);
  assert.strictEqual(c.conversion, 20);
});

test('a call is "Answered" only when someone talked to an agent', () => {
  assert.strictEqual(resultLabel({ agent_connect_time: new Date(), disposition: 'ended' }), 'Answered');
  assert.strictEqual(resultLabel({ agent_connect_time: null, disposition: 'ended', ended: 1 }), 'Not answered');
  assert.strictEqual(resultLabel({ disposition: 'abandoned' }), 'Dropped (no agent free)');
  assert.strictEqual(resultLabel({ disposition: null, ended: 0 }), 'In progress');
});

test('CSV: labels as header, totals last, Excel-safe (BOM, no formulas)', () => {
  const csv = toCsv({
    columns: [
      { key: 'name', label: 'Agent' },
      { key: 'n', label: 'Calls, total' },
    ],
    rows: [
      { name: '=HYPERLINK("x")', n: 3 },
      { name: 'a "b"', n: null },
    ],
    totals: { name: 'Total', n: 3 },
  });
  const expected = ['Agent,"Calls, total"', '"\'=HYPERLINK(""x"")",3', '"a ""b""",', 'Total,3', ''];
  assert.strictEqual(csv, BOM + expected.join('\r\n'));
});

test('the catalog lists the 10 reports with their filters', () => {
  const keys = catalog().map((r) => r.key);
  assert.deepStrictEqual(keys, [
    'cdr',
    'agents',
    'timesheet',
    'campaigns',
    'outcomes',
    'predictive',
    'inbound',
    'hourly',
    'lists',
    'callbacks',
  ]);
  assert.ok(catalog().every((r) => r.title && r.description && Array.isArray(r.filters) && !r.run));
});

// --- the route ---
const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = { user: { id: 1, username: 'boss', role: 'admin', loginAt: Date.now() } };
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
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      })
      .on('error', reject);
  });

test('GET /admin/reports/:key - unknown 404, bad range 400, CSV download', async () => {
  assert.strictEqual((await get('/admin/reports/nope')).status, 404);
  const bad = await get('/admin/reports/cdr?from=2026-10-05&to=2026-10-01');
  assert.strictEqual(bad.status, 400);
  const json = await get('/admin/reports/cdr?from=2026-10-01&to=2026-10-02&direction=inbound&agentId=4');
  assert.strictEqual(json.status, 200);
  const body = JSON.parse(json.text);
  assert.strictEqual(body.title, 'Call Detail (CDR)');
  assert.strictEqual(body.timezone, 'Asia/Kolkata');
  const [q, params] = sql.find(([s]) => s.startsWith('SELECT ca.id'));
  assert.match(q, /ca\.start_time >= \? AND ca\.start_time < \? AND ca\.agent_user_id = \? AND ca\.direction = \?/);
  assert.deepStrictEqual(params, ['2026-09-30 18:30:00', '2026-10-02 18:30:00', 4, 'inbound', 1000]);
  const csv = await get('/admin/reports/cdr?from=2026-10-01&format=csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-disposition'], /dialforge-cdr-2026-10-01\.csv/);
  assert.ok(csv.text.startsWith(`${BOM}Call,Start,Direction,Campaign,Agent`));
});
