// Password guessing protection on /auth/login.
const assert = require('node:assert');
const { test } = require('node:test');
const { LoginGuard } = require('../src/services/loginGuard');

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (min) => (t += min * 60000) };
}

test('5 wrong passwords for one username lock it for 15 minutes; a success clears the count', () => {
  const c = clock();
  const g = new LoginGuard({ now: c.now });
  for (let i = 0; i < 4; i++) assert.strictEqual(g.fail('Ravi', '1.1.1.1'), false);
  g.succeed('ravi'); // case doesn't matter
  for (let i = 0; i < 4; i++) g.fail('ravi', '1.1.1.1');
  assert.strictEqual(g.blockedFor('ravi', '2.2.2.2'), 0);
  assert.strictEqual(g.fail('ravi', '1.1.1.1'), true); // 5th
  assert.strictEqual(g.blockedFor('RAVI', '9.9.9.9'), 15); // locked whatever the address
  assert.strictEqual(g.blockedFor('other', '9.9.9.9'), 0);
  c.advance(14);
  assert.strictEqual(g.blockedFor('ravi', '9.9.9.9'), 1);
  c.advance(1);
  assert.strictEqual(g.blockedFor('ravi', '9.9.9.9'), 0);
});

test('failures older than 15 minutes do not count', () => {
  const c = clock();
  const g = new LoginGuard({ now: c.now });
  for (let i = 0; i < 4; i++) g.fail('ravi', '1.1.1.1');
  c.advance(16);
  assert.strictEqual(g.fail('ravi', '1.1.1.1'), false);
});

test('20 failures from one address block it, whichever usernames were tried', () => {
  const c = clock();
  const g = new LoginGuard({ now: c.now });
  for (let i = 0; i < 19; i++) g.fail(`user${i}`, '5.5.5.5');
  assert.strictEqual(g.blockedFor('anyone', '5.5.5.5'), 0);
  g.fail('user19', '5.5.5.5');
  assert.strictEqual(g.blockedFor('anyone', '5.5.5.5'), 15);
  assert.strictEqual(g.blockedFor('anyone', '6.6.6.6'), 0);
});
