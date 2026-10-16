// The lead holds the current version of its form fields; every save is history.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { diffCustom, mergeChanged, adoptCallForms } = require('../src/services/leadData');
const { validateFormData } = require('../src/services/forms');
const { leadHistory } = require('../src/services/leadHistory');

const FIELDS = [
  { field_key: 'budget', label: 'Budget', field_type: 'text', options: null, is_required: 0 },
  { field_key: 'plan', label: 'Plan', field_type: 'dropdown', options: ['Gold', 'Silver'], is_required: 0 },
  { field_key: 'city', label: 'City', field_type: 'text', options: null, is_required: 1 },
];

test("a save changes only the fields this person changed - a stale screen can't undo someone else's edit", () => {
  // The agent's screen loaded Budget 40L; meanwhile the admin set it to 60L. The agent only changed City.
  const current = { budget: '60L', city: 'Chennai' };
  const next = mergeChanged(current, { budget: '40L', city: 'Madurai' }, ['city']);
  assert.deepStrictEqual(next, { budget: '60L', city: 'Madurai' });
  assert.deepStrictEqual(diffCustom(current, next, ['city']), [{ key: 'city', from: 'Chennai', to: 'Madurai' }]);
  // Emptying a field removes it; empty and missing are the same (no fake change).
  assert.deepStrictEqual(mergeChanged(next, { budget: '' }, ['budget']), { city: 'Madurai' });
  assert.deepStrictEqual(diffCustom({ a: '' }, {}), []);
});

test('an old value that no longer fits the form blocks only when that field is changed; required always applies', () => {
  const saved = { plan: 'Platinum', city: 'Chennai' }; // "Platinum" was removed from the dropdown
  assert.deepStrictEqual(validateFormData(FIELDS, { ...saved, budget: '50L' }, ['budget']).data, {
    budget: '50L',
    plan: 'Platinum',
    city: 'Chennai',
  });
  assert.match(validateFormData(FIELDS, saved, ['plan']).error, /Plan" has an invalid choice/);
  assert.match(validateFormData(FIELDS, { budget: '1' }, ['budget']).error, /City" is required/);
  assert.match(validateFormData(FIELDS, saved).error, /invalid choice/); // no list = every field checked, as before
});

test("first call: answers saved before the lead existed become the new lead's, without wiping what it has", async () => {
  const sql = [];
  const db = {
    async query(q, p) {
      sql.push([q.replace(/\s+/g, ' ').trim(), p]);
      if (q.startsWith('SELECT id, data FROM form_responses'))
        return [
          [
            { id: 5, data: { budget: '40L', plan: '' } },
            { id: 6, data: '{"plan":"Gold"}' },
          ],
        ];
      if (q.startsWith('SELECT custom_data FROM leads')) return [[{ custom_data: { city: 'Chennai' } }]];
      return [{ affectedRows: 1 }];
    },
  };
  assert.strictEqual(await adoptCallForms(db, 9, 31), 2);
  assert.deepStrictEqual(sql[1][1], [9, [5, 6]]);
  assert.deepStrictEqual(JSON.parse(sql[3][1][0]), { city: 'Chennai', budget: '40L', plan: 'Gold' });
  assert.strictEqual(await adoptCallForms(db, null, 31), 0);
});

/** A fake database for one customer: lead 21 (campaign 2) + other leads with the same number. */
function historyDb(others, calls = []) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push([sql.replace(/\s+/g, ' '), params]);
      if (sql.includes('WHERE l.id <> ?')) return [others];
      if (sql.includes('FROM leads l'))
        return [
          [{ id: 21, name: 'Ravi', phone: '9003220102', campaign_id: 2, campaign: 'Sales', created_at: new Date() }],
        ];
      if (sql.includes('FROM calls ca')) return [calls];
      if (sql.includes('JOIN form_fields ff')) return [[{ field_key: 'budget', label: 'Budget' }]];
      if (sql.includes('FROM audit_log a') && sql.includes("'leads.edit', 'leads.update'"))
        return [
          [
            {
              at: new Date(),
              username: 'admin',
              action: 'leads.update',
              summary: 'upload october.xlsx',
              before_json: '{"name":"Ravi","custom_data":{"budget":"40L"}}',
              after_json: '{"name":"Ravi K","custom_data":{"budget":"60L"}}',
            },
          ],
        ];
      if (sql.includes('FROM form_responses r'))
        return [
          [
            {
              id: 1,
              lead_id: 21,
              form_id: 4,
              created_at: new Date(),
              data: '{"budget":"60L"}',
              changes: '[{"key":"budget","from":"40L","to":"60L"}]',
              form: 'Loan',
              agent: 'agent1003',
            },
          ],
        ];
      if (sql.includes('FROM form_fields WHERE form_id'))
        return [[{ form_id: 4, field_key: 'budget', label: 'Budget' }]];
      return [[]];
    },
  };
}
const OTHERS = [
  { id: 30, name: 'Ravi', campaign_id: 2, campaign: 'Sales', created_at: new Date(), deleted_at: null },
  { id: 40, name: 'R.', campaign_id: 7, campaign: 'Insurance', created_at: new Date(), deleted_at: null },
];

