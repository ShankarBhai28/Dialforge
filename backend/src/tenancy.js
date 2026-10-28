// Which customer (tenant) the code is working for right now - the Cloud
// edition (docs/plans/TENANTS_PLAN.md). Off unless MULTI_TENANT=1: a
// single-customer install never has a current tenant and every key is ''.
//
// A web request runs inside run() with its customer (middleware/tenant.js);
// everything it awaits - queries, audit writes, timers it starts - sees the
// same tenant (AsyncLocalStorage). db.js sends each query to that tenant's
// database. Code outside a request (timers, the dialer engine, telephony
// events) has no current tenant and works on the home tenant: the database in
// DB_NAME, registered under HOME_TENANT_CODE.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

const isMulti = () => process.env.MULTI_TENANT === '1';

/** The home tenant's company code ('' when not set or not multi-tenant). */
const homeCode = () => (isMulti() ? (process.env.HOME_TENANT_CODE || '').toLowerCase() : '');

/** { code, name, dbName } of the request being served, or null (home tenant). */
function current() {
  return isMulti() ? als.getStore() || null : null;
}

/**
 * The current tenant's key for things kept in memory per customer (user ids
 * repeat across databases): its code, the home code outside a request, ''
 * on a single-customer install.
 */
function key() {
  const t = current();
  return t ? t.code : homeCode();
}

/** Runs fn (and everything it awaits) as this tenant. */
function run(tenant, fn) {
  return als.run(tenant, fn);
}

module.exports = { isMulti, homeCode, current, key, run };
