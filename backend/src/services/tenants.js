// The customer list of the Cloud edition (platform database, table
// `tenants`) - docs/plans/TENANTS_PLAN.md. Read on every request of a
// logged-in user, so rows are cached for a short while; a suspension
// reaches running sessions within CACHE_MS.
const db = require('../../db');
const tenancy = require('../tenancy');

const CACHE_MS = 30 * 1000;
// What people type at login: lower-case letters, digits and dashes, 2-30, no dash at either end.
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

const cache = new Map(); // code -> { row, at }

const normalizeCode = (code) =>
  String(code ?? '')
    .trim()
    .toLowerCase();

/** The database a new customer gets: viztex_t_<code> (dashes become underscores). */
const dbNameFor = (code) => `viztex_t_${normalizeCode(code).replace(/-/g, '_')}`;

/** The customer with this code ({ id, code, name, db_name, status }), or null. */
async function findTenant(code, deps = { pool: db.platformPool(), now: Date.now }) {
  const c = normalizeCode(code);
  if (!CODE_RE.test(c)) return null;
  const hit = cache.get(c);
  if (hit && deps.now() - hit.at < CACHE_MS) return hit.row;
  const [rows] = await deps.pool.query('SELECT id, code, name, db_name, status FROM tenants WHERE code = ?', [c]);
  const row = rows[0] || null;
  cache.set(c, { row, at: deps.now() });
  return row;
}

/** After a customer was changed (suspended, renamed): the next request reads it again. */
function forgetTenant(code) {
  if (code === undefined) cache.clear();
  else cache.delete(normalizeCode(code));
}

/** What tenancy.run needs for this customer. */
const contextOf = (row) => ({ code: row.code, name: row.name, dbName: row.db_name });

/**
 * Runs fn as the customer with this code (for work started outside a
 * request: a realtime connection's events, its re-read of rights). The home
 * tenant, '' or a single-customer install: fn runs as it is.
 */
async function runAsTenant(code, fn, deps) {
  if (!tenancy.isMulti() || !code || code === tenancy.homeCode()) return fn();
  const row = await findTenant(code, deps);
  if (!row) throw new Error(`unknown company "${code}"`);
  return tenancy.run(contextOf(row), fn);
}

module.exports = { CODE_RE, normalizeCode, dbNameFor, findTenant, forgetTenant, contextOf, runAsTenant };
