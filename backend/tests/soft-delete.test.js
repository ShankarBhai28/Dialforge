// "Delete always works, history kept": what each delete unlinks, in one
// transaction, and what it reports - against a fake connection.
const assert = require('node:assert');
const { test } = require('node:test');
const {
  deleteCampaign,
  deleteExtension,
  deleteForm,
  deleteLead,
  deleteQueue,
  deleteRole,
} = require('../src/services/softDelete');

/** answers(sql) -> rows array or { affectedRows }. Records every statement and commit / rollback. */
function fakePool(answers) {
  const log = [];
  const conn = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push([s, params]);
      const a = answers(s);
      return [a ?? { affectedRows: 0 }];
    },
    beginTransaction: async () => log.push(['BEGIN']),
    commit: async () => log.push(['COMMIT']),
    rollback: async () => log.push(['ROLLBACK']),
    release: () => {},
  };
  return { log, deps: { pool: { getConnection: async () => conn } } };
}
const ran = (log, re) => log.some(([s]) => re.test(s));

test('campaign: dialer stopped, DIDs / teams unlinked, its lists + leads go with it, callbacks cancelled', async () => {
  const { log, deps } = fakePool((s) => {
    if (s.startsWith('SELECT id FROM campaigns')) return [{ id: 5 }];
    if (s.startsWith('UPDATE dids')) return { affectedRows: 2 };
    if (s.startsWith('DELETE FROM team_campaigns')) return { affectedRows: 1 };
    if (s.startsWith('UPDATE lists')) return { affectedRows: 3 };
    if (s.startsWith('UPDATE callbacks')) return { affectedRows: 1 };
    if (s.startsWith('UPDATE leads')) return { affectedRows: 120 };
    return null;
  });
  const notes = await deleteCampaign(5, 1, deps);
  assert.deepStrictEqual(notes, [
    '3 lists and 120 leads removed with it',
    '2 DID numbers no longer route to it',
    'taken off 1 team',
    '1 pending callback cancelled',
  ]);
  assert.ok(
    ran(log, /UPDATE campaigns SET deleted_at = NOW\(\), deleted_by = \?, dialer_state = 'stopped', status = 'paused'/),
  );
  assert.ok(ran(log, /DELETE FROM dial_hopper/));
  assert.ok(!ran(log, /^DELETE FROM campaigns/)); // the row stays for history
  assert.deepStrictEqual(log[0], ['BEGIN']);
  assert.deepStrictEqual(log.at(-1), ['COMMIT']);
});

test('not found / already deleted -> null, nothing changed', async () => {
  const { log, deps } = fakePool(() => []);
  assert.strictEqual(await deleteCampaign(9, 1, deps), null);
  assert.strictEqual(await deleteLead(9, 1, deps), null);
  assert.ok(!ran(log, /^UPDATE/));
});

test('queue / form: campaigns using it lose it (named in the notes)', async () => {
  let p = fakePool((s) => {
    if (s.startsWith('SELECT id FROM queues')) return [{ id: 2 }];
    if (s.startsWith('SELECT name FROM campaigns')) return [{ name: 'Sales' }, { name: 'Support' }];
    return null;
  });
  assert.deepStrictEqual(await deleteQueue(2, 1, p.deps), ['Sales, Support no longer have a queue']);
  assert.ok(ran(p.log, /UPDATE campaigns SET queue_id = NULL, dialer_state = 'stopped' WHERE queue_id = \?/));

  p = fakePool((s) => {
    if (s.startsWith('SELECT id FROM forms')) return [{ id: 4 }];
    if (s.startsWith('SELECT name FROM campaigns')) return [];
    return null;
  });
  assert.deepStrictEqual(await deleteForm(4, 1, p.deps), []);
  assert.ok(ran(p.log, /UPDATE forms SET deleted_at = NOW\(\)/));
});

test('extension / role: users lose it and are returned so their sessions can be ended; a role is really deleted', async () => {
  let p = fakePool((s) => {
    if (s.startsWith('SELECT id FROM extensions')) return [{ id: 3 }];
    if (s.startsWith('SELECT id, username FROM users')) return [{ id: 7, username: 'agent04' }];
    return null;
  });
  assert.deepStrictEqual(await deleteExtension(3, 1, p.deps), {
    notes: ['agent04 no longer has an extension'],
    userIds: [7],
  });
  assert.ok(ran(p.log, /UPDATE extensions SET deleted_at = NOW\(\)/));

  p = fakePool((s) => {
    if (s.startsWith('SELECT id FROM roles')) return [{ id: 5 }];
    if (s.startsWith('SELECT id, username FROM users')) return [{ id: 30, username: 'tl.ravi' }];
    return null;
  });
  const r = await deleteRole(5, p.deps);
  assert.deepStrictEqual(r.userIds, [30]);
  assert.ok(ran(p.log, /^DELETE FROM roles WHERE id = \?/));
});

test('a failure rolls everything back', async () => {
  const { log, deps } = fakePool((s) => {
    if (s.startsWith('SELECT id FROM leads')) return [{ id: 1 }];
    if (s.startsWith('UPDATE leads')) throw new Error('db gone');
    return null;
  });
  await assert.rejects(deleteLead(1, 1, deps), /db gone/);
  assert.deepStrictEqual(log.at(-1), ['ROLLBACK']);
});
