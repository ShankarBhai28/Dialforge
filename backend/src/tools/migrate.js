// Database migrations: brings any DialForge database - a new client's empty
// one or an existing one - to the current structure, the same way every time.
//
//   npm run db:migrate              apply what's missing, in order
//   npm run db:migrate -- --status  list applied / pending (changes nothing)
//   npm run db:migrate -- --baseline
//       once, on a database that already has the tables (created before
//       this tool existed): records 0001_baseline as applied without running it
//
// Files: backend/migrations/NNNN_name.sql, applied in number order. Each one
// is recorded in schema_migrations (name, checksum, when). Never edit a file
// that has been applied anywhere - add a new one (the checksum shows edits).
// Back up before applying on a live server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE_RE = /^(\d{4})_[a-z0-9_-]+\.sql$/;
const BASELINE = '0001_baseline.sql';

const checksum = (sql) => crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/** The migration files in order: [{ name, sql, checksum }]. */
function loadMigrations(dir = DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    });
}

async function ensureTable(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function appliedMap(conn) {
  const [rows] = await conn.query('SELECT name, checksum, applied_at FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r]));
}

/** Tables other than schema_migrations: an empty database has none. */
async function otherTableCount(conn) {
  const [[r]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'schema_migrations'",
  );
  return Number(r.n);
}

/**
 * Works out what to do. Pure, so it's easy to test:
 * { pending: [...], changed: [...], error } - `error` means stop and explain.
 */
function plan(migrations, applied, { tablesExist }) {
  const changed = migrations.filter((m) => applied.has(m.name) && applied.get(m.name).checksum !== m.checksum);
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (applied.size === 0 && tablesExist) {
    return {
      pending,
      changed,
      error:
        'This database already has tables but no migration history. If it is an existing DialForge database, ' +
        'run once:  npm run db:migrate -- --baseline   (then db:migrate as usual).',
    };
  }
  return { pending, changed, error: null };
}

async function run(conn, args, log = console.log, dir = DIR) {
  await ensureTable(conn);
  const migrations = loadMigrations(dir);
  const applied = await appliedMap(conn);
  const tablesExist = (await otherTableCount(conn)) > 0;

  if (args.includes('--baseline')) {
    if (!tablesExist)
      throw new Error('--baseline is for an existing database; this one is empty - run db:migrate instead');
    if (applied.size) throw new Error('this database already has a migration history - nothing to baseline');
    const base = migrations.find((m) => m.name === BASELINE);
    if (!base) throw new Error(`${BASELINE} not found`);
    await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [base.name, base.checksum]);
    log(`marked ${BASELINE} as applied (not run). Now run: npm run db:migrate`);
    return 0;
  }

  const { pending, changed, error } = plan(migrations, applied, { tablesExist });
  for (const m of changed) log(`WARNING ${m.name} was changed after it was applied - add a new migration instead`);

  if (args.includes('--status')) {
    for (const m of migrations) {
      const a = applied.get(m.name);
      log(`${a ? 'applied ' : 'PENDING '} ${m.name}${a ? `  (${new Date(a.applied_at).toISOString()})` : ''}`);
    }
    if (error) log(error);
    return pending.length || error ? 1 : 0;
  }

  if (error) throw new Error(error);
  if (!pending.length) {
    log('database is up to date');
    return 0;
  }
  for (const m of pending) {
    log(`applying ${m.name} ...`);
    // MySQL commits each DDL statement on its own, so a failed file can be
    // half-applied: the run stops there and says which file to look at.
    try {
      await conn.query(m.sql);
    } catch (err) {
      throw new Error(`${m.name} failed: ${err.message} - fix it (restore the backup if needed) before running again`);
    }
    await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [m.name, m.checksum]);
  }
  log(`done: ${pending.length} migration(s) applied`);
  return 0;
}

module.exports = { loadMigrations, plan, run, checksum, BASELINE };

if (require.main === module) {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  (async () => {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'dialforge',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'dialforge_dev',
      multipleStatements: true, // a migration file holds several statements
    });
    try {
      process.exitCode = await run(conn, process.argv.slice(2));
    } catch (err) {
      console.error(`ERROR ${err.message}`);
      process.exitCode = 2;
    } finally {
      await conn.end();
    }
  })();
}
