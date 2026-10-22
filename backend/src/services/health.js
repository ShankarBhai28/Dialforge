// System health: is everything a working contact centre needs actually
// working? Checked every minute by the backend (startHealthWatch); a check
// that turns bad - or recovers - sends an alert and is written to the audit
// log; one still bad is reminded every 2 hours, and a daily summary goes out
// at ALERT_DAILY_HOUR (local time, default 9). Alerts go to Telegram
// (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) and/or ALERT_WEBHOOK_URL (any
// Slack-style webhook: Slack, Google Chat, Teams, Discord). Super Admins see
// the same checks on the Dashboard.
//
// Each check: { key, label, status: 'ok' | 'warn' | 'fail', detail }.
// This can't report the backend itself being down - for that, point an
// external uptime monitor at https://<host>/health (see ops/README.md).
const fs = require('fs');
const os = require('os');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const pool = require('../../db');
const ari = require('../../ari');
const ami = require('../../ami');
const hub = require('../realtime/hub');
const { audit } = require('./audit');
const { TRUNK_ENDPOINT } = require('../config');
const { getLicence } = require('./licence');
const { localToday, offsetMinutes } = require('./reports/time');

const BACKUP_STATUS = process.env.BACKUP_STATUS_FILE || path.join(os.homedir(), 'backups', 'nightly', 'last.json');
// coturn-443 (TURN on 443 for strict office firewalls) exists only where it
// was set up by hand: a service that isn't installed is skipped, not a fail.
const SERVICES = ['asterisk', 'dialforge-dialer', 'coturn', 'coturn-443'];

const ok = (key, label, detail) => ({ key, label, status: 'ok', detail });
const warn = (key, label, detail) => ({ key, label, status: 'warn', detail });
const fail = (key, label, detail) => ({ key, label, status: 'fail', detail });

function systemctlActive(unit) {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', unit], { timeout: 3000 }, (err, stdout) =>
      resolve(String(stdout).trim() || 'unknown'),
    );
  });
}

/** False only when systemd has no such unit at all (not merely stopped). */
function systemctlInstalled(unit) {
  return new Promise((resolve) => {
    execFile('systemctl', ['show', '-p', 'LoadState', '--value', unit], { timeout: 3000 }, (err, stdout) =>
      resolve(String(stdout).trim() !== 'not-found'),
    );
  });
}

/** % of memory available (MemAvailable counts reclaimable cache, unlike os.freemem). */
function memoryAvailablePct() {
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return (Number(m[1]) * 1024 * 100) / os.totalmem();
  } catch {
    /* not Linux */
  }
  return (os.freemem() * 100) / os.totalmem();
}

const CERT_FILE = path.join(__dirname, '..', '..', 'certs', 'fullchain.pem');
const RECORDINGS = process.env.RECORDINGS_DIR || '/var/spool/asterisk/monitor/dialforge';
const CERT_WARN_DAYS = 14;
const REMIND_MS = 2 * 3600 * 1000;

/** When the app's certificate (the same one Asterisk uses for the agents' phones) runs out. */
function certValidTo() {
  return new Date(new X509Certificate(fs.readFileSync(CERT_FILE)).validTo);
}

/**
 * Does Asterisk answer on the agents' phone port (secure WebSocket, 8089)?
 * On this server, or on the telephony server (ARI_HOST) when they are split.
 */
function phonePortOpen(
  port = 8089,
  host = /^(localhost|127\.)/.test(process.env.ARI_HOST || 'localhost') ? '127.0.0.1' : process.env.ARI_HOST,
) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, timeout: 3000 }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Recordings left as WAV more than 30 minutes after they were last written:
 * the MP3 conversion failed (ffmpeg missing, disk full). Today's and
 * yesterday's folders only (YYYY/MM/DD).
 */
async function stuckRecordings(now = Date.now()) {
  let n = 0;
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86400000);
    const dir = path.join(
      RECORDINGS,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.wav')) continue;
      const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (st && now - st.mtimeMs > 30 * 60000) n++;
    }
  }
  return n;
}

const defaultDeps = {
  pool,
  ari,
  ami,
  systemctlActive,
  systemctlInstalled,
  statfs: (p) => fs.promises.statfs(p),
  readBackupStatus: () => JSON.parse(fs.readFileSync(BACKUP_STATUS, 'utf8')),
  memoryAvailablePct,
  now: () => Date.now(),
  services: SERVICES,
  certValidTo,
  licence: () => getLicence(),
  phonePortOpen,
  stuckRecordings,
  // Recordings are made where Asterisk runs; no recordings folder here = an app server of split servers.
  recordingsElsewhere: !fs.existsSync(RECORDINGS),
};

