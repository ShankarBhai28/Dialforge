// Leads -> bulk actions: each action checks the same rules as the one-lead
// screens, only touches leads in the user's teams, and says what it skipped.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { runBulk } = require('../src/services/leadBulk');
const { leadWhere } = require('../src/services/leadFilters');

const ADMIN = { actions: () => ['view', 'create', 'edit', 'delete', 'import', 'recycle', 'export'], scope: null };
const only = (rights, scope = null) => ({ actions: (screen) => rights[screen] || [], scope });

/** A database with these leads (and optional list / agents / dnc / open attempts). */
function world({ leads, lists = [], agents = [], dnc = [], onCall = [] }) {
  const sql = [];
  const pool = {
    async query(q, p = []) {
      const s = q.replace(/\s+/g, ' ').trim();
      sql.push([s, p]);
      if (s.startsWith('SELECT id, phone, campaign_id, status FROM leads WHERE id IN'))
        return [leads.filter((l) => p[0].includes(l.id))];
      if (s.startsWith('SELECT l.id, l.phone, l.campaign_id, l.status FROM leads l')) return [leads];
      if (s.startsWith('SELECT id, name, campaign_id FROM lists')) return [lists.filter((l) => l.id === p[0])];
      if (s.startsWith('SELECT id, username FROM users')) return [agents.filter((a) => a.id === p[0])];
      if (s.startsWith('SELECT phone FROM dnc_numbers')) return [dnc.map((phone) => ({ phone }))];
      if (s.startsWith('SELECT DISTINCT lead_id FROM dial_attempts')) return [onCall.map((lead_id) => ({ lead_id }))];
      if (s.startsWith('UPDATE leads')) return [{ affectedRows: p[p.length - 1].length }];
      return [{ affectedRows: 0 }];
    },
  };
  const calls = { dnc: [], deleted: null };
  const deps = {
    pool,
    addDnc: async (phone) => calls.dnc.push(phone),
    deleteLeads: async (ids) => ((calls.deleted = ids), { leads: ids.length, cancelled: 1 }),
    getDispositions: async (campaignId) => (campaignId === 7 ? [{ code: 'interested' }, { code: 'no_answer' }] : []),
  };
  return { deps, sql, calls };
}
const L = (id, campaign_id = 7, extra = {}) => ({
  id,
  phone: `98400000${id}`.slice(-10),
  campaign_id,
  status: 'new',
  ...extra,
});
const updates = (sql) => sql.filter(([s]) => s.startsWith('UPDATE leads'));
const hopperDrops = (sql) => sql.filter(([s]) => s.startsWith('DELETE FROM dial_hopper'));

test('rights: each action needs its own right; unknown action refused', async () => {
  const { deps } = world({ leads: [L(1)] });
  await assert.rejects(runBulk({ action: 'zap', ids: [1] }, ADMIN, 1, deps), /unknown action/);
  const viewer = only({ leads: ['view', 'edit'] });
  await assert.rejects(
    runBulk({ action: 'reset', ids: [1] }, viewer, 1, deps),
    (e) => e.status === 403 && /recycle/.test(e.message),
  );
  await assert.rejects(runBulk({ action: 'delete', ids: [1] }, viewer, 1, deps), (e) => e.status === 403);
  await assert.rejects(runBulk({ action: 'dnc', ids: [1] }, viewer, 1, deps), /dnc: create/);
});

test("ticked leads outside the user's teams are left out; nothing ticked is refused", async () => {
  const { deps, sql } = world({ leads: [L(1, 7), L(2, 8)] });
  const team = only({ leads: ['view', 'edit'] }, { campaignIds: [7], agentIds: [] });
  const r = await runBulk({ action: 'status', ids: [1, 2], status: 'interested' }, team, 1, deps);
  assert.strictEqual(r.changed, 1);
  assert.deepStrictEqual(updates(sql)[0][1].at(-1), [1]);
  await assert.rejects(runBulk({ action: 'status', ids: [] }, ADMIN, 1, deps), /tick at least one/);
});

test("status: one campaign's outcomes only; leads of several campaigns are refused", async () => {
  const mixed = world({ leads: [L(1, 7), L(2, 8)] });
  await assert.rejects(
    runBulk({ action: 'status', ids: [1, 2], status: 'new' }, ADMIN, 1, mixed.deps),
    /different campaigns/,
  );
  const one = world({ leads: [L(1, 7), L(2, 7)] });
  await assert.rejects(
    runBulk({ action: 'status', ids: [1, 2], status: 'sold' }, ADMIN, 1, one.deps),
    /new or one of: interested, no_answer/,
  );
  const r = await runBulk({ action: 'status', ids: [1, 2], status: 'interested' }, ADMIN, 5, one.deps);
  assert.strictEqual(r.changed, 2);
  // status + what it means (not final here: dialable now), attempts kept, by user 5
  assert.deepStrictEqual(updates(one.sql)[0][1].slice(0, 4), ['interested', 0, 0, 5]);
});

