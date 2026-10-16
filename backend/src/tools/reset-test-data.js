// Clears a TEST server's activity so features can be tried from scratch,
// keeping its setup. Never on a client's server.
//   cd ~/dialforge-backend && npm run db:reset-test-data -- --yes
//
// Cleared: leads, lists (incl. deleted ones) and their upload history, calls + call events, dialer
// attempts / hopper / status, callbacks, form answers, recycle log, agent
// status history, live_agents, audit log, login sessions; the recordings on
// this server (S3 copies are kept).
// Kept: users, roles, teams, extensions, queues, campaigns (+ outcomes,
// recycle rules), forms, DIDs, the DNC list, migrations.
//
// Refuses when: APP_ENV=production in .env, --yes is missing, or a call is
// open / an agent is logged in (add --force to ignore those two).
// First writes a full database backup to ~/backups/pre-reset-<time>.sql
// and archives the recordings next to it. Then restart the services
// (in-memory call state): sudo systemctl restart dialforge-backend dialforge-dialer
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Order doesn't matter (foreign key checks are off for the run), but this is
// children first, as it would have to be with them on.
const CLEAR = [
  'call_events',
  'form_responses',
  'callbacks',
  'dial_hopper',
  'dial_attempts',
  'calls',
  'recycle_log',
  'list_imports',
  'leads',
  'lists',
  'dialer_status',
  'agent_status_log',
  'live_agents',
  'agent_extra_queues',
  'audit_log',
  'sessions',
];
const RECORDINGS = '/var/spool/asterisk/monitor/dialforge';

/** Why it must not run, or null. */
async function refusal({ env, args, db }) {
  if ((env.APP_ENV || '').toLowerCase() === 'production') {
    return 'APP_ENV=production - this is a real server, its data is never reset';
  }
  if (!args.includes('--yes')) return 'add --yes to confirm (this deletes the test data listed in the file header)';
  if (!args.includes('--force')) {
    const [[calls]] = await db.query(
      'SELECT COUNT(*) AS n FROM calls WHERE end_time IS NULL AND start_time > NOW() - INTERVAL 3 HOUR',
    );
    if (Number(calls.n)) return `${calls.n} call(s) open - wait for them to end (or --force)`;
    const [[agents]] = await db.query('SELECT COUNT(*) AS n FROM agent_status_log WHERE ended_at IS NULL');
    if (Number(agents.n)) return `${agents.n} agent(s) logged in - ask them to log out (or --force)`;
  }
  return null;
}

/** Deletes the rows (one transaction), then starts the ids from 1 again. Returns { table: rowsDeleted }. */
async function clearTables(db) {
  const conn = await db.getConnection();
  const counts = {};
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();
    for (const t of CLEAR) {
      const [r] = await conn.query(`DELETE FROM \`${t}\``);
      counts[t] = r.affectedRows;
    }
    await conn.query("UPDATE campaigns SET dialer_state = 'stopped' WHERE dialer_state <> 'stopped'");
    await conn.commit();
    for (const t of CLEAR) await conn.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`).catch(() => {});
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    conn.release();
  }
  return counts;
}

function backup(env) {
  const dir = path.join(os.homedir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `pre-reset-${stamp}.sql`);
  const dump = execFileSync(
    'mysqldump',
    [
      '--single-transaction',
      '--routines',
      '--no-tablespaces',
      '-u',
      env.DB_USER || 'dialforge',
      env.DB_NAME || 'dialforge_dev',
    ],
    { env: { ...env, MYSQL_PWD: env.DB_PASSWORD || '' }, maxBuffer: 2 * 1024 * 1024 * 1024 },
  );
  fs.writeFileSync(file, dump, { mode: 0o600 });
  let recordings = null;
  if (fs.existsSync(RECORDINGS)) {
    recordings = path.join(dir, `pre-reset-${stamp}-recordings.tgz`);
    execFileSync('sudo', ['-n', 'tar', 'czf', recordings, '-C', RECORDINGS, '.']);
    execFileSync('sudo', ['-n', 'chown', `${os.userInfo().uid}:${os.userInfo().gid}`, recordings]);
    fs.chmodSync(recordings, 0o600);
  }
  return { file, recordings };
}

function clearRecordings() {
  if (!fs.existsSync(RECORDINGS)) return;
  execFileSync('sudo', ['-n', 'find', RECORDINGS, '-mindepth', '1', '-delete']);
}

module.exports = { CLEAR, refusal, clearTables };

if (require.main === module) {
  const pool = require('../../db');
  (async () => {
    const why = await refusal({ env: process.env, args: process.argv.slice(2), db: pool });
    if (why) {
      console.error(`Not reset: ${why}`);
      process.exitCode = 1;
      return;
    }
    const b = backup(process.env);
    console.log(`backup: ${b.file}${b.recordings ? `\nrecordings: ${b.recordings}` : ''}`);
    console.log(`(undo: mysql -u <user> -p <database> < ${b.file})`);
    const counts = await clearTables(pool);
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(18)} ${n} row(s) deleted`);
    clearRecordings();
    console.log('recordings on this server cleared (S3 copies kept)');
    console.log('\nNow: sudo systemctl restart dialforge-backend dialforge-dialer');
  })()
    .catch((err) => {
      console.error(`FAILED: ${err.message}`);
      process.exitCode = 2;
    })
    .finally(() => pool.end());
}
