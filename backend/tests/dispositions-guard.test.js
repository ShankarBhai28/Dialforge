// A campaign's auto disposition can't be removed from its dispositions list
// (every automatic save - and agents choosing it - would then be refused).
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const sql = [];
const q = async (text, params) => {
  const s = text.replace(/\s+/g, ' ').trim();
  sql.push([s, params]);
  if (s.startsWith('SELECT id, auto_dispo_sec, auto_dispo_code FROM campaigns'))
    return [[{ id: 4, auto_dispo_sec: 10, auto_dispo_code: 'no_dispo' }]];
  return [[]];
};
const conn = {
  query: q,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release() {},
};
fake('db.js', { query: q, getConnection: async () => conn });

const { createApp } = require('../src/app');
const app = createApp({
  sessionMiddleware: (req, res, next) => {
    req.session = { user: { id: 1, username: 'boss', role: 'admin', loginAt: Date.now() } };
    next();
  },
  webDistDir: '/nonexistent',
  audit: false,
});
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
const put = (body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${base}/admin/campaigns/4/dispositions`,
      {
        method: 'PUT',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve([res.statusCode, JSON.parse(text)]));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

const D = (code, label, extra = {}) => ({ code, label, isFinal: false, retryAfterMin: 60, ...extra });

test('removing the auto disposition is refused with what to do; keeping it saves', async () => {
  const [status, body] = await put({ dispositions: [D('no_answer', 'No Answer')] });
  assert.strictEqual(status, 400);
  assert.match(body.error, /"no_dispo" is this campaign's auto disposition - choose another one/);
  assert.ok(!sql.some(([s]) => s.startsWith('DELETE FROM campaign_dispositions')), 'nothing was changed');
  const [ok] = await put({ dispositions: [D('no_answer', 'No Answer'), D('no_dispo', 'No Dispo')] });
  assert.strictEqual(ok, 200);
});

test("the auto disposition can't become a callback", async () => {
  const [status, body] = await put({
    dispositions: [D('no_dispo', 'No Dispo', { isCallback: true, retryAfterMin: null })],
  });
  assert.strictEqual(status, 400);
  assert.match(body.error, /can't be a callback/);
});
