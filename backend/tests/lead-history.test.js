// Customer history: one timeline from calls, outcomes, forms, callbacks, edits.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { leadHistory, findLeadByPhone, formAnswers } = require('../src/services/leadHistory');

const T = (s) => new Date(`2026-10-${s}Z`);
function db(tables) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push([sql.replace(/\s+/g, ' '), params]);
      for (const [needle, rows] of tables) if (sql.includes(needle)) return [rows];
      return [[]];
    },
  };
}

const LEAD = {
  id: 9,
  name: 'Ravi',
  phone: '9840012345',
  alt_phone: null,
  status: 'callback',
  attempts: 3,
  is_final: 0,
  next_call_at: null,
  created_at: T('01T09:00:00'),
  custom_data: '{"city":"Chennai"}',
  campaign_id: 2,
  campaign: 'Sales',
  list: 'Oct list',
};

test('history: calls carry agent, talk, outcome + note; forms, callbacks, edits; newest first', async () => {
  const d = db([
    ['FROM leads l', [LEAD]],
    [
      'FROM calls ca',
      [
        {
          id: 31,
          direction: 'outbound',
          start_time: T('12T10:00:00'),
          end_time: T('12T10:03:00'),
          agent_connect_time: T('12T10:00:20'),
          disposition: 'ended',
          outcome: 'callback',
          outcome_label: 'Call Back',
          from_extension: '1003',
          recorded: 1,
          agent: 'agent1003',
          talk_seconds: 160,
          transferred: 0,
        },
        {
          id: 20,
          direction: 'outbound',
          start_time: T('05T10:00:00'),
          end_time: T('05T10:00:30'),
          agent_connect_time: null,
          disposition: 'no_answer',
          outcome: null,
          from_extension: '1001',
          recorded: 0,
          agent: 'agent1001',
          talk_seconds: null,
          transferred: 0,
        },
      ],
    ],
    [
      "action = 'leads.outcome'",
      [
        {
          at: T('12T10:03:30'),
          username: 'agent1003',
          summary: 'callback (call 31)',
          request_json: '{"note":"after 6","callbackAt":"2026-10-14T12:30:00.000Z"}',
        },
      ],
    ],
    [
      "IN ('leads.edit', 'leads.update')",
      [
        {
          at: T('06T08:00:00'),
          username: 'admin',
          action: 'leads.edit',
          before_json: '{"name":"R","phone":"9840012345"}',
          after_json: '{"name":"Ravi","phone":"9840012345"}',
        },
      ],
    ],
    [
      'FROM form_responses r',
      [
        {
          id: 4,
          form_id: 1,
          call_id: 31,
          created_at: T('12T10:02:00'),
          data: '{"interest":"Home loan","budget":"40L","x":""}',
          form: 'Loan form',
          agent: 'agent1003',
        },
      ],
    ],
    [
      'FROM form_fields',
      [
        { form_id: 1, field_key: 'interest', label: 'Interested in' },
        { form_id: 1, field_key: 'budget', label: 'Budget' },
      ],
    ],
    [
      'FROM callbacks cb',
      [
        {
          id: 3,
          callback_at: T('14T12:30:00'),
          status: 'pending',
          note: 'after 6',
          created_at: T('12T10:03:30'),
          created_by: 'agent1003',
          owner: 'agent1003',
        },
      ],
    ],
  ]);
  const h = await leadHistory(9, { recordingUrl: (id) => `/admin/calls/${id}/recording` }, { pool: d });
  assert.deepStrictEqual(
    h.timeline.map((t) => t.type),
    ['callback', 'form', 'call', 'edit', 'call', 'created'], // the form (10:02) after the call started (10:00),
  );
  const call = h.timeline.find((t) => t.callId === 31 && t.type === 'call');
  assert.deepStrictEqual(
    {
      agent: call.agent,
      result: call.result,
      talk: call.talkSeconds,
      outcome: call.outcome,
      note: call.note,
      rec: call.recordingUrl,
    },
    {
      agent: 'agent1003',
      result: 'Answered',
      talk: 160,
      outcome: 'Call Back',
      note: 'after 6',
      rec: '/admin/calls/31/recording',
    },
  );
  assert.strictEqual(h.timeline.find((t) => t.callId === 20).result, 'No answer');
  assert.deepStrictEqual(h.timeline.find((t) => t.type === 'edit').changes, [{ field: 'Name', from: 'R', to: 'Ravi' }]);
  assert.deepStrictEqual(h.latestForm.answers, [
    { label: 'Interested in', value: 'Home loan' },
    { label: 'Budget', value: '40L' },
  ]);
  assert.deepStrictEqual(
    {
      calls: h.summary.calls,
      answered: h.summary.answered,
      lastSpokeWith: h.summary.lastSpokeWith,
      lastOutcome: h.summary.lastOutcome,
      agents: h.summary.agents,
    },
    { calls: 2, answered: 1, lastSpokeWith: 'agent1003', lastOutcome: 'Call Back', agents: ['agent1003'] },
  );
  assert.deepStrictEqual(h.lead.customData, { city: 'Chennai' });
  // The last answers per form, raw, for filling the agent's form.
  assert.deepStrictEqual(h.formData[1].data, { interest: 'Home loan', budget: '40L', x: '' });
  assert.strictEqual(h.formData[1].agent, 'agent1003');
  // Calls not linked to the lead are found by its number, in every stored form.
  const [, params] = d.seen.find(([s]) => s.includes('FROM calls ca'));
  assert.deepStrictEqual(params[1], ['9840012345', '919840012345', '09840012345', '+919840012345']);
});

test('no recording link without a player route; unknown lead -> null', async () => {
  const d = db([
    ['FROM leads l', [LEAD]],
    [
      'FROM calls ca',
      [
        {
          id: 31,
          start_time: T('12T10:00:00'),
          agent_connect_time: T('12T10:00:20'),
          recorded: 1,
          talk_seconds: 5,
        },
      ],
    ],
  ]);
  const h = await leadHistory(9, {}, { pool: d });
  assert.strictEqual(h.timeline[0].recorded, true);
  assert.strictEqual(h.timeline[0].recordingUrl, undefined);
  assert.strictEqual(await leadHistory(1, {}, { pool: db([]) }), null);
});

test('a caller is matched to a lead by number, this campaign first', async () => {
  const d = db([['FROM leads', [{ id: 77 }]]]);
  assert.strictEqual(await findLeadByPhone('+91 98400 12345', 2, { pool: d }), 77);
  assert.deepStrictEqual(d.seen[0][1], ['9840012345', '9840012345', 2]);
  assert.match(d.seen[0][0], /ORDER BY campaign_id <=> \? DESC/);
  assert.strictEqual(await findLeadByPhone('', 2, { pool: d }), null);
});

test('form answers: field labels in order, unknown keys kept, empties dropped', () => {
  assert.deepStrictEqual(
    formAnswers({ b: 'x', a: ['p', 'q'], z: 'extra', e: '' }, [
      { field_key: 'a', label: 'A' },
      { field_key: 'b', label: 'B' },
      { field_key: 'e', label: 'E' },
    ]),
    [
      { label: 'A', value: 'p, q' },
      { label: 'B', value: 'x' },
      { label: 'z', value: 'extra' },
    ],
  );
});
