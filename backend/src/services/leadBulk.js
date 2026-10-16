// Bulk actions on leads (Leads -> tick rows, or "all N matching these
// filters"): change status, move to a list, make dialable again, give to an
// agent, add to DNC, delete. Each action checks the same things the
// one-lead screens do; leads outside the user's teams are never touched.
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { getDispositions } = require('./dispositions');
const { addDnc } = require('./dnc');
const { campaignInScope, can } = require('./access');
const { leadWhere } = require('./leadFilters');
const { deleteLeads } = require('./softDelete');
const { applyStatus, statusEffect } = require('./leadStatus');
const { applyRecycle, planRecycle, skippedNotes } = require('./recycle');

const MAX_LEADS = 50000;
const CHUNK = 1000;

/** Which right each action needs (leads screen unless noted). */
const RIGHTS = {
  status: [['leads', 'edit']],
  move: [['leads', 'edit']],
  assign: [['leads', 'edit']],
  reset: [['leads', 'recycle']],
  dnc: [
    ['leads', 'edit'],
    ['dnc', 'create'],
  ],
  delete: [['leads', 'delete']],
};

const err = (status, message) => Object.assign(new Error(message), { status });
const chunks = (ids) =>
  Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The leads a request means: ticked ids, or every lead matching the filters. Only live leads in scope. */
async function targetLeads(body, scope, db) {
  let rows;
  if (body.all) {
    const where = leadWhere(body.filters || {}, scope);
    [rows] = await db.query(
      `SELECT l.id, l.phone, l.campaign_id, l.status FROM leads l ${where.sql} ORDER BY l.id LIMIT ?`,
      [...where.params, MAX_LEADS + 1],
    );
  } else {
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (!ids.length) throw err(400, 'tick at least one lead');
    if (ids.length > MAX_LEADS) throw err(400, `at most ${MAX_LEADS.toLocaleString('en-IN')} leads at once`);
    rows = [];
    for (const part of chunks(ids)) {
      const [r] = await db.query(
        'SELECT id, phone, campaign_id, status FROM leads WHERE id IN (?) AND deleted_at IS NULL',
        [part],
      );
      rows.push(...r);
    }
    rows = rows.filter((r) => campaignInScope(scope, r.campaign_id));
  }
  if (rows.length > MAX_LEADS)
    throw err(400, `more than ${MAX_LEADS.toLocaleString('en-IN')} leads match - narrow the filters first`);
  if (!rows.length) throw err(400, 'no leads to change');
  return rows;
}

/** Ready (not yet dialled) hopper rows of these leads go: the dialer re-reads them by the new rules. */
async function dropFromHopper(db, ids) {
  for (const part of chunks(ids))
    await db.query("DELETE FROM dial_hopper WHERE lead_id IN (?) AND status = 'ready'", [part]);
}

async function updateIds(db, sql, params, ids) {
  let n = 0;
  for (const part of chunks(ids)) {
    const [r] = await db.query(`${sql} WHERE id IN (?)`, [...params, part]);
    n += r.affectedRows;
  }
  return n;
}

/**
 * Runs one bulk action. body: { action, ids | all + filters, status, listId, userId, resetAttempts }.
 * Returns { action, changed, skipped, notes }.
 */
