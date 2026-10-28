// Cloud edition: runs each request of a logged-in user as their company
// (session.tenant, set at login), so every query reaches that company's
// database. Not logged in: the request runs as the home tenant - only the
// login and public routes answer then. A company suspended or removed since
// the login: the session ends here.
const tenancy = require('../tenancy');
const { findTenant, contextOf } = require('../services/tenants');

function tenantMiddleware(deps = { findTenant }) {
  return async (req, res, next) => {
    if (!tenancy.isMulti()) return next();
    const code = req.session && req.session.tenant;
    if (!code) return next();
    let row;
    try {
      row = await deps.findTenant(code);
    } catch (err) {
      console.error('[tenant lookup]', err.message);
      return res.status(503).json({ error: 'could not reach the company list - try again in a moment' });
    }
    if (!row || row.status !== 'active') {
      req.session.destroy(() => {});
      return res.status(401).json({
        error: row ? 'Your company account is suspended - contact VIZTEX support.' : 'not logged in',
      });
    }
    tenancy.run(contextOf(row), next);
  };
}

module.exports = { tenantMiddleware };
