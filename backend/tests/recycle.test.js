// finishAttempt + recycle rules (D9) against a fake MySQL pool.
const assert = require('node:assert');
const { test } = require('node:test');
const { finishAttempt, getRecycleRules } = require('../dialer-common.js');

function fakePool({ rules = [], priorCount = 0 }) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^UPDATE dial_attempts SET result/.test(sql.trim())) return [{ affectedRows: 1 }];
      if (/SELECT lead_id, campaign_id, call_id/.test(sql)) return [[{ lead_id: 7, campaign_id: 1, call_id: null }]];
      if (/FROM campaign_recycle_rules/.test(sql)) return [rules];
      if (/COUNT\(\*\) AS n FROM dial_attempts/.test(sql)) return [[{ n: priorCount }]];
      return [{ affectedRows: 1 }];
    },
  };
}
const leadUpdate = (p) => p.log.find((q) => q.sql.startsWith('UPDATE leads'));

let p;
let u;

test('no_answer, defaults (60 min, 3 tries), 1st no-answer -> reschedule 60'.replace(/'/g, "'"), async () => {
  p = fakePool({ priorCount: 1 });
  await finishAttempt(p, 1, 'no_answer', 19);
  u = leadUpdate(p);
  assert(/next_call_at = NOW\(\) \+ INTERVAL \? MINUTE/.test(u.sql));
  assert.deepStrictEqual(u.params, ['no_answer', 60, 7]);
});

test('3rd no-answer -> tries used up -> final'.replace(/'/g, "'"), async () => {
  p = fakePool({ priorCount: 3 });
  await finishAttempt(p, 1, 'no_answer', 19);
  u = leadUpdate(p);
  assert(/is_final = 1/.test(u.sql));
  assert.deepStrictEqual(u.params, ['no_answer', 7]);
});

test('machine uses machine rule + status machine (default 120)'.replace(/'/g, "'"), async () => {
  p = fakePool({ priorCount: 1 });
  await finishAttempt(p, 1, 'machine', null);
  assert.deepStrictEqual(leadUpdate(p).params, ['machine', 120, 7]);
});

test('failed -> congestion rule, status network_error; counts both result names'.replace(/'/g, "'"), async () => {
  p = fakePool({ priorCount: 1 });
  await finishAttempt(p, 1, 'failed', null);
  assert.deepStrictEqual(leadUpdate(p).params, ['network_error', 10, 7]);
  const cnt = p.log.find((q) => /COUNT\(\*\) AS n/.test(q.sql));
  assert.deepStrictEqual(cnt.params[1].sort(), ['congestion', 'failed']);
});

test('customer_hangup -> abandoned rule (2 min)'.replace(/'/g, "'"), async () => {
  p = fakePool({ priorCount: 1 });
  await finishAttempt(p, 1, 'customer_hangup', null);
  assert.deepStrictEqual(leadUpdate(p).params, ['abandoned', 2, 7]);
});

test('campaign rule: busy disabled -> final at once'.replace(/'/g, "'"), async () => {
  p = fakePool({ rules: [{ result: 'busy', enabled: 0, delay_min: 5, max_tries: 5 }], priorCount: 1 });
  await finishAttempt(p, 1, 'busy', 17);
  assert(/is_final = 1/.test(leadUpdate(p).sql));
});

test('campaign rule overrides delay'.replace(/'/g, "'"), async () => {
  p = fakePool({ rules: [{ result: 'busy', enabled: 1, delay_min: 5, max_tries: 5 }], priorCount: 4 });
  await finishAttempt(p, 1, 'busy', 17);
  assert.deepStrictEqual(leadUpdate(p).params, ['busy', 5, 7]);
});

test('invalid -> final invalid_number; connected -> lead untouched'.replace(/'/g, "'"), async () => {
  p = fakePool({});
  await finishAttempt(p, 1, 'invalid', 1);
  assert(/invalid_number/.test(leadUpdate(p).sql));
  p = fakePool({});
  await finishAttempt(p, 1, 'connected', null);
  assert(!leadUpdate(p));
});

test('getRecycleRules fills defaults'.replace(/'/g, "'"), async () => {
  const rules = await getRecycleRules(
    fakePool({ rules: [{ result: 'machine', enabled: 0, delay_min: 30, max_tries: 1 }] }),
    1,
  );
  assert.deepStrictEqual(Object.keys(rules), ['no_answer', 'busy', 'machine', 'congestion', 'abandoned']);
  assert.strictEqual(rules.machine.enabled, 0);
  assert.strictEqual(rules.no_answer.delay_min, 60);
});
