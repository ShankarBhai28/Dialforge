// System health checks and when they alert - against fakes.
const assert = require('node:assert');
const { test } = require('node:test');
const { collectHealth, changes } = require('../src/services/health');

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
