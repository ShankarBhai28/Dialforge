#!/usr/bin/env node
// Load test: the agents' side in the app. Each bot logs in as one
// load-test agent (loadagent5001 ...), goes Available in the campaign's
// queue and then does what an agent's screen does: notices the call
// (GET /agent/active-call), and after it ends gives a disposition and goes
// Available again. The audio side of the same agents is SIPp
// (sipp/agents-answer.xml). Test servers only.
//
//   node agents.js --url https://<app private IP> --from 5001 --count 50 \
//     --password '<agents' login password>' --campaign '<campaign name>' [--wrap 5] [--ramp 5]
//
// --wrap: seconds of after-call work before the disposition (default 5).
// --ramp: agents logged in per second (default 5).
// --poll: seconds between checks per agent (default 3; real screens get
//         pushed updates, so keep this low-cost).
// Prints a line every 30 s; Ctrl+C logs every bot out (status break) and stops.
// The app's certificate is for its domain, not its private IP: this script
// doesn't check it (test servers only).
const https = require('https');

function args() {
  const a = {};
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  for (const k of ['url', 'count', 'password', 'campaign'])
    if (!a[k]) {
      console.error(`missing --${k}  (see the top of agents.js)`);
      process.exit(2);
    }
  return {
    url: a.url.replace(/\/$/, ''),
    from: Number(a.from || 5001),
    count: Number(a.count),
    password: a.password,
    campaign: a.campaign,
    wrapMs: Number(a.wrap || 5) * 1000,
    ramp: Number(a.ramp || 5),
    pollMs: Number(a.poll || 3) * 1000,
  };
}

const opt = args();
const agent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });
const stats = { loggedIn: 0, available: 0, onCall: 0, handled: 0, dispositions: 0, errors: 0, lastError: '' };

/** One HTTPS request with this bot's session cookie -> { status, body }. */
function request(bot, method, path, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      opt.url + path,
      {
        method,
        agent,
        timeout: 15000,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(bot.cookie ? { cookie: bot.cookie } : {}),
        },
      },
      (res) => {
        const set = res.headers['set-cookie'];
        if (set) bot.cookie = set.map((c) => c.split(';')[0]).join('; ');
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    if (data) req.write(data);
    req.end();
  });
}

function fail(bot, what, r) {
  stats.errors++;
  stats.lastError = `${bot.username} ${what}: ${r.status} ${(r.body && r.body.error) || ''}`.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function goAvailable(bot) {
  const r = await request(bot, 'POST', '/agent/status', { status: 'available', queueId: bot.queueId });
  if (r.status !== 200) return fail(bot, 'available', r);
  bot.available = true;
}

async function start(bot) {
  const login = await request(bot, 'POST', '/auth/login', { username: bot.username, password: opt.password });
  if (login.status !== 200) return fail(bot, 'login', login);
  stats.loggedIn++;
  const queues = await request(bot, 'GET', '/queues');
  const q = Array.isArray(queues.body) && queues.body.find((x) => x.campaign_name === opt.campaign);
  if (!q) return fail(bot, `no queue of campaign "${opt.campaign}" (is the agent in its team?)`, queues);
  bot.queueId = q.id;
  const dispo = await request(bot, 'GET', '/agent/dispositions');
  const plain = Array.isArray(dispo.body) && dispo.body.find((d) => !d.is_callback && !d.marks_dnc);
  bot.disposition = plain ? plain.code : 'interested';
  await goAvailable(bot);
  bot.running = true;
  // Spread the checks so 200 bots don't ask in the same second.
  await sleep(Math.random() * opt.pollMs);
  void loop(bot);
}

async function loop(bot) {
  while (bot.running) {
    const r = await request(bot, 'GET', '/agent/active-call');
    if (r.status !== 200) {
      fail(bot, 'active-call', r);
    } else if (r.body && r.body.call_id) {
      bot.callId = r.body.call_id;
    } else if (bot.callId) {
      // The call ended: after-call work, the outcome, back to Available.
      const callId = bot.callId;
      bot.callId = null;
      stats.handled++;
      await sleep(opt.wrapMs);
      const d = await request(bot, 'POST', `/agent/calls/${callId}/disposition`, { status: bot.disposition });
      if (d.status === 200) stats.dispositions++;
      else fail(bot, 'disposition', d);
      await goAvailable(bot);
    }
    await sleep(opt.pollMs);
  }
}

const bots = Array.from({ length: opt.count }, (_, i) => ({
  username: `loadagent${opt.from + i}`,
  cookie: null,
  running: false,
  callId: null,
}));

function report() {
  stats.onCall = bots.filter((b) => b.callId).length;
  stats.available = bots.filter((b) => b.running && !b.callId).length;
  const t = new Date().toTimeString().slice(0, 8);
  console.log(
    `${t} logged in ${stats.loggedIn}/${opt.count}  on call ${stats.onCall}  free ${stats.available}  ` +
      `calls handled ${stats.handled}  dispositions ${stats.dispositions}  errors ${stats.errors}` +
      (stats.lastError ? `  (last: ${stats.lastError})` : ''),
  );
}

async function stop() {
  console.log('stopping: every bot goes on break');
  for (const b of bots) b.running = false;
  await Promise.all(
    bots
      .filter((b) => b.cookie)
      .map((b) => request(b, 'POST', '/agent/status', { status: 'break', reason: 'load test end' })),
  );
  report();
  process.exit(0);
}

(async () => {
  console.log(`${opt.count} agents (loadagent${opt.from}...), campaign "${opt.campaign}", ${opt.ramp} logins/s`);
  setInterval(report, 30000);
  process.on('SIGINT', () => void stop());
  for (let i = 0; i < bots.length; i += opt.ramp) {
    await Promise.all(bots.slice(i, i + opt.ramp).map(start));
    await sleep(1000);
  }
  report();
})();
