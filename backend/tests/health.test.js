// System health checks and when they alert - against fakes.
const assert = require('node:assert');
const { test } = require('node:test');
const {
  collectHealth,
  changes,
  dailyDue,
  dailySummary,
  reminders,
  sendAlert,
  whoAmI,
} = require('../src/services/health');

const NOW = Date.parse('2026-10-13T10:00:00Z');
function deps(over = {}) {
  return {
    pool: { query: async (sql) => (/dialer_status/.test(sql) ? [[{ age: 3 }]] : [[{ 1: 1 }]]) },
    ari: { endpointStates: async () => ({ 1001: 'online' }), endpointState: async () => 'online' },
    ami: { isReady: () => true },
    systemctlActive: async () => 'active',
    systemctlInstalled: async () => true,
    statfs: async () => ({ bavail: 50, blocks: 100, bsize: 1e9 }),
    readBackupStatus: () => ({ at: '2026-10-12T21:05:00Z', status: 'ok', offsite: 'ok' }),
    memoryAvailablePct: () => 60,
    now: () => NOW,
    services: ['asterisk', 'dialforge-dialer'],
    certValidTo: () => new Date(NOW + 60 * 86400000),
    licence: () => ({ state: 'ok', customer: 'Acme', expires: '2027-03-31', daysLeft: 169 }),
    phonePortOpen: async () => true,
    stuckRecordings: async () => 0,
    ...over,
  };
}
const byKey = (h) => Object.fromEntries(h.checks.map((c) => [c.key, c]));

test('all good -> every check ok', async () => {
  const h = await collectHealth(deps());
  assert.strictEqual(h.overall, 'ok');
  assert.ok(
    h.checks.every((c) => c.status === 'ok'),
    JSON.stringify(h.checks),
  );
  assert.match(byKey(h).disk.detail, /50.0 GB free \(50%\)/);
});

test('problems are named: Asterisk down, AMI gone, dialer silent, a stopped service, disk almost full', async () => {
  const h = byKey(
    await collectHealth(
      deps({
        ari: { endpointStates: async () => null, endpointState: async () => null },
        ami: { isReady: () => false },
        pool: { query: async (sql) => (/dialer_status/.test(sql) ? [[{ age: 400 }]] : [[{ 1: 1 }]]) },
        systemctlActive: async (u) => (u === 'asterisk' ? 'failed' : 'active'),
        statfs: async () => ({ bavail: 4, blocks: 100, bsize: 1e9 }),
      }),
    ),
  );
  assert.strictEqual(h.asterisk.status, 'fail');
  assert.strictEqual(h.ami.status, 'fail');
  assert.strictEqual(h.trunk.status, 'warn');
  assert.match(h.dialer.detail, /no tick for 400s/);
  assert.strictEqual(h['svc:asterisk'].status, 'fail');
  assert.strictEqual(h.disk.status, 'fail');
});

test('a service not installed on this server is skipped; installed but stopped still fails', async () => {
  const h = byKey(
    await collectHealth(
      deps({
        services: ['coturn', 'coturn-443'],
        systemctlInstalled: async (u) => u !== 'coturn-443',
        systemctlActive: async () => 'inactive',
      }),
    ),
  );
  assert.strictEqual(h['svc:coturn-443'], undefined);
  assert.strictEqual(h['svc:coturn'].status, 'fail');
});

test('backups: missing, failed, old, or only on this server are all flagged', async () => {
  const backup = async (b) => byKey(await collectHealth(deps({ readBackupStatus: () => b }))).backup;
  assert.match((await backup(null)).detail, /none yet/);
  assert.strictEqual(
    (await backup({ at: '2026-10-12T21:05:00Z', status: 'failed', errors: 'database dump failed' })).status,
    'fail',
  );
  assert.match((await backup({ at: '2026-10-10T21:05:00Z', status: 'ok', offsite: 'ok' })).detail, /hours ago/);
  assert.match((await backup({ at: '2026-10-12T21:05:00Z', status: 'ok', offsite: 'off' })).detail, /BACKUP_S3_BUCKET/);
  assert.strictEqual(
    (
      await collectHealth(
        deps({
          readBackupStatus: () => {
            throw new Error('no file');
          },
        }),
      )
    ).overall,
    'warn',
  );
});

test('alerts: first run only failures; afterwards any change, including recovery', () => {
  const run = (statuses) => ({ checks: Object.entries(statuses).map(([key, status]) => ({ key, status })) });
  const first = run({ db: 'ok', disk: 'warn', asterisk: 'fail' });
  assert.deepStrictEqual(
    changes(null, first).map((c) => c.key),
    ['asterisk'],
  );
  const second = run({ db: 'ok', disk: 'warn', asterisk: 'ok' });
  assert.deepStrictEqual(
    changes(first, second).map((c) => `${c.key}:${c.status}`),
    ['asterisk:ok'],
  );
  assert.deepStrictEqual(changes(second, second), []);
});