test("move: into a list (and the list's campaign); ready hopper rows go", async () => {
  const w = world({ leads: [L(1, 7), L(2, 8)], lists: [{ id: 30, name: 'Hot', campaign_id: 7 }] });
  await assert.rejects(runBulk({ action: 'move', ids: [1], listId: 99 }, ADMIN, 1, w.deps), /list not found/);
  const r = await runBulk({ action: 'move', ids: [1, 2], listId: 30 }, ADMIN, 1, w.deps);
  assert.strictEqual(r.changed, 2);
  assert.deepStrictEqual(updates(w.sql)[0][1].slice(0, 2), [30, 7]);
  assert.match(r.notes[0], /1 lead now in the list's campaign/);
  assert.strictEqual(hopperDrops(w.sql).length, 1);
});

test('assign: only an active agent in your teams; given leads leave the dialer, unassigning shares them again', async () => {
  const w = world({ leads: [L(1)], agents: [{ id: 4, username: 'agent1004' }] });
  await assert.rejects(runBulk({ action: 'assign', ids: [1], userId: 9 }, ADMIN, 1, w.deps), /only active agents/);
  const team = only({ leads: ['view', 'edit'] }, { campaignIds: [7], agentIds: [3] });
  await assert.rejects(runBulk({ action: 'assign', ids: [1], userId: 4 }, team, 1, w.deps), /isn't in your teams/);
  const r = await runBulk({ action: 'assign', ids: [1], userId: 4 }, ADMIN, 1, w.deps);
  assert.deepStrictEqual(r.notes, ['given to agent1004']);
  assert.strictEqual(updates(w.sql)[0][1][0], 4);
  assert.strictEqual(hopperDrops(w.sql).length, 1);
  const back = world({ leads: [L(1)] });
  const r2 = await runBulk({ action: 'assign', ids: [1], userId: null }, ADMIN, 1, back.deps);
  assert.strictEqual(updates(back.sql)[0][1][0], null);
  assert.strictEqual(hopperDrops(back.sql).length, 0);
  assert.deepStrictEqual(r2.notes, ['shared with the campaign again']);
});

test('make dialable again: like Recycle - skips Do Not Call, DNC numbers and leads on a call', async () => {
  const leads = [L(1), L(2, 7, { status: 'do_not_call' }), L(3), L(4)];
  const w = world({ leads, dnc: [leads[2].phone], onCall: [4] });
  const r = await runBulk({ action: 'reset', ids: [1, 2, 3, 4], resetAttempts: true }, ADMIN, 1, w.deps);
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(r.skipped, 3);
  const [s, p] = updates(w.sql)[0];
  assert.match(s, /is_final = 0, next_call_at = NULL, recycled_at = NOW\(\), attempts = IF\(\?, 0, attempts\)/);
  assert.deepStrictEqual(p.at(-1), [1]);
});

test('DNC: numbers added, leads marked Do Not Call and out of the dialer; delete keeps history', async () => {
  const w = world({ leads: [L(1), L(2)] });
  const dncRight = only({ leads: ['view', 'edit'], dnc: ['view', 'create'] });
  const r = await runBulk({ action: 'dnc', ids: [1, 2] }, dncRight, 1, w.deps);
  assert.strictEqual(w.calls.dnc.length, 2);
  assert.match(updates(w.sql)[0][0], /status = 'do_not_call'/);
  assert.strictEqual(hopperDrops(w.sql).length, 1);
  assert.match(r.notes[0], /2 numbers on the DNC list/);
  const d = await runBulk({ action: 'delete', ids: [1, 2] }, ADMIN, 1, w.deps);
  assert.deepStrictEqual(w.calls.deleted, [1, 2]);
  assert.deepStrictEqual([d.changed, d.notes], [2, ['1 pending callback cancelled']]);
});

test('"all matching": uses the same filters as the Leads table, assigned filter included', async () => {
  const w = world({ leads: [L(1), L(2)] });
  const r = await runBulk(
    { action: 'status', all: true, filters: { campaignId: '7', status: 'new' }, status: 'interested' },
    ADMIN,
    1,
    w.deps,
  );
  assert.strictEqual(r.changed, 2);
  const where = leadWhere({ q: 'Ravi', campaignId: '7', assignedTo: 'none' }, null);
  assert.match(where.sql, /l\.name LIKE \?/);
  assert.match(where.sql, /l\.campaign_id = \?/);
  assert.match(where.sql, /l\.assigned_user_id IS NULL/);
  assert.match(leadWhere({ assignedTo: '4' }, null).sql, /l\.assigned_user_id = \?/);
  assert.match(leadWhere({}, { campaignIds: [7], agentIds: [] }).sql, /l\.campaign_id IN \(\?\)/);
});