test('one history per number: other leads the viewer may see are joined, others are not', async () => {
  const d = historyDb(OTHERS);
  await leadHistory(21, { canSee: (cid) => cid === 2 }, { pool: d });
  const [, params] = d.seen.find(([s]) => s.includes('FROM calls ca'));
  assert.deepStrictEqual(params[0], [21, 30]); // lead 40 (Insurance) stays out
  const all = historyDb(OTHERS);
  await leadHistory(21, {}, { pool: all });
  assert.deepStrictEqual(all.seen.find(([s]) => s.includes('FROM calls ca'))[1][0], [21, 30, 40]);
});

test("an agent still sees their own calls from a lead they can't see - without that lead's details", async () => {
  const calls = [{ id: 88, lead_id: 40, start_time: new Date(), agent_connect_time: new Date(), talk_seconds: 30 }];
  const d = historyDb(OTHERS, calls);
  const h = await leadHistory(21, { canSee: (cid) => cid === 2, ownCallsBy: 7 }, { pool: d });
  const [sql, params] = d.seen.find(([s]) => s.includes('FROM calls ca'));
  assert.match(sql, /OR \(ca\.lead_id IN \(\?\) AND ca\.agent_user_id = \?\)/);
  assert.deepStrictEqual(params.slice(2, 4), [[40], 7]);
  const call = h.timeline.find((t) => t.type === 'call');
  assert.deepStrictEqual(call.earlierLead, { id: 40, name: null, campaign: null, deleted: false });
});

test('history says what each save changed: form saves, admin edits and uploads (with the file)', async () => {
  const h = await leadHistory(21, {}, { pool: historyDb([]) });
  const form = h.timeline.find((t) => t.type === 'form');
  assert.deepStrictEqual(form.changes, [{ field: 'Budget', from: '40L', to: '60L' }]);
  const edit = h.timeline.find((t) => t.type === 'edit');
  assert.strictEqual(edit.source, 'upload october.xlsx');
  assert.deepStrictEqual(edit.changes, [
    { field: 'Name', from: 'Ravi', to: 'Ravi K' },
    { field: 'Budget', from: '40L', to: '60L' },
  ]);
});

test("one name per customer: a first call's form Name names a lead that has none (never renames one)", async () => {
  const sql = [];
  const db = {
    async query(q, p) {
      sql.push([q.replace(/\s+/g, ' ').trim(), p]);
      if (q.startsWith('SELECT id, data FROM form_responses'))
        return [[{ id: 5, data: { name: 'Shankar', last_name: 'G' } }]];
      if (q.startsWith('SELECT custom_data FROM leads')) return [[{ custom_data: null }]];
      return [{ affectedRows: 1 }];
    },
  };
  await adoptCallForms(db, 9, 31);
  const [s, p] = sql[3];
  assert.match(s, /name = COALESCE\(NULLIF\(name, ''\), \?\)/); // an existing name wins
  assert.deepStrictEqual([JSON.parse(p[0]), p[1], p[2]], [{ name: 'Shankar', last_name: 'G' }, 'Shankar', 9]);
});
