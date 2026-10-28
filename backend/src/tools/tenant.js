// Cloud edition: the customer list (docs/plans/TENANTS_PLAN.md). On the app
// server, from the app's folder:
//
//   npm run tenant -- create --code acme --name "Acme Collections" --admin boss
//   npm run tenant -- list
//   npm run tenant -- suspend --code acme        (resume: the same with resume)
//   npm run tenant -- register-home --code main --name "Our company"
//
// create: a new database viztex_t_<code> with every migration, its Super
// Admin (password from ADMIN_PASSWORD, or a random one printed once) and the
// entry in the platform database. Nothing is left behind if a step fails.
// register-home: lists this server's own database (DB_NAME) as a company -
// once, when an install becomes multi-tenant; set HOME_TENANT_CODE to the
// same code.
// Suspended companies can't log in; their open sessions end within 30 s.
// Needs the platform database (npm run db:migrate -- --platform) and a MySQL
// user allowed to create the viztex_t_% databases (RUNBOOK: Cloud edition).
require('dotenv').config();
const mysql = require('mysql2/promise');
const migrate = require('./migrate');
const { createAdmin, randomPassword } = require('./create-admin');
const { CODE_RE, dbNameFor, normalizeCode } = require('../services/tenants');

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

const connect = (database, extra = {}) =>
  mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'dialforge',
    password: process.env.DB_PASSWORD,
    ...(database ? { database } : {}),
    ...extra,
  });

function checkCode(code) {
  if (!CODE_RE.test(code))
    throw new Error('--code: 2-30 lower-case letters, digits or dashes (not at the start or end)');
}

async function create(platform, argv, log, deps = { connect, migrate: migrate.run, createAdmin }) {
  const code = normalizeCode(arg(argv, 'code'));
  const name = (arg(argv, 'name') || '').trim();
  const admin = arg(argv, 'admin');
  checkCode(code);
  if (!name) throw new Error('--name: the company name');
  if (!admin) throw new Error('--admin: the Super Admin username for this company');
  const [taken] = await platform.query('SELECT id FROM tenants WHERE code = ?', [code]);
  if (taken.length) throw new Error(`company code "${code}" is already used`);
  const dbName = dbNameFor(code);

  const server = await deps.connect(null);
  let made = false;
  try {
    const [exists] = await server.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [dbName]);
    if (exists.length) throw new Error(`database ${dbName} already exists - remove it or pick another code`);
    await server.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    made = true;
    log(`database ${dbName} created`);

    const conn = await deps.connect(dbName, { multipleStatements: true });
    let password;
    try {
      await deps.migrate(conn, [], log, migrate.DIR);
      password = process.env.ADMIN_PASSWORD || randomPassword();
      await deps.createAdmin(conn, admin, password);
    } finally {
      await conn.end();
    }
    await platform.query('INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?)', [code, name, dbName]);
    made = false; // registered: keep it
    log(`company "${name}" ready - company code: ${code}`);
    log(`Super Admin: ${admin}`);
    if (!process.env.ADMIN_PASSWORD)
      log(`Password (shown once - store it safely, change it after logging in): ${password}`);
  } finally {
    if (made) {
      await server.query(`DROP DATABASE \`${dbName}\``).catch(() => {});
      log(`(${dbName} removed again)`);
    }
    await server.end();
  }
}

async function list(platform, log) {
  const [rows] = await platform.query('SELECT code, name, db_name, status, created_at FROM tenants ORDER BY id');
  if (!rows.length) return log('no companies yet');
  for (const r of rows) {
    log(`${r.code.padEnd(20)} ${r.status.padEnd(10)} ${r.db_name.padEnd(28)} ${r.name}`);
  }
}

async function setStatus(platform, argv, status, log) {
  const code = normalizeCode(arg(argv, 'code'));
  checkCode(code);
  const [r] = await platform.query('UPDATE tenants SET status = ? WHERE code = ?', [status, code]);
  if (!r.affectedRows) throw new Error(`no company "${code}"`);
  log(`${code}: ${status}`);
}

async function registerHome(platform, argv, log, env = process.env) {
  const code = normalizeCode(arg(argv, 'code'));
  const name = (arg(argv, 'name') || '').trim();
  checkCode(code);
  if (!name) throw new Error('--name: the company name');
  const dbName = env.DB_NAME || 'dialforge_dev';
  const [taken] = await platform.query('SELECT code FROM tenants WHERE code = ? OR db_name = ?', [code, dbName]);
  if (taken.length) throw new Error(`already registered as "${taken[0].code}"`);
  await platform.query('INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?)', [code, name, dbName]);
  log(`${dbName} registered as company "${code}". Set HOME_TENANT_CODE=${code} in .env.`);
}

async function main(argv, log = console.log) {
  const cmd = argv[0];
  const platform = await connect(process.env.PLATFORM_DB_NAME || 'viztex_platform');
  try {
    if (cmd === 'create') await create(platform, argv, log);
    else if (cmd === 'list') await list(platform, log);
    else if (cmd === 'suspend') await setStatus(platform, argv, 'suspended', log);
    else if (cmd === 'resume') await setStatus(platform, argv, 'active', log);
    else if (cmd === 'register-home') await registerHome(platform, argv, log);
    else throw new Error('commands: create, list, suspend, resume, register-home (see the top of src/tools/tenant.js)');
  } finally {
    await platform.end();
  }
}

module.exports = { create, list, setStatus, registerHome };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ERROR ${err.message}`);
    process.exitCode = 1;
  });
}
