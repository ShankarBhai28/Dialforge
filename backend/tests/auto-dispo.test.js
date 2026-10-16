// Auto disposition: campaign setting, and the server safety net for calls
// whose agent screen never saved one (browser closed).
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { sweepAutoDispo, NOTE } = require('../src/services/autoDispo');
const { parseCampaignSettings } = require('../src/services/campaigns');
const { DEFAULT_DISPOSITIONS } = require('../src/services/dispositions');

test('setting: 0-600 whole seconds, 0 = off; on needs a disposition; every campaign gets "No Disposition"', () => {
  assert.deepStrictEqual(
    [parseCampaignSettings({}).settings.auto_dispo_sec, parseCampaignSettings({}).settings.auto_dispo_code],
    [0, null],
  );
  const on = parseCampaignSettings({ autoDispoSec: 30, autoDispoCode: 'no_dispo' }).settings;
  assert.deepStrictEqual([on.auto_dispo_sec, on.auto_dispo_code], [30, 'no_dispo']);
  assert.match(parseCampaignSettings({ autoDispoSec: 30 }).error, /pick the disposition/);
  assert.match(parseCampaignSettings({ autoDispoSec: 900, autoDispoCode: 'x' }).error, /0-600 seconds/);
  const nd = DEFAULT_DISPOSITIONS.find((d) => d.code === 'no_dispo');
  assert.deepStrictEqual([nd.label, nd.is_final, nd.retry_after_min], ['No Disposition', 0, 60]); // the customer isn't lost
});

test("safety net: a call nobody dispositioned gets the campaign's auto disposition, recorded as the system's", async () => {
  const sql = [];
  const audits = [];
  const db = {
    async query(q, p) {
      const s = q.replace(/\s+/g, ' ').trim();
      sql.push([s, p]);
      if (s.startsWith('SELECT ca.id, ca.lead_id'))
        return [
          [
            {
              id: 31,
              lead_id: 9,
              campaign_id: 4,
              end_time: new Date(),
              auto_dispo_code: 'no_dispo',
              phone: '9003220102',
            },
          ],
        ];
      return [{ affectedRows: 1 }];
    },
  };
  const n = await sweepAutoDispo({
    pool: db,
    getDispositions: async () => DEFAULT_DISPOSITIONS,
    audit: async (e) => audits.push(e),
  });
  assert.strictEqual(n, 1);
  const [pick] = sql;
  // only answered calls of campaigns with it on, past the time + 60 s grace, not given meanwhile
  assert.match(pick[0], /c\.auto_dispo_sec > 0 AND c\.auto_dispo_code IS NOT NULL/);
  assert.match(pick[0], /ca\.agent_connect_time IS NOT NULL AND ca\.outcome IS NULL/);
  assert.match(pick[0], /INTERVAL \(c\.auto_dispo_sec \+ 60\) SECOND/);
  assert.match(pick[0], /NOT EXISTS \(SELECT 1 FROM audit_log a WHERE a\.action = 'leads\.outcome'/);
  // the lead: not final, next call in 60 min (No Disposition's retry)
  assert.ok(
    sql.some(([s, p]) => /^UPDATE leads SET status = \?/.test(s) && p[0] === 'no_dispo' && p[1] === 0 && p[2] === 60),
  );
  assert.ok(sql.some(([s, p]) => /^UPDATE calls SET outcome = \?/.test(s) && p[0] === 'no_dispo' && p[1] === 31));
  assert.deepStrictEqual(audits[0], {
    user: null,
    action: 'leads.outcome',
    entity: 'leads',
    entityId: 9,
    status: 200,
    summary: 'no_dispo (call 31)',
    request: { status: 'no_dispo', note: NOTE },
  });
});
