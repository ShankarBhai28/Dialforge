// /app serves the built React app: real files as-is, every other /app URL
// gets index.html (so refreshing a deep link works), API routes untouched.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { createApp } = require('../src/app');

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'df-web-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');

const noSession = (req, res, next) => {
  req.session = {};
  next();
};

let server;
let base;
let serverMissing;
let baseMissing;
before(async () => {
  server = createApp({ audit: false, sessionMiddleware: noSession, webDistDir: dist }).listen(0, '127.0.0.1');
  serverMissing = createApp({ audit: false, sessionMiddleware: noSession, webDistDir: path.join(dist, 'nope') }).listen(
    0,
    '127.0.0.1',
  );
  await Promise.all([server, serverMissing].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${server.address().port}`;
  baseMissing = `http://127.0.0.1:${serverMissing.address().port}`;
});
after(() => {
  server.close();
  serverMissing.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

test('deep links get index.html, never cached', async () => {
  for (const url of ['/app', '/app/', '/app/admin/users', '/app/login?next=%2Fadmin']) {
    const res = await fetch(base + url);
    assert.strictEqual(res.status, 200, url);
    assert.match(await res.text(), /id="root"/, url);
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache', url);
  }
});

test('built assets are served with a long cache; a missing one is a 404', async () => {
  const res = await fetch(base + '/app/assets/index-abc123.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.strictEqual((await fetch(base + '/app/assets/missing.js')).status, 404);
});

test('API routes are unaffected', async () => {
  assert.strictEqual((await fetch(base + '/admin/campaigns')).status, 401);
  assert.strictEqual((await fetch(base + '/auth/me')).status, 401);
});

test('old page addresses open the app', async () => {
  const where = async (url) => {
    const res = await fetch(base + url, { redirect: 'manual' });
    return [res.status, res.headers.get('location')];
  };
  assert.deepStrictEqual(await where('/'), [302, '/app/']);
  assert.deepStrictEqual(await where('/login.html'), [302, '/app/login']);
  assert.deepStrictEqual(await where('/admin.html'), [302, '/app/admin']);
  assert.deepStrictEqual(await where('/agent.html'), [302, '/app/agent']);
});

test('a clear message when the app has not been built', async () => {
  const res = await fetch(baseMissing + '/app/admin');
  assert.strictEqual(res.status, 503);
  assert.match(await res.text(), /not built/);
});
