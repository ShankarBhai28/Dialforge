// The client's licence: seats, lines (every call on the trunk), end date.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viztex-lic-')), 'licence.json');
process.env.LICENCE_FILE = file;
const licence = require('../src/services/licence');
const { seatRefusal } = require('../src/services/singleLogin');

function write(obj) {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const t = new Date(Date.now() + Math.random() * 100000); // a new mtime each time
  fs.utimesSync(file, t, t);
  licence._reset();
}
const ari = (n) => ({ endpointChannelCount: async () => n });

test('parse: whole numbers above 0, a YYYY-MM-DD date; anything else is refused with a reason', () => {
  assert.deepStrictEqual(licence.parseLicence('{"customer":"Acme","seats":10,"channels":15,"expires":"2026-12-31"}'), {
    customer: 'Acme',
    seats: 10,
    channels: 15,
    expires: '2026-12-31',
  });
  assert.match(licence.parseLicence('{').error, /not valid JSON/);
  assert.match(licence.parseLicence('{"seats":0}').error, /seats/);
  assert.match(licence.parseLicence('{"channels":2.5}').error, /channels/);
  assert.match(licence.parseLicence('{"expires":"31-12-2026"}').error, /2026-12-31/);
});

test('state: ok, expiring in the last 14 days (the last day itself still works), expired after it', () => {
  const at = new Date(2026, 9, 14); // 14 Oct 2026
  const lic = (expires) => licence.describe({ seats: 5, channels: 5, expires }, at);
  assert.strictEqual(lic('2026-12-31').state, 'ok');
  assert.strictEqual(lic('2026-10-27').state, 'expiring');
  assert.strictEqual(lic('2026-10-27').daysLeft, 13);
  assert.deepStrictEqual([lic('2026-10-14').state, lic('2026-10-14').daysLeft], ['expiring', 0]);
  assert.deepStrictEqual([lic('2026-10-13').state, lic('2026-10-13').daysLeft], ['expired', -1]);
  assert.strictEqual(lic(null).state, 'ok');
  assert.strictEqual(licence.describe(null).state, 'none');
});

test('lines: refused only when every licensed line is busy; inbound counts itself; Asterisk silent = allowed', async () => {
  write({ channels: 3, expires: '2099-01-01' });
  assert.strictEqual(await licence.lineRefusal(ari(2), 'trunk'), null);
  assert.match(await licence.lineRefusal(ari(3), 'trunk'), /All 3 phone lines are in use/);
  assert.strictEqual(await licence.lineRefusal(ari(3), 'trunk', { extra: 1 }), null); // the 3rd line is this inbound call
  assert.match(await licence.lineRefusal(ari(4), 'trunk', { extra: 1 }), /All 3/);
  assert.strictEqual(await licence.lineRefusal(ari(null), 'trunk'), null);
});

test('expired: every outside call refused with the plain message; no file / broken file = no limits', async (t) => {
  write({ channels: 3, expires: '2020-01-01' });
  assert.strictEqual(licence.isExpired(), true);
  assert.strictEqual(await licence.lineRefusal(ari(0), 'trunk'), licence.EXPIRED_MESSAGE);
  fs.rmSync(file);
  licence._reset();
  assert.strictEqual(licence.getLicence().state, 'none');
  assert.strictEqual(await licence.lineRefusal(ari(99), 'trunk'), null);
  t.mock.method(console, 'error', () => {});
  write('{broken');
  assert.strictEqual(licence.getLicence().state, 'invalid');
  assert.strictEqual(await licence.lineRefusal(ari(99), 'trunk'), null);
});

test("a licence the app can't reach (e.g. its folder is root-only) is 'invalid', not 'none'", (t) => {
  write({ seats: 5 });
  const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'statSync', () => {
    throw err;
  });
  t.mock.method(console, 'error', () => {});
  licence._reset();
  const lic = licence.getLicence();
  assert.strictEqual(lic.state, 'invalid');
  assert.match(lic.error, /EACCES/);
});

test('seats = agents logged in at once: the next agent is refused; the same agent again is not; no seats = no limit', async () => {
  // Logged in: an open status row (agents 1, 2) or the agent screen open (3; 2 counted once).
  const deps = (openIds, screens) => ({
    pool: { query: async () => [openIds.map((user_id) => ({ user_id }))] },
    hub: { connectedUserIds: () => screens },
  });
  const three = deps([1, 2], [2, 3]);
  assert.strictEqual(await seatRefusal({ id: 9 }, three, 4), null);
  const full = await seatRefusal({ id: 9 }, three, 3);
  assert.strictEqual(full.status, 409);
  assert.strictEqual(full.body.code, 'seats_full');
  assert.match(full.body.error, /All 3 agent seats are in use/);
  assert.strictEqual(await seatRefusal({ id: 3 }, three, 3), null); // agent 3 logging in again / taking over
  assert.strictEqual(await seatRefusal({ id: 9 }, deps([], []), 1), null);
  assert.strictEqual(await seatRefusal({ id: 9 }, three, null), null);
});
