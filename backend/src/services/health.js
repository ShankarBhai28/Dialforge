// System health: is everything a working contact centre needs actually
// working? Checked every minute by the backend (startHealthWatch); a check
// that turns bad - or recovers - sends an alert (ALERT_WEBHOOK_URL, any
// Slack-style webhook: Slack, Google Chat, Teams, Discord) and is written to
// the audit log. Super Admins see the same checks on the Dashboard.
//
// Each check: { key, label, status: 'ok' | 'warn' | 'fail', detail }.
// This can't report the backend itself being down - for that, point an
// external uptime monitor at https://<host>:3000/health (see ops/README.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pool = require('../../db');
const ari = require('../../ari');
const ami = require('../../ami');
const hub = require('../realtime/hub');
const { audit } = require('./audit');
const { TRUNK_ENDPOINT } = require('../config');

const BACKUP_STATUS = process.env.BACKUP_STATUS_FILE || path.join(os.homedir(), 'backups', 'nightly', 'last.json');
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

const defaultDeps = {
  pool,
  ari,
  ami,
  systemctlActive,
  statfs: (p) => fs.promises.statfs(p),
  readBackupStatus: () => JSON.parse(fs.readFileSync(BACKUP_STATUS, 'utf8')),
  memoryAvailablePct,
  now: () => Date.now(),
  services: SERVICES,
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

  const states = await d.ari.endpointStates();
  checks.push(
    states ? ok('asterisk', 'Asterisk (ARI)', 'answering') : fail('asterisk', 'Asterisk (ARI)', 'not answering'),
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

async function sendAlert(text, url = process.env.ALERT_WEBHOOK_URL) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[alert webhook]', err.message);
  }
}

let last = null;

async function runOnce(deps) {
  const next = await collectHealth(deps);
  const changed = changes(last, next);
  last = next;
  if (changed.length) {
    const host = os.hostname();
    const lines = changed.map(
      (c) => `${c.status === 'ok' ? 'RESOLVED' : c.status.toUpperCase()}: ${c.label} - ${c.detail}`,
    );
    await sendAlert(`${process.env.APP_DISPLAY_NAME || 'VIZTEX'} (${host}):\n${lines.join('\n')}`);
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

module.exports = { collectHealth, changes, sendAlert, runOnce, startHealthWatch, latest: () => last };
