// The app on 443: old :3000 links are sent on to the same page without a port.
const assert = require('node:assert');
const { test } = require('node:test');
const { redirectFromPort, redirectTarget, redirectHandler } = require('../src/portRedirect');

test("an old :3000 link goes to the same page on 443, on the server's own name", () => {
  const env = { PORT: '443', SIP_DOMAIN: 'crm.acme.in' };
  assert.strictEqual(
    redirectTarget({ headers: { host: 'crm.acme.in:3000' }, url: '/app/agent?x=1' }, env),
    'https://crm.acme.in/app/agent?x=1',
  );
  // A made-up Host header can't send anyone elsewhere.
  assert.strictEqual(redirectTarget({ headers: { host: 'evil.example:3000' }, url: '/' }, env), 'https://crm.acme.in/');
  // No SIP_DOMAIN: the name the browser used, without its port; another main port is kept.
  assert.strictEqual(
    redirectTarget({ headers: { host: '10.0.0.5:3000' }, url: '/health' }, { PORT: '8443' }),
    'https://10.0.0.5:8443/health',
  );
});

test('the redirect listener runs only when asked for and different from the app port', () => {
  assert.strictEqual(redirectFromPort({ PORT: '443', REDIRECT_FROM_PORT: '3000' }), 3000);
  assert.strictEqual(redirectFromPort({ PORT: '3000', REDIRECT_FROM_PORT: '3000' }), null, 'same port');
  assert.strictEqual(redirectFromPort({ PORT: '3000' }), null, 'not set: dev and older servers');
  assert.strictEqual(redirectFromPort({}), null);
});

test('the answer is a permanent redirect that browsers do not cache forever by mistake', () => {
  const saved = { ...process.env };
  process.env.PORT = '443';
  process.env.SIP_DOMAIN = 'crm.acme.in';
  try {
    let head;
    let ended = false;
    redirectHandler(
      { headers: { host: 'crm.acme.in:3000' }, url: '/app/' },
      { writeHead: (code, h) => (head = [code, h]), end: () => (ended = true) },
    );
    assert.deepStrictEqual(head, [301, { Location: 'https://crm.acme.in/app/', 'Cache-Control': 'no-store' }]);
    assert.ok(ended);
  } finally {
    process.env = saved;
  }
});

test("split servers: old links go to the app's address (APP_DOMAIN), not the telephony server's", () => {
  assert.strictEqual(
    redirectTarget(
      { headers: { host: 'crm.acme.in:3000' }, url: '/app/' },
      { PORT: '443', APP_DOMAIN: 'crm.acme.in', SIP_DOMAIN: 'sip.acme.in' },
    ),
    'https://crm.acme.in/app/',
  );
});
