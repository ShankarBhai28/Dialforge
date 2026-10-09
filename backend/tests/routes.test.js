// Route table safety checks - no database or Asterisk needed:
// every route is protected as intended, and no route hides another.
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const { createApp } = require('../src/app');

// Routes anyone may call without logging in. Adding to this list should be
// a deliberate, reviewed decision.
const PUBLIC_ROUTES = ['GET /health', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me'];

// Stand-in for the real session: the role comes from a test header.
const fakeSession = (req, res, next) => {
  const role = req.headers['x-test-role'];
  req.session = role ? { user: { id: 999999, username: 'test', role }, destroy: (cb) => cb() } : {};
  next();
};

const app = createApp({ sessionMiddleware: fakeSession });

function listRoutes() {
  const routes = [];
  for (const layer of app._router.stack) {
    if (layer.name !== 'router') continue;
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      for (const m of Object.keys(l.route.methods)) routes.push({ method: m.toUpperCase(), path: l.route.path });
    }
  }
  return routes;
}
const routes = listRoutes();
const key = (r) => `${r.method} ${r.path}`;
const sample = (p) => p.replace(/:[^/]+/g, '1');

let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (r, role) =>
  fetch(base + sample(r.path), {
    method: r.method,
    headers: role ? { 'x-test-role': role, 'content-type': 'application/json' } : {},
    body: r.method === 'GET' ? undefined : role ? '{}' : undefined,
  });

test('route table loads (about 85 routes)', () => {
  assert(routes.length >= 80, `only ${routes.length} routes registered`);
  const dupes = routes.map(key).filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepStrictEqual(dupes, [], 'same method + path registered twice');
});

test('no route is hidden by an earlier one', () => {
  // e.g. GET /admin/leads/:id registered before GET /admin/leads/template
  // would swallow every request for the template.
  const toRegex = (p) => new RegExp('^' + p.replace(/:[^/]+/g, '[^/]+') + '$');
  const problems = [];
  routes.forEach((later, j) => {
    routes.slice(0, j).forEach((earlier) => {
      if (earlier.method === later.method && earlier.path !== later.path && toRegex(earlier.path).test(later.path))
        problems.push(`${key(earlier)} hides ${key(later)}`);
    });
  });
  assert.deepStrictEqual(problems, []);
});

test('only the public routes answer without a login', async () => {
  const open = [];
  for (const r of routes) {
    if (PUBLIC_ROUTES.includes(key(r))) continue;
    const res = await call(r, null);
    if (res.status !== 401) open.push(`${key(r)} -> ${res.status}`);
  }
  assert.deepStrictEqual(open, [], 'these routes did not require a login');
});

test('every /admin route refuses agents', async () => {
  const leaks = [];
  for (const r of routes.filter((x) => x.path.startsWith('/admin/'))) {
    const res = await call(r, 'agent');
    if (res.status !== 403) leaks.push(`${key(r)} -> ${res.status}`);
  }
  assert.deepStrictEqual(leaks, [], 'agents could reach these admin routes');
});
