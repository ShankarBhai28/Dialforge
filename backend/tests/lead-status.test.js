// An admin's status change does what the outcome means; the dialer can space
// a number across campaigns.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { statusEffect, applyStatus } = require('../src/services/leadStatus');
const { recentlyContacted } = require('../dialer-common');
const { parseCampaignSettings } = require('../src/services/campaigns');

const D = [
  { code: 'sale', label: 'Sale', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'no_answer', label: 'No Answer', is_final: 0, retry_after_min: 60, marks_dnc: 0, is_callback: 0 },
  { code: 'busy_later', label: 'Try later', is_final: 0, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'dnc', label: 'Do Not Call', is_final: 1, retry_after_min: null, marks_dnc: 1, is_callback: 0 },
  { code: 'callback', label: 'Call Back', is_final: 0, retry_after_min: null, marks_dnc: 0, is_callback: 1 },
];

test('status meaning: final = done, retry = later, other = now, New = fresh, DNC blocks, callback refused', () => {
  assert.deepStrictEqual(statusEffect('sale', D), { isFinal: 1, retryMin: null, resetAttempts: false, dnc: false });
  assert.deepStrictEqual(statusEffect('no_answer', D), { isFinal: 0, retryMin: 60, resetAttempts: false, dnc: false });
  assert.deepStrictEqual(statusEffect('busy_later', D), {
    isFinal: 0,
    retryMin: null,
    resetAttempts: false,
    dnc: false,
  });
  assert.deepStrictEqual(statusEffect('new', D), { isFinal: 0, retryMin: null, resetAttempts: true, dnc: false });
  assert.strictEqual(statusEffect('dnc', D).dnc, true);
  assert.match(statusEffect('callback', D).error, /needs a callback date and time/);
  assert.match(statusEffect('gone', D).error, /new or one of: sale, no_answer/);
});

function db() {
  const sql = [];
  return {
    sql,
    async query(q, p) {
      sql.push([q.replace(/\s+/g, ' ').trim(), p]);
      return [{ affectedRows: Array.isArray(p.at(-1)) ? p.at(-1).length : 1 }];
    },
  };
}

test('Sale: done - out of the dialer and any pending callback cancelled', async () => {
  const d = db();
  const r = await applyStatus(d, [{ id: 3, phone: '9840012345' }], 'sale', statusEffect('sale', D), 9, {
    addDnc: async () => true,
  });
  assert.strictEqual(r.changed, 1);
  const [s, p] = d.sql[0];
  assert.match(s, /SET status = \?, is_final = \?, next_call_at = NULL, attempts = IF\(\?, 0, attempts\)/);
  assert.deepStrictEqual(p, ['sale', 1, 0, 9, [3]]);
  assert.ok(d.sql.some(([q]) => q.startsWith('DELETE FROM dial_hopper')));
  assert.ok(d.sql.some(([q]) => /UPDATE callbacks SET status = 'cancelled'/.test(q)));
});

test('back to New: dialable now with attempts reset; a retry outcome waits its minutes; neither touches callbacks', async () => {
  const d = db();
  await applyStatus(d, [{ id: 3, phone: '1' }], 'new', statusEffect('new', D), 9);
  assert.deepStrictEqual(d.sql[0][1], ['new', 0, 1, 9, [3]]);
  const d2 = db();
  await applyStatus(d2, [{ id: 3, phone: '1' }], 'no_answer', statusEffect('no_answer', D), 9);
  assert.match(d2.sql[0][0], /next_call_at = NOW\(\) \+ INTERVAL \? MINUTE/);
  assert.deepStrictEqual(d2.sql[0][1], ['no_answer', 0, 60, 0, 9, [3]]);
  assert.strictEqual(d.sql.length + d2.sql.length, 2);
});

test('a DNC outcome puts each number on the DNC list once', async () => {
  const added = [];
  const d = db();
  const leads = [
    { id: 1, phone: '+91 98400 12345' },
    { id: 2, phone: '9840012345' },
  ];
  const r = await applyStatus(d, leads, 'dnc', statusEffect('dnc', D), 9, { addDnc: async (p) => added.push(p) });
  assert.deepStrictEqual(added, ['9840012345']);
  assert.strictEqual(r.dnc, 1);
});

test('spacing across campaigns: numbers another campaign dialled, or in a call outside this campaign, lately', async () => {
  const seen = [];
  const fakeDb = {
    async query(q, p) {
      seen.push([q.replace(/\s+/g, ' ').trim(), p]);
      if (q.includes('FROM dial_attempts')) return [[{ phone: '9840000001' }]];
      return [[{ to_number: '919840000002' }]];
    },
  };
  const got = await recentlyContacted(fakeDb, ['9840000001', '9840000002', '9840000003'], 7, 4);
  assert.deepStrictEqual([...got].sort(), ['9840000001', '9840000002']);
  assert.match(seen[0][0], /campaign_id <> \? AND started_at > NOW\(\) - INTERVAL \? HOUR/);
  assert.deepStrictEqual(seen[0][1].slice(0, 2), [7, 4]);
  assert.ok(seen[1][1][2].includes('+919840000003'), 'calls are matched in every stored format');
  assert.strictEqual((await recentlyContacted(fakeDb, ['1'], 7, 0)).size, 0); // off
});

test('campaign setting: 0-168 whole hours, 0 (off) by default', () => {
  assert.strictEqual(parseCampaignSettings({}).settings.number_gap_hours, 0);
  assert.strictEqual(parseCampaignSettings({ numberGapHours: 4 }).settings.number_gap_hours, 4);
  assert.match(parseCampaignSettings({ numberGapHours: 200 }).error, /0-168 hours/);
  assert.match(parseCampaignSettings({ numberGapHours: 1.5 }).error, /0-168 hours/);
});

test('campaign setting: Live Agents warnings - break amber 10 / red 15 min, wrap-up + 60 s by default', () => {
  const { settings } = parseCampaignSettings({});
  assert.strictEqual(settings.break_warn_min, 10);
  assert.strictEqual(settings.break_alert_min, 15);
  assert.strictEqual(settings.acw_warn_sec, 60);
  const s = parseCampaignSettings({ breakWarnMin: 5, breakAlertMin: 5, acwWarnSec: 10 }).settings;
  assert.deepStrictEqual([s.break_warn_min, s.break_alert_min, s.acw_warn_sec], [5, 5, 10]);
  assert.match(parseCampaignSettings({ breakWarnMin: 0 }).error, /break warning/);
  assert.match(parseCampaignSettings({ breakWarnMin: 20, breakAlertMin: 15 }).error, /from the break warning/);
  assert.match(parseCampaignSettings({ acwWarnSec: 2.5 }).error, /wrap-up warning/);
});
