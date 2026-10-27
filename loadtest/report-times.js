#!/usr/bin/env node
// Load test: how long the admin's heavy screens take - every report for
// today / 7 / 30 / 90 days, the CDR export, the dashboard, Live Agents, the
// Call Log and the leads list - as an admin in the browser would ask for
// them. Run it on a server with a lot of data (bigdata.js), alone and again
// while the agents' load runs, and compare.
//
//   node report-times.js --url https://<app private IP> --user boss --password '<password>' \
//     [--parallel 1] [--out report-times.csv]
//
// --parallel N: N admins asking at the same time (each request is then made
// N times at once; the time shown is the slowest of them).
// Prints one line per request (seconds, rows, HTTP status) and writes them to
// --out. Over ~5 s is what an admin notices; over 30 s the browser may give up.
const https = require('https');
const fs = require('fs');

function args() {
  const a = {};
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  for (const k of ['url', 'user', 'password'])
    if (!a[k]) {
      console.error(`missing --${k}  (see the top of report-times.js)`);
      process.exit(2);
    }
  return {
    url: a.url.replace(/\/$/, ''),
    user: a.user,
    password: a.password,
    parallel: Math.max(Number(a.parallel || 1), 1),
    out: a.out || `report-times-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`,
  };
}

const opt = args();
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
let cookie = '';

/** One request -> { status, ms, bytes, body }. */
function request(method, path, body) {
  const started = Date.now();
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      opt.url + path,
      {
        method,
        agent,
        timeout: 300000,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        const set = res.headers['set-cookie'];
        if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, ms: Date.now() - started, bytes: text.length, body: json, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout (300 s)')));
    req.on('error', (err) => resolve({ status: 0, ms: Date.now() - started, bytes: 0, body: { error: err.message } }));
    if (data) req.write(data);
    req.end();
  });
}

/** Local (India) date n days ago, YYYY-MM-DD. */
const daysAgo = (n) => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);

/** How many rows came back (reports: rows; pages: items; CSV: lines). */
function rowsOf(r) {
  if (!r.body) return r.text ? r.text.split('\n').length - 2 : '';
  if (Array.isArray(r.body.rows)) return r.body.meta?.total ?? r.body.total ?? r.body.rows.length;
  if (Array.isArray(r.body)) return r.body.length;
  return '';
}

(async () => {
  const login = await request('POST', '/auth/login', { username: opt.user, password: opt.password });
  if (login.status !== 200) {
    console.error(`login failed: HTTP ${login.status} ${JSON.stringify(login.body)}`);
    process.exit(1);
  }
  const ranges = [
    ['today', daysAgo(0), daysAgo(0)],
    ['7 days', daysAgo(6), daysAgo(0)],
    ['30 days', daysAgo(29), daysAgo(0)],
    ['90 days', daysAgo(89), daysAgo(0)],
  ];
  const list = [
    ['Dashboard', '/admin/dashboard'],
    ['Live Agents', '/admin/live-agents'],
    ['Live Agents summary', '/admin/live-agents/summary'],
    ['Call Log (page 1)', '/admin/calls'],
    ['Call Log, 30 days', `/admin/calls?from=${daysAgo(29)}&to=${daysAgo(0)}`],
    ['Leads (page 1)', '/admin/leads'],
    ['Reports list', '/admin/reports'],
    ['List Penetration', '/admin/reports/lists'],
  ];
  const reports = [
    ['CDR', 'cdr'],
    ['Agent Performance', 'agents'],
    ['Agent Time Sheet', 'timesheet'],
    ['Campaign Performance', 'campaigns'],
    ['Outcomes', 'outcomes'],
    ['Outcomes per agent', 'outcomes', '&groupBy=agent'],
    ['Predictive', 'predictive'],
    ['Predictive per hour', 'predictive', '&groupBy=hour'],
    ['Inbound', 'inbound'],
    ['Hourly', 'hourly'],
    ['Callbacks', 'callbacks'],
  ];
  for (const [label, from, to] of ranges)
    for (const [name, key, extra = ''] of reports)
      list.push([`${name} - ${label}`, `/admin/reports/${key}?from=${from}&to=${to}${extra}`]);
  list.push(['CDR export CSV - 30 days', `/admin/reports/cdr?from=${daysAgo(29)}&to=${daysAgo(0)}&format=csv`]);

  const lines = ['what,seconds,rows,http,bytes'];
  console.log(`${opt.parallel} admin(s) at once - ${list.length} requests\n`);
  console.log(`${'what'.padEnd(42)} ${'seconds'.padStart(8)} ${'rows'.padStart(9)}  http`);
  for (const [label, path] of list) {
    const all = await Promise.all(Array.from({ length: opt.parallel }, () => request('GET', path)));
    const worst = all.reduce((a, b) => (b.ms > a.ms ? b : a));
    const bad = all.find((r) => r.status !== 200) || worst;
    const secs = (worst.ms / 1000).toFixed(2);
    const flag = worst.ms > 30000 ? '  << too slow' : worst.ms > 5000 ? '  < slow' : '';
    console.log(`${label.padEnd(42)} ${secs.padStart(8)} ${String(rowsOf(worst)).padStart(9)}  ${bad.status}${flag}`);
    if (bad.status !== 200) console.log(`   ${JSON.stringify(bad.body).slice(0, 200)}`);
    lines.push(`"${label}",${secs},${rowsOf(worst)},${bad.status},${worst.bytes}`);
  }
  fs.writeFileSync(opt.out, `${lines.join('\n')}\n`);
  console.log(`\nwritten to ${opt.out}`);
})();