async function collectHealth(deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const checks = [];

  try {
    await d.pool.query('SELECT 1');
    checks.push(ok('db', 'Database', 'connected'));
  } catch (err) {
    checks.push(fail('db', 'Database', err.message));
  }

  checks.push(
    (await d.ari.ping())
      ? ok('asterisk', 'Asterisk (ARI)', 'answering')
      : fail('asterisk', 'Asterisk (ARI)', 'not answering'),
  );
  checks.push(
    d.ami.isReady()
      ? ok('ami', 'Asterisk control (AMI)', 'connected')
      : fail('ami', 'Asterisk control (AMI)', 'not connected'),
  );

  const trunk = await d.ari.endpointState(`PJSIP/${TRUNK_ENDPOINT}`);
  checks.push(
    trunk === 'online'
      ? ok('trunk', 'SIP trunk', `${TRUNK_ENDPOINT} reachable`)
      : warn(
          'trunk',
          'SIP trunk',
          `${TRUNK_ENDPOINT} ${trunk === null ? 'unknown' : 'unreachable'} - outside calls may fail`,
        ),
  );

  try {
    const [[hb]] = await d.pool.query(
      'SELECT TIMESTAMPDIFF(SECOND, last_tick_at, NOW()) AS age FROM dialer_status WHERE campaign_id = 0',
    );
    checks.push(
      hb && hb.age <= 30
        ? ok('dialer', 'Dialer engine', `last tick ${hb.age}s ago`)
        : fail('dialer', 'Dialer engine', hb ? `no tick for ${hb.age}s` : 'never ran'),
    );
  } catch (err) {
    checks.push(fail('dialer', 'Dialer engine', err.message));
  }

  for (const unit of d.services) {
    if (!(await d.systemctlInstalled(unit))) continue;
    const s = await d.systemctlActive(unit);
    checks.push(
      s === 'active' ? ok(`svc:${unit}`, `Service ${unit}`, 'running') : fail(`svc:${unit}`, `Service ${unit}`, s),
    );
  }

  try {
    const st = await d.statfs('/');
    const freePct = (st.bavail / st.blocks) * 100;
    const freeGb = (st.bavail * st.bsize) / 1e9;
    const detail = `${freeGb.toFixed(1)} GB free (${freePct.toFixed(0)}%)`;
    checks.push(
      freePct < 5
        ? fail('disk', 'Disk', detail)
        : freePct < 15
          ? warn('disk', 'Disk', detail)
          : ok('disk', 'Disk', detail),
    );
  } catch (err) {
    checks.push(warn('disk', 'Disk', err.message));
  }

  const mem = d.memoryAvailablePct();
  const memDetail = `${mem.toFixed(0)}% available`;
  checks.push(
    mem < 5
      ? fail('memory', 'Memory', memDetail)
      : mem < 10
        ? warn('memory', 'Memory', memDetail)
        : ok('memory', 'Memory', memDetail),
  );

  let backup;
  try {
    backup = d.readBackupStatus();
  } catch {
    backup = null;
  }
  if (!backup) checks.push(warn('backup', 'Nightly backup', 'none yet'));
  else {
    const ageH = (d.now() - Date.parse(backup.at)) / 3600000;
    if (backup.status !== 'ok') checks.push(fail('backup', 'Nightly backup', `failed: ${backup.errors || 'see logs'}`));
    else if (ageH > 36) checks.push(warn('backup', 'Nightly backup', `last one ${Math.round(ageH)} hours ago`));
    else if (backup.offsite !== 'ok')
      checks.push(
        warn('backup', 'Nightly backup', 'only on this server - set BACKUP_S3_BUCKET for an off-server copy'),
      );
    else checks.push(ok('backup', 'Nightly backup', `${Math.round(ageH)}h ago, copied off-server`));
  }

  try {
    const left = Math.floor((d.certValidTo().getTime() - d.now()) / 86400000);
    const detail = left < 0 ? 'expired' : `expires in ${left} day${left === 1 ? '' : 's'}`;
    checks.push(
      left < 0
        ? fail('cert', 'Certificate (https)', `${detail} - the app and agents' phones stop working`)
        : left < CERT_WARN_DAYS
          ? warn('cert', 'Certificate (https)', `${detail} - renewal hasn't worked: sudo certbot renew`)
          : ok('cert', 'Certificate (https)', detail),
    );
  } catch (err) {
    checks.push(warn('cert', 'Certificate (https)', `can't read it: ${err.message}`));
  }

  checks.push(
    (await d.phonePortOpen())
      ? ok('phones', "Agents' phone port (8089)", 'answering')
      : fail('phones', "Agents' phone port (8089)", "not answering - agents' browser phones can't connect"),
  );

  const lic = d.licence();
  if (lic.state === 'invalid') checks.push(fail('licence', 'Licence', `unreadable: ${lic.error}`));
  else if (lic.state === 'expired')
    checks.push(fail('licence', 'Licence', `ended ${lic.expires} - agents can't log in`));
  else if (lic.state === 'expiring')
    checks.push(
      warn('licence', 'Licence', `ends ${lic.expires} (${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'} left)`),
    );
  else if (lic.state === 'ok')
    checks.push(ok('licence', 'Licence', lic.expires ? `until ${lic.expires}` : 'no end date'));

  // Recordings are made where Asterisk runs; an app server of split servers has none to look at.
  if (!d.recordingsElsewhere) {
    const stuck = await d.stuckRecordings(d.now());
    checks.push(
      stuck
        ? warn('recordings', 'Call recordings', `${stuck} not converted to MP3 - check ffmpeg and disk`)
        : ok('recordings', 'Call recordings', 'converting'),
    );
  }

  const overall = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { at: new Date(d.now()).toISOString(), overall, checks };
}