test('certificate, phone port, licence and recordings: each warns or fails with what to do', async () => {
  const h = byKey(
    await collectHealth(
      deps({
        certValidTo: () => new Date(NOW + 5 * 86400000),
        phonePortOpen: async () => false,
        licence: () => ({ state: 'expiring', expires: '2026-10-20', daysLeft: 7 }),
        stuckRecordings: async () => 3,
      }),
    ),
  );
  assert.strictEqual(h.cert.status, 'warn');
  assert.match(h.cert.detail, /expires in 5 days - renewal hasn't worked: sudo certbot renew/);
  assert.strictEqual(h.phones.status, 'fail');
  assert.strictEqual(h.licence.status, 'warn');
  assert.match(h.licence.detail, /ends 2026-10-20 \(7 days left\)/);
  assert.match(h.recordings.detail, /3 not converted to MP3/);
  const gone = byKey(
    await collectHealth(
      deps({ certValidTo: () => new Date(NOW - 1000), licence: () => ({ state: 'expired', expires: '2026-10-01' }) }),
    ),
  );
  assert.strictEqual(gone.cert.status, 'fail');
  assert.strictEqual(gone.licence.status, 'fail');
  // No licence file (dev): no licence line at all.
  assert.strictEqual(byKey(await collectHealth(deps({ licence: () => ({ state: 'none' }) }))).licence, undefined);
});

test('Telegram and webhook both get the alert; a refused one is reported, the token never printed', async () => {
  const sent = [];
  const fakeFetch = async (url, opts) => {
    sent.push([url, JSON.parse(opts.body)]);
    if (url.includes('telegram'))
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) };
    return { ok: true, status: 200, json: async () => null };
  };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = await sendAlert(
      'Acme: FAIL Database',
      { TELEGRAM_BOT_TOKEN: '123:SECRET', TELEGRAM_CHAT_ID: '55', ALERT_WEBHOOK_URL: 'https://hooks.example/x' },
      fakeFetch,
    );
    assert.deepStrictEqual(r, [
      { channel: 'telegram', ok: false, error: 'Bad Request: chat not found' },
      { channel: 'webhook', ok: true },
    ]);
  } finally {
    console.error = orig;
  }
  assert.strictEqual(sent[0][0], 'https://api.telegram.org/bot123:SECRET/sendMessage');
  assert.deepStrictEqual(sent[0][1], { chat_id: '55', text: 'Acme: FAIL Database', disable_web_page_preview: true });
  assert.deepStrictEqual(sent[1][1], { text: 'Acme: FAIL Database' });
  assert.ok(!errors.join('\n').includes('SECRET'), 'the bot token is not logged');
  assert.deepStrictEqual(await sendAlert('x', {}, fakeFetch), [], 'nothing set up: nothing sent');
});

test('every alert says whose server: licence customer and domain', () => {
  assert.strictEqual(
    whoAmI({ SIP_DOMAIN: 'crm.acme.in', APP_DISPLAY_NAME: 'VIZTEX' }, () => ({ customer: 'Acme' })),
    'Acme (crm.acme.in)',
  );
  assert.strictEqual(
    whoAmI({ SIP_DOMAIN: 'dev.x' }, () => ({ customer: null })),
    'VIZTEX (dev.x)',
  );
});

test('still bad after 2 hours -> a reminder, then again 2 hours later; recovered ones are not reminded', () => {
  const alertedAt = new Map([
    ['trunk', 0],
    ['disk', 0],
  ]);
  const h = {
    checks: [
      { key: 'trunk', status: 'warn' },
      { key: 'disk', status: 'ok' },
    ],
  };
  assert.deepStrictEqual(reminders(h, alertedAt, 3600000), [], 'one hour: not yet');
  assert.deepStrictEqual(
    reminders(h, alertedAt, 2 * 3600000).map((c) => c.key),
    ['trunk'],
  );
  assert.deepStrictEqual(reminders(h, alertedAt, 3 * 3600000), [], 'reminded just now');
  assert.deepStrictEqual(
    reminders(h, alertedAt, 4 * 3600000).map((c) => c.key),
    ['trunk'],
  );
});

test('daily summary: once per local day from the hour on; says all OK or lists what needs attention', () => {
  // 03:00 UTC = 08:30 India: too early; 04:00 UTC = 09:30 India: due.
  assert.strictEqual(dailyDue(Date.parse('2026-10-21T03:00:00Z'), '2026-10-20', 9), null);
  assert.strictEqual(dailyDue(Date.parse('2026-10-21T04:00:00Z'), '2026-10-20', 9), '2026-10-21');
  assert.strictEqual(dailyDue(Date.parse('2026-10-21T10:00:00Z'), '2026-10-21', 9), null, 'already sent today');
  assert.strictEqual(dailyDue(Date.parse('2026-10-21T04:00:00Z'), '', 9), '2026-10-21', 'never sent before');
  assert.strictEqual(dailySummary({ checks: [{ status: 'ok' }, { status: 'ok' }] }), 'Daily check: all 2 checks OK');
  assert.strictEqual(
    dailySummary({ checks: [{ status: 'ok' }, { status: 'warn', label: 'Disk', detail: '9 GB free (12%)' }] }),
    'Daily check: 1 need attention\nWARN: Disk - 9 GB free (12%)',
  );
});
