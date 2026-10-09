// Live-update hub (/ws): login required, admins see everything, agents
// only messages addressed to them.
const assert = require('node:assert');
const http = require('node:http');
const { test, before, after } = require('node:test');
const WebSocket = require('ws');
const hub = require('../src/realtime/hub');

// Same contract as express-session: fills req.session from the request.
const fakeSession = (req, res, next) => {
  const [role, id] = (req.headers['x-test-user'] || '').split(':');
  req.session = role ? { user: { id: Number(id), username: `${role}${id}`, role } } : {};
  next();
};

let server;
let url;
before(async () => {
  server = http.createServer((req, res) => res.end());
  hub.attach(server, fakeSession);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});
after(() => server.close());

// Opens a socket and collects its messages until closed.
function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: user ? { 'x-test-user': user } : {} });
    const messages = [];
    ws.on('message', (m) => messages.push(JSON.parse(m)));
    ws.on('open', () => {
      const wait = () => (messages.length ? resolve({ ws, messages }) : setTimeout(wait, 5));
      wait();
    });
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('refuses a connection without a login', async () => {
  await assert.rejects(connect(null), (err) => err.status === 401);
});

test('admin gets everything; an agent only their own messages', async () => {
  const admin = await connect('admin:1');
  const agent7 = await connect('agent:7');
  const agent8 = await connect('agent:8');
  assert.strictEqual(admin.messages[0].type, 'hello');

  hub.publish('agent.status', { userId: 7, status: 'break' }, { toUserId: 7 });
  hub.publish('call.event', { callId: 1, eventType: 'answered' });
  await settle();

  const types = (c) => c.messages.slice(1).map((m) => m.type);
  assert.deepStrictEqual(types(admin), ['agent.status', 'call.event']);
  assert.deepStrictEqual(types(agent7), ['agent.status']);
  assert.deepStrictEqual(types(agent8), []);
  for (const c of [admin, agent7, agent8]) c.ws.close();
});