/** Changes worth telling someone about, between two runs (first run: only failures). */
function changes(prev, next) {
  const before = new Map((prev?.checks ?? []).map((c) => [c.key, c.status]));
  return next.checks.filter((c) => (prev ? (before.get(c.key) ?? 'ok') !== c.status : c.status === 'fail'));
}

/**
 * Sends one alert to every channel that is set up. Returns what happened per
 * channel ({ channel, ok, error }) - never throws. The bot token is never logged.
 */
async function sendAlert(text, env = process.env, doFetch = fetch) {
  const out = [];
  async function post(channel, url, body) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && data.ok === false)) throw new Error((data && data.description) || `HTTP ${res.status}`);
      out.push({ channel, ok: true });
    } catch (err) {
      out.push({ channel, ok: false, error: err.message });
      console.error(`[alert ${channel}]`, err.message);
    }
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    await post('telegram', `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    });
  if (env.ALERT_WEBHOOK_URL) await post('webhook', env.ALERT_WEBHOOK_URL, { text });
  return out;
}

/** "Practice (viztexpractice.duckdns.org)": whose server this is, on every alert. */
function whoAmI(env = process.env, licence = () => getLicence()) {
  let name = null;
  try {
    name = licence().customer;
  } catch {
    /* no licence */
  }
  return `${name || env.APP_DISPLAY_NAME || 'VIZTEX'} (${env.APP_DOMAIN || env.SIP_DOMAIN || os.hostname()})`;
}

const line = (c, prefix) =>
  `${prefix || (c.status === 'ok' ? 'RESOLVED' : c.status.toUpperCase())}: ${c.label} - ${c.detail}`;

/**
 * Checks still bad whose last alert is over 2 hours old (remembered in
 * alertedAt: key -> time). Updates alertedAt for what it returns.
 */
function reminders(next, alertedAt, now) {
  const due = next.checks.filter(
    (c) => c.status !== 'ok' && alertedAt.has(c.key) && now - alertedAt.get(c.key) >= REMIND_MS,
  );
  for (const c of due) alertedAt.set(c.key, now);
  return due;
}

/** The daily summary is due once per local day, from ALERT_DAILY_HOUR on. */
function dailyDue(now, lastDay, hour = Number(process.env.ALERT_DAILY_HOUR ?? 9)) {
  const d = new Date(now);
  const today = localToday(d);
  const localHour = new Date(now + offsetMinutes(d) * 60000).getUTCHours();
  return today !== lastDay && localHour >= hour ? today : null;
}

function dailySummary(h) {
  const bad = h.checks.filter((c) => c.status !== 'ok');
  return bad.length
    ? `Daily check: ${bad.length} need attention\n${bad.map((c) => line(c)).join('\n')}`
    : `Daily check: all ${h.checks.length} checks OK`;
}

let last = null;
const alertedAt = new Map();
let summaryDay = null;

async function runOnce(deps, now = Date.now()) {
  const next = await collectHealth(deps);
  const changed = changes(last, next);
  last = next;
  for (const c of changed) {
    if (c.status === 'ok') alertedAt.delete(c.key);
    else alertedAt.set(c.key, now);
  }
  const still = reminders(next, alertedAt, now).filter((c) => !changed.includes(c));
  const lines = [...changed.map((c) => line(c)), ...still.map((c) => line(c, 'STILL ' + c.status.toUpperCase()))];
  if (lines.length) await sendAlert(`${whoAmI()}:\n${lines.join('\n')}`);
  // Daily summary - once per local day; the audit log remembers it across restarts.
  const db = (deps && deps.pool) || pool;
  if (summaryDay === null) {
    const [[row]] = await db
      .query("SELECT MAX(at) AS at FROM audit_log WHERE action = 'system.daily'")
      .catch(() => [[null]]);
    summaryDay = row && row.at ? localToday(new Date(row.at)) : '';
  }
  const due = dailyDue(now, summaryDay);
  if (due) {
    summaryDay = due;
    await sendAlert(`${whoAmI()}:\n${dailySummary(next)}`);
    await audit({ action: 'system.daily', entity: 'system', summary: dailySummary(next).split('\n')[0] });
  }
  if (changed.length) {
    for (const c of changed) {
      await audit({
        action: 'system.health',
        entity: 'system',
        entityId: c.key,
        summary: `${c.status}: ${c.label} - ${c.detail}`.slice(0, 255),
      });
    }
    hub.publish('system.health', next);
  }
  return next;
}

function startHealthWatch(intervalMs = 60000) {
  // First run a little after start, once AMI / ARI have connected.
  setTimeout(() => runOnce().catch((err) => console.error('[health]', err.message)), 15000).unref();
  const t = setInterval(() => runOnce().catch((err) => console.error('[health]', err.message)), intervalMs);
  t.unref();
}

module.exports = {
  collectHealth,
  changes,
  dailyDue,
  dailySummary,
  reminders,
  sendAlert,
  runOnce,
  startHealthWatch,
  whoAmI,
  latest: () => last,
};
