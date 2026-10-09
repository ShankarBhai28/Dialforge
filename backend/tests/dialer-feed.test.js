// The live Dialer feed: publishes only when the screen would change, only
// while an admin is connected, and right away after start/pause/stop.
const assert = require('node:assert');
const { test } = require('node:test');
const { createDialerFeed, fingerprint } = require('../src/realtime/dialerFeed');

const overview = (state, tick, today = null) => ({
  engine: { engine_id: 'e1', last_tick_at: tick, age_sec: 1, alive: true },
  campaigns: [{ id: 1, name: 'Sales', dialer_state: state, hopper_ready: 4, last_tick_at: tick, today }],
});

function setup() {
  const sent = [];
  const env = { admins: 1, next: overview('running', 't1') };
  const feed = createDialerFeed({
    load: async () => env.next,
    publish: (type, data) => sent.push([type, data]),
    hasAdmins: () => env.admins > 0,
  });
  return { feed, sent, env };
}

test('tick times alone are not a change; anything else is', () => {
  assert.strictEqual(fingerprint(overview('running', 't1')), fingerprint(overview('running', 't2')));
  assert.notStrictEqual(fingerprint(overview('running', 't1')), fingerprint(overview('paused', 't1')));
  assert.notStrictEqual(
    fingerprint(overview('running', 't1')),
    fingerprint(overview('running', 't1', { attempts: 1 })),
  );
});

test('publishes the first read and later changes, not repeats', async () => {
  const { feed, sent, env } = setup();
  await feed.check();
  env.next = overview('running', 't2');
  await feed.check();
  env.next = overview('paused', 't3');
  await feed.check();
  assert.deepStrictEqual(
    sent.map(([type, d]) => [type, d.campaigns[0].dialer_state]),
    [
      ['dialer.status', 'running'],
      ['dialer.status', 'paused'],
    ],
  );
});

test('no admin connected: no DB read, no message', async () => {
  const { feed, sent, env } = setup();
  env.admins = 0;
  env.next = null; // a read would throw on .engine
  await feed.check();
  assert.deepStrictEqual(sent, []);
});

test('force (after start/pause/stop) publishes even when unchanged, and re-reads if a read was running', async () => {
  const { feed, sent } = setup();
  await feed.check();
  await feed.check({ force: true });
  assert.strictEqual(sent.length, 2);

  const first = feed.check({ force: true }); // read in progress
  const second = feed.check({ force: true }); // must not be lost
  await Promise.all([first, second]);
  assert.strictEqual(sent.length, 4);
});
