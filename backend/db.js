// The database every query goes through. On a single-customer install that
// is one pool for DB_NAME, as always. With MULTI_TENANT=1 (the Cloud edition,
// docs/plans/TENANTS_PLAN.md) each query goes to the current tenant's
// database (src/tenancy.js); outside a request, to the home tenant (DB_NAME).
// Callers keep using pool.query / pool.getConnection / pool.end.
const mysql = require('mysql2/promise');
const tenancy = require('./src/tenancy');

const settings = (database, extra = {}) => ({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dialforge',
  password: process.env.DB_PASSWORD,
  database,
  ...extra,
});

const homeName = process.env.DB_NAME || 'dialforge_dev';
const home = mysql.createPool(settings(homeName));
const pools = new Map([[homeName, home]]);
let platform = null;

/** The pool of one tenant database (made on first use, kept small: many customers share the server). */
function poolFor(dbName) {
  if (!pools.has(dbName)) {
    pools.set(
      dbName,
      mysql.createPool(settings(dbName, { connectionLimit: Number(process.env.TENANT_POOL_SIZE) || 5 })),
    );
  }
  return pools.get(dbName);
}

/** The platform database: the customer list and every customer's login sessions. */
function platformPool() {
  if (!platform) platform = mysql.createPool(settings(process.env.PLATFORM_DB_NAME || 'viztex_platform'));
  return platform;
}

/** The pool for the code running now. */
function current() {
  const t = tenancy.current();
  return t && t.dbName ? poolFor(t.dbName) : home;
}

module.exports = {
  query: (...args) => current().query(...args),
  getConnection: () => current().getConnection(),
  async end() {
    await Promise.all([...pools.values(), platform].filter(Boolean).map((p) => p.end()));
  },
  current,
  poolFor,
  platformPool,
};
