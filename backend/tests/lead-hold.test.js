// A lead being talked to is held from the dialer until its outcome; queue
// sync stays quiet about "not a member" replies.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const amiCalls = [];
let amiFails = null;
fake('db.js', {
  async query(sql) {
    if (sql.includes('FROM queues')) return [[{ asterisk_name: 'autodial_test' }]];
    return [[]];
  },
});
fake('ami.js', {
  queueAdd: async () => amiCalls.push('add'),
  queuePause: async () => {
    if (amiFails) throw new Error(amiFails);
  },
  queueRemove: async () => {
    if (amiFails) throw new Error(amiFails);
  },
});

const { holdLeadForOutcome, OUTCOME_HOLD_MIN } = require('../dialer-common');
const { syncQueueMembership } = require('../src/services/agents');

test('hold: pushes the redial time out (never earlier) and takes the lead out of the ready queue', async () => {
  const sql = [];
  const pool = { query: async (s, p) => (sql.push([s.replace(/\s+/g, ' ').trim(), p]), [{ affectedRows: 1 }]) };
  await holdLeadForOutcome(pool, 9);
  assert.strictEqual(OUTCOME_HOLD_MIN, 30);
  assert.match(
    sql[0][0],
    /SET next_call_at = GREATEST\(COALESCE\(next_call_at, NOW\(\)\), NOW\(\) \+ INTERVAL \? MINUTE\) WHERE id = \? AND is_final = 0/,
  );
  assert.deepStrictEqual(sql[0][1], [30, 9]);
  assert.deepStrictEqual(sql[1], ["DELETE FROM dial_hopper WHERE lead_id = ? AND status = 'ready'", [9]]);
  sql.length = 0;
  await holdLeadForOutcome(pool, null); // a call without a lead: nothing
  assert.strictEqual(sql.length, 0);
});

test("queue sync: 'not a member' replies are expected, real failures still logged", async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  for (const msg of ['Unable to remove interface: Not there', 'Interface not found']) {
    amiFails = msg;
    await syncQueueMembership(5, '1005', 'offline', 10);
    await syncQueueMembership(5, '1005', 'break', 10);
  }
  assert.deepStrictEqual(logged, []);
  amiFails = 'Permission denied';
  await syncQueueMembership(5, '1005', 'offline', 10);
  assert.deepStrictEqual(logged, ['[AMI queue sync failed] Permission denied']);
  amiFails = null;
});