async function runBulk(body, access, userId, deps = { pool, addDnc, deleteLeads, getDispositions }) {
  const db = deps.pool;
  const action = body && body.action;
  if (!RIGHTS[action]) throw err(400, 'unknown action');
  const missing = RIGHTS[action].find(([screen, act]) => !can(access, screen, act));
  if (missing) throw err(403, `your role doesn't allow this (${missing[0]}: ${missing[1]})`);

  const leads = await targetLeads(body, access.scope, db);
  const ids = leads.map((l) => l.id);
  const notes = [];

  if (action === 'status') {
    const status = String(body.status || '');
    const campaigns = [...new Set(leads.map((l) => l.campaign_id ?? null))];
    if (campaigns.length > 1)
      throw err(
        400,
        'these leads are in different campaigns - filter one campaign to change status (each has its own outcomes)',
      );
    // Does what the outcome means, like the agent's outcome (services/leadStatus.js).
    const effect = statusEffect(status, await deps.getDispositions(campaigns[0]));
    if (effect.error) throw err(400, effect.error);
    const r = await applyStatus(db, leads, status, effect, userId, { addDnc: deps.addDnc });
    if (effect.isFinal) notes.push('done - no more calls');
    else if (effect.retryMin) notes.push(`dialable again in ${effect.retryMin} min`);
    else notes.push(effect.resetAttempts ? 'dialable now, attempts reset' : 'dialable now');
    if (r.dnc) notes.push(`${plural(r.dnc, 'number')} on the DNC list`);
    return { action, changed: r.changed, skipped: 0, notes };
  }

  if (action === 'move') {
    const [[list]] = await db.query('SELECT id, name, campaign_id FROM lists WHERE id = ? AND deleted_at IS NULL', [
      Number(body.listId) || 0,
    ]);
    if (!list) throw err(400, 'list not found');
    if (!campaignInScope(access.scope, list.campaign_id))
      throw err(400, "that list's campaign isn't one of your teams'");
    const changed = await updateIds(
      db,
      'UPDATE leads SET list_id = ?, campaign_id = ?, updated_by = ?',
      [list.id, list.campaign_id, userId],
      ids,
    );
    await dropFromHopper(db, ids);
    const moved = leads.filter((l) => l.campaign_id !== list.campaign_id).length;
    if (moved) notes.push(`${plural(moved, 'lead')} now in the list's campaign`);
    return { action, changed, skipped: 0, notes };
  }

  if (action === 'assign') {
    let agent = null;
    if (body.userId) {
      const [[u]] = await db.query(
        "SELECT id, username FROM users WHERE id = ? AND role = 'agent' AND status = 'active'",
        [Number(body.userId)],
      );
      if (!u) throw err(400, 'agent not found (only active agents can be given leads)');
      if (access.scope && !access.scope.agentIds.includes(u.id)) throw err(400, "that agent isn't in your teams");
      agent = u;
    }
    const changed = await updateIds(
      db,
      'UPDATE leads SET assigned_user_id = ?, updated_by = ?',
      [agent ? agent.id : null, userId],
      ids,
    );
    // Given to one agent: the dialer leaves them to that agent.
    if (agent) await dropFromHopper(db, ids);
    notes.push(agent ? `given to ${agent.username}` : 'shared with the campaign again');
    return { action, changed, skipped: 0, notes };
  }

  if (action === 'reset') {
    // Same rules as Recycle (services/recycle.js): never DNC / Do Not Call, a
    // lead on a call or in wrap-up, one with a pending callback, or one out of
    // attempts unless they are reset.
    const campaignIds = [...new Set(leads.map((l) => l.campaign_id).filter(Boolean))];
    const [caps] = campaignIds.length
      ? await db.query('SELECT id, max_attempts FROM campaigns WHERE id IN (?)', [campaignIds])
      : [[]];
    const cap = new Map(caps.map((c) => [c.id, Number(c.max_attempts)]));
    const full = [];
    for (const part of chunks(ids)) {
      const [r] = await db.query('SELECT id, phone, status, attempts, campaign_id FROM leads WHERE id IN (?)', [part]);
      full.push(...r);
    }
    const plan = await planRecycle(db, full, {
      resetAttempts: !!body.resetAttempts,
      maxAttempts: (cid) => cap.get(cid) ?? 3,
    });
    const changed = await applyRecycle(db, plan.ids, { resetAttempts: !!body.resetAttempts, userId });
    const skipped = leads.length - plan.ids.length;
    notes.push(...skippedNotes(plan.skipped));
    return { action, changed, skipped, notes };
  }

  if (action === 'dnc') {
    const phones = [...new Set(leads.map((l) => normalizePhone(l.phone)).filter(Boolean))];
    for (const p of phones) await deps.addDnc(p, 'leads', userId);
    const changed = await updateIds(db, "UPDATE leads SET status = 'do_not_call', updated_by = ?", [userId], ids);
    await dropFromHopper(db, ids);
    notes.push(`${plural(phones.length, 'number')} on the DNC list`);
    return { action, changed, skipped: 0, notes };
  }

  // delete: like one-by-one delete - history kept, pending callbacks cancelled.
  const r = await deps.deleteLeads(ids, userId);
  if (r.cancelled) notes.push(`${plural(r.cancelled, 'pending callback')} cancelled`);
  return { action, changed: r.leads, skipped: 0, notes };
}

module.exports = { runBulk, targetLeads, MAX_LEADS, RIGHTS };
