// Old links keep working when the app moves to the standard https port: a
// request to REDIRECT_FROM_PORT (e.g. https://crm.client.com:3000/app) is sent
// on to the same page on PORT (https://crm.client.com/app).
//
// The address is the app's own name (APP_DOMAIN, else SIP_DOMAIN) when it
// has one, so a made-up Host header can't send anyone elsewhere.

/** Where a request that came in on the old port should go. */
function redirectTarget(req, env = process.env) {
  const port = Number(env.PORT || 3000);
  const host = env.APP_DOMAIN || env.SIP_DOMAIN || String(req.headers.host || 'localhost').replace(/:\d+$/, '');
  return `https://${host}${port === 443 ? '' : `:${port}`}${req.url || '/'}`;
}

/** The old port to answer on with redirects, or null (not set, or the same as the app's port). */
function redirectFromPort(env = process.env) {
  const from = Number(env.REDIRECT_FROM_PORT || 0);
  return from > 0 && from !== Number(env.PORT || 3000) ? from : null;
}

function redirectHandler(req, res) {
  res.writeHead(301, { Location: redirectTarget(req), 'Cache-Control': 'no-store' });
  res.end();
}

module.exports = { redirectFromPort, redirectHandler, redirectTarget };
