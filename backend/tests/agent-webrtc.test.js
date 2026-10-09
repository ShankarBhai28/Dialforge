// Softphone settings come from .env; extension hand-out refuses a line a
// colleague is actively using.
const assert = require('node:assert');
const { test } = require('node:test');
const { buildWebrtcConfig } = require('../src/services/webrtc');
const { findOtherActiveHolder } = require('../src/services/extensionGuard');

test('webrtc config: defaults from the request host, STUN only without TURN credentials', () => {
  assert.deepStrictEqual(buildWebrtcConfig({}, 'dialforge.example.com'), {
    sipDomain: 'dialforge.example.com',
    wsUrl: 'wss://dialforge.example.com:8089/ws',
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  });
  // TURN urls without a username/password are left out rather than sent half-configured
  assert.strictEqual(buildWebrtcConfig({ TURN_URLS: 'turn:1.2.3.4:3478' }, 'h').iceServers.length, 1);
});

test('webrtc config: everything from .env', () => {
  const cfg = buildWebrtcConfig(
    {
      SIP_DOMAIN: 'sip.example.com',
      WEBRTC_WS_URL: 'wss://ws.example.com/ws',
      STUN_URLS: '',
      TURN_URLS: 'turn:1.2.3.4:3478, turns:sip.example.com:443?transport=tcp',
      TURN_USERNAME: 'u',
      TURN_PASSWORD: 'p',
    },
    'ignored',
  );
  assert.deepStrictEqual(cfg, {
    sipDomain: 'sip.example.com',
    wsUrl: 'wss://ws.example.com/ws',
    iceServers: [
      { urls: ['turn:1.2.3.4:3478', 'turns:sip.example.com:443?transport=tcp'], username: 'u', credential: 'p' },
    ],
  });
});

const deps = (rows, online) => ({
  pool: { query: async () => [rows] },
  ari: { isEndpointOnline: async (r) => (assert.strictEqual(r, 'PJSIP/1003'), online) },
});

test('extension guard: blocks only a line another agent holds AND has registered', async () => {
  assert.strictEqual(await findOtherActiveHolder('1003', 7, deps([{ username: 'agent1003' }], true)), 'agent1003');
  // stale session (browser closed without logout): extension not registered -> free
  assert.strictEqual(await findOtherActiveHolder('1003', 7, deps([{ username: 'agent1003' }], false)), null);
  assert.strictEqual(await findOtherActiveHolder('1003', 7, deps([], true)), null);
});

test('webrtc config: TURN_SECRET gives each login its own expiring password (coturn REST API)', () => {
  const crypto = require('node:crypto');
  const nowMs = Date.UTC(2026, 9, 9, 12, 0, 0);
  const cfg = buildWebrtcConfig(
    {
      STUN_URLS: '',
      TURN_URLS: 'turn:1.2.3.4:3478',
      TURN_SECRET: 's3cret',
      TURN_USERNAME: 'old',
      TURN_PASSWORD: 'old',
    },
    'h',
    { userId: 7, nowMs },
  );
  const [turn] = cfg.iceServers;
  const expiry = nowMs / 1000 + 12 * 3600;
  assert.strictEqual(turn.username, `${expiry}:agent7`);
  // What coturn computes from its static-auth-secret:
  assert.strictEqual(turn.credential, crypto.createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
  // TTL can be set
  const short = buildWebrtcConfig({ TURN_URLS: 't', TURN_SECRET: 's', TURN_TTL_SEC: '60' }, 'h', { userId: 1, nowMs });
  assert.strictEqual(short.iceServers.at(-1).username, `${nowMs / 1000 + 60}:agent1`);
});
