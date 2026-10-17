const express = require('express');
const { deleteLead } = require('../services/softDelete');
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { requirePermission, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');
const { agentCallCondition, findAgentCall } = require('../services/calls');
const { getDispositions } = require('../services/dispositions');
const { addDnc, isDnc } = require('../services/dnc');
const { audit } = require('../services/audit');
const { pageResult, parsePaging, whereClause } = require('../services/paging');
const { leadWhere } = require('../services/leadFilters');
const { runBulk } = require('../services/leadBulk');
const { exportLeads } = require('../services/leadExport');
const { applyStatus, statusEffect } = require('../services/leadStatus');
const { NAME_KEY, adoptCallForms, mergeChanged, parseCustom } = require('../services/leadData');
const {
  LEAD_BASE_COLUMNS,
  applyCustomEdits,
  getCampaignFormFields,
  readLeadUpload,
  receiveLeadFile,
} = require('../services/leadImport');

const { campaignInScope, can, scopeCondition } = require('../services/access');
const { agentCanSeeLead, deletedLeadFor, leadHistory, numberCheck } = require('../services/leadHistory');
const {
  DEFAULT_SCOPE,
  DUP_SCOPES,
  findCampaignMatches,
  findExisting,
  getReport,
  planImport,
  reportWorkbook,
  saveReport,
} = require('../services/leadDedupe');

const router = express.Router();

const PHONE_RE = /^\+?[0-9]{7,15}$/;

// --- Leads (campaign-scoped for agents - admins see everything) ---
router.get('/leads', requireCaller, async (req, res) => {
  if (req.session.user.role === 'admin') {
    const [rows] = await pool.query(`
      SELECT l.*, c.name AS campaign_name, ls.name AS list_name
      FROM leads l
      LEFT JOIN campaigns c ON c.id = l.campaign_id
      LEFT JOIN lists ls ON ls.id = l.list_id
      WHERE l.deleted_at IS NULL
      ORDER BY l.id DESC LIMIT 200
    `);
    return res.json(rows);
  }
  // Agents: their campaign's shared leads, plus every lead given to them
  // (any campaign) first. Leads given to another agent are theirs alone.
  const me = req.session.user.id;
  const campaign = await findCurrentCampaign(me);
  const [rows] = await pool.query(
    `SELECT l.*, (l.assigned_user_id <=> ?) AS mine FROM leads l
     WHERE l.deleted_at IS NULL
       AND (l.assigned_user_id = ? OR (l.campaign_id = ? AND l.assigned_user_id IS NULL))
     ORDER BY mine DESC, l.id DESC LIMIT 100`,
    [me, me, campaign ? campaign.id : -1],
  );
  res.json(rows.map((r) => ({ ...r, mine: !!Number(r.mine) })));
});

// --- Admin: every lead, searched and paged on the server ---
// Filters: services/leadFilters.js (&page= &pageSize= here).
router.get('/admin/leads', requirePermission('leads', 'view'), async (req, res) => {
  const paging = parsePaging(req.query);
  const { campaignId } = req.query;
  const where = leadWhere(req.query, req.access.scope);
  const [rows] = await pool.query(
    `SELECT l.*, c.name AS campaign_name, ls.name AS list_name, au.username AS assigned_to
     FROM leads l
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN lists ls ON ls.id = l.list_id
     LEFT JOIN users au ON au.id = l.assigned_user_id
     ${where.sql}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...where.params, paging.pageSize, paging.offset],
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM leads l ${where.sql}`, where.params);
  // Statuses present (for the filter), within the chosen campaign if any.
  const scope = whereClause([
    ['deleted_at IS NULL', []],
    [campaignId === 'none' ? 'campaign_id IS NULL' : campaignId ? 'campaign_id = ?' : '', [campaignId]],
    scopeCondition(req.access.scope, 'campaigns', 'campaign_id'),
  ]);
  const [statuses] = await pool.query(`SELECT DISTINCT status FROM leads ${scope.sql} ORDER BY status`, scope.params);
  res.json({ ...pageResult(rows, count.n, paging), statuses: statuses.map((s) => s.status) });
});

router.post('/leads', requireCaller, async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  let campaignId = null;
  if (req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    campaignId = campaign ? campaign.id : null;
  }
  const [result] = await pool.query('INSERT INTO leads (tenant_id, phone, name, campaign_id) VALUES (1, ?, ?, ?)', [
    phone,
    name || null,
    campaignId,
  ]);
  const [rows] = await pool.query('SELECT * FROM leads WHERE id = ?', [result.insertId]);
  res.status(201).json(rows[0]);
});

// --- Lead disposition: the actual outcome of a call, set by the agent
// right after it ends. What it does comes from the campaign's own
// disposition config: final (lead done), retry after N minutes, schedule a
// callback, and/or add the number to the DNC list (click2call then refuses it).
// --- Customer history (services/leadHistory.js) ---
// Agent screen: a lead of the campaign they're working, or one they have
// talked to before (agentCanSeeLead). Recordings play from /agent/calls/:id/recording.
// A deleted lead (e.g. its list was deleted) still opens - read-only, with
// its history ("delete always works, history kept"); the screen says so.
async function leadForAgent(req, res) {
  const [rows] = await pool.query(
    `SELECT l.*, ls.name AS list_name FROM leads l LEFT JOIN lists ls ON ls.id = l.list_id WHERE l.id = ?`,
    [Number(req.params.id)],
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'lead not found' });
    return null;
  }
  if (!(await agentCanSeeLead(req.session.user, rows[0], findCurrentCampaign))) {
    res.status(403).json({ error: 'that lead is not in your current campaign' });
    return null;
  }
  return rows[0];
}

// Before calling a typed number: DNC? an active lead? only a deleted lead
// (then the screen asks "call anyway?" - once the number has an active
// lead again, re-imported or created by the next outcome, it doesn't ask).
router.get('/agent/number-check', requireCaller, async (req, res) => {
  res.json(await numberCheck(String(req.query.phone || ''), req.session.user, { isDnc, findCurrentCampaign }));
});

// The lead itself (opening it from the call log).
router.get('/agent/leads/:id', requireCaller, async (req, res) => {
  const lead = await leadForAgent(req, res);
  if (lead) res.json(lead);
});

router.get('/agent/leads/:id/history', requireCaller, async (req, res) => {
  const lead = await leadForAgent(req, res);
  if (!lead) return;
  // Other leads with this number: the agent's current campaign (or none) only; their own calls always.
  const campaign = await findCurrentCampaign(req.session.user.id);
  res.json(
    await leadHistory(lead.id, {
      recordingUrl: (id) => `/agent/calls/${id}/recording`,
      canSee: (cid) => cid == null || (campaign && cid === campaign.id) || req.session.user.role !== 'agent',
      ownCallsBy: req.session.user.id,
    }),
  );
});

// Admin side (Leads -> History): with recordings to play for roles that may.
router.get('/admin/leads/:id/history', requirePermission('leads', 'view'), async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT id, campaign_id FROM leads WHERE id = ?', [id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'lead not found' });
  const canPlay = can(req.access, 'calls', 'recordings');
  res.json(
    await leadHistory(id, {
      recordingUrl: canPlay ? (callId) => `/admin/calls/${callId}/recording` : null,
      canSee: (cid) => campaignInScope(req.access.scope, cid),
    }),
  );
});

router.post('/leads/:id/disposition', requireCaller, async (req, res) => {
  const [leadRows] = await pool.query('SELECT id, phone, campaign_id, status FROM leads WHERE id = ?', [req.params.id]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  if (req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    // Another campaign's lead: only for a call of that lead this agent had
    // (a disposition given later from the call log, after changing campaign).
    const ownCall =
      lead.campaign_id && (!campaign || campaign.id !== lead.campaign_id) && req.body.callId
        ? await findAgentCall(req.session.user.id, req.body.callId)
        : null;
    if (
      lead.campaign_id &&
      (!campaign || campaign.id !== lead.campaign_id) &&
      !(ownCall && ownCall.lead_id === lead.id)
    ) {
      return res.status(403).json({ error: 'that lead is not in your current campaign' });
    }
  }
  return saveDisposition(req, res, lead);
});

// --- Outcome of a call that has no lead (a number typed on the dialpad, an
// unknown inbound caller): every call gets an outcome. The number becomes a
// lead in the call's campaign - or the lead already there with that number
// is used - the call is linked to it, and the outcome is saved on it like
// any lead's. Only the agent who had the call may do this.
router.post('/agent/calls/:callId/disposition', requireCaller, async (req, res) => {
  // This agent's call - also one from an earlier shift on another device.
  const [mine, mineParams] = agentCallCondition(req.session.user.id);
  const [callRows] = await pool.query(
    `SELECT ca.id, ca.lead_id, ca.to_number, ca.campaign_id FROM calls ca WHERE ca.id = ? AND ${mine}`,
    [req.params.callId, ...mineParams],
  );
  const call = callRows[0];
  if (!call) return res.status(404).json({ error: 'call not found' });
  if (call.lead_id) {
    const [rows] = await pool.query('SELECT id, phone, campaign_id, status FROM leads WHERE id = ?', [call.lead_id]);
    if (rows[0]) return saveDisposition(req, res, rows[0]);
  }
  let campaignId = call.campaign_id;
  if (!campaignId && req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    campaignId = campaign ? campaign.id : null;
  }
  const phone = normalizePhone(call.to_number);
  if (!phone) return res.status(400).json({ error: 'this call has no number to save the outcome on' });
  // Check the outcome before creating anything, so a bad request leaves no lead behind.
  const codes = (await getDispositions(campaignId)).map((x) => x.code);
  if (!codes.includes(req.body.status))
    return res.status(400).json({ error: `status must be one of: ${codes.join(', ')}` });

  const [existing] = await pool.query(
    'SELECT id, phone, campaign_id, status FROM leads WHERE phone = ? AND campaign_id <=> ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    [phone, campaignId],
  );
  let lead = existing[0];
  if (!lead) {
    // The number belonged to a deleted lead (the agent confirmed "call
    // anyway"): the new lead takes over its name and details, so the
    // customer isn't a blank row; its history shows the earlier calls too.
    const old = await deletedLeadFor(phone);
    const [result] = await pool.query(
      'INSERT INTO leads (tenant_id, phone, alt_phone, name, priority, custom_data, campaign_id) VALUES (1, ?, ?, ?, ?, ?, ?)',
      [
        phone,
        old ? old.alt_phone : null,
        old ? old.name : null,
        old ? old.priority || 0 : 0,
        old && old.custom_data
          ? typeof old.custom_data === 'string'
            ? old.custom_data
            : JSON.stringify(old.custom_data)
          : null,
        campaignId,
      ],
    );
    lead = { id: result.insertId, phone, campaign_id: campaignId, status: 'new' };
  }
  await pool.query('UPDATE calls SET lead_id = ? WHERE id = ? AND lead_id IS NULL', [lead.id, call.id]);
  // Answers saved during this call, before the lead existed, are the lead's now.
  await adoptCallForms(pool, lead.id, call.id);
  return saveDisposition(req, res, lead);
});

/**
 * The call an outcome belongs to: the route's call, else the call id the
 * agent screen sent - if it is this lead's and was this agent's - else this
 * agent's latest call to the lead in the last 12 hours.
 */
async function outcomeCallId(conn, req, leadId) {
  if (req.params.callId) return Number(req.params.callId);
  const ext = req.session.user.extensionName || '';
  const mine = '(agent_user_id = ? OR from_extension = ? OR transfer_ext = ?)';
  const who = [req.session.user.id, ext, ext];
  const asked = Number(req.body.callId);
  if (Number.isInteger(asked) && asked > 0) {
    const [rows] = await conn.query(`SELECT id FROM calls WHERE id = ? AND lead_id = ? AND ${mine}`, [
      asked,
      leadId,
      ...who,
    ]);
    if (rows[0]) return rows[0].id;
  }
  const [rows] = await conn.query(
    `SELECT id FROM calls WHERE lead_id = ? AND ${mine} AND start_time > NOW() - INTERVAL 12 HOUR ORDER BY id DESC LIMIT 1`,
    [leadId, ...who],
  );
  return rows[0] ? rows[0].id : null;
}

/** Applies the agent's outcome to a lead (shared by both routes above). */
async function saveDisposition(req, res, lead) {
  const { status, callbackAt, callbackMine, note } = req.body;
  const dispositions = await getDispositions(lead.campaign_id);
  const d = dispositions.find((x) => x.code === status);
  if (!d)
    return res.status(400).json({ error: `status must be one of: ${dispositions.map((x) => x.code).join(', ')}` });

  let nextCallAt = null;
  let when = null;
  if (d.is_callback) {
    when = new Date(callbackAt);
    if (!callbackAt || Number.isNaN(when.getTime()))
      return res.status(400).json({ error: 'pick a callback date and time' });
    if (when < new Date(Date.now() - 60 * 1000)) return res.status(400).json({ error: 'callback time is in the past' });
    if (when > new Date(Date.now() + 90 * 24 * 3600 * 1000))
      return res.status(400).json({ error: 'callback must be within 90 days' });
    nextCallAt = when;
  } else if (d.retry_after_min) {
    nextCallAt = new Date(Date.now() + d.retry_after_min * 60 * 1000);
  }

  let callId = null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE leads SET status = ?, updated_by = ?, is_final = ?, next_call_at = ? WHERE id = ?', [
      d.code,
      req.session.user.id,
      d.is_final ? 1 : 0,
      nextCallAt,
      lead.id,
    ]);
    // The outcome of THIS call too (the lead keeps only its latest): reports.
    callId = await outcomeCallId(conn, req, lead.id);
    if (callId) {
      await conn.query(
        'UPDATE calls SET outcome = ?, outcome_at = NOW(), agent_user_id = COALESCE(agent_user_id, ?) WHERE id = ?',
        [d.code, req.session.user.role === 'agent' ? req.session.user.id : null, callId],
      );
    }
    // Any earlier pending callback for this lead is now handled.
    await conn.query("UPDATE callbacks SET status = 'done' WHERE lead_id = ? AND status = 'pending'", [lead.id]);
    if (d.is_callback) {
      await conn.query(
        'INSERT INTO callbacks (tenant_id, lead_id, campaign_id, user_id, callback_at, note, created_by) VALUES (1, ?, ?, ?, ?, ?, ?)',
        [
          lead.id,
          lead.campaign_id,
          callbackMine ? req.session.user.id : null,
          when,
          note ? String(note).slice(0, 255) : null,
          req.session.user.id,
        ],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[disposition failed]', err);
    return res.status(500).json({ error: 'failed to save disposition' });
  } finally {
    conn.release();
  }
  if (d.marks_dnc) await addDnc(lead.phone, 'disposition', req.session.user.id);
  // The lead keeps only its latest status; this keeps every outcome given.
  void audit({
    user: req.session.user,
    action: 'leads.outcome',
    entity: 'leads',
    entityId: lead.id,
    status: 200,
    summary: `${d.code}${callId ? ` (call ${callId})` : ''}`,
    request: { status, callbackAt: callbackAt || undefined, callbackMine, note },
    before: { status: lead.status ?? null },
    after: { status: d.code, next_call_at: nextCallAt, is_final: d.is_final ? 1 : 0 },
    ip: req.ip,
  });
  res.json({ status: 'ok', leadId: lead.id });
}

// --- Admin: full lead edit/delete (distinct from the agent-facing
// disposition endpoint above, which only ever touches status) ---
router.put('/admin/leads/:id', requirePermission('leads', 'edit'), async (req, res) => {
  const { name, phone, status } = req.body;
  const campaignId = req.body.campaignId ? Number(req.body.campaignId) : null;
  const listId = req.body.listId ? Number(req.body.listId) : null;
  if (!phone || !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'a valid phone is required' });
  }
  // altPhone / priority left out = unchanged ('' clears the alt phone).
  const altPhone = req.body.altPhone === undefined ? undefined : req.body.altPhone || null;
  if (altPhone && !PHONE_RE.test(altPhone)) {
    return res.status(400).json({ error: 'alt phone must be 7-15 digits, optional leading +' });
  }
  const priority = req.body.priority === undefined || req.body.priority === '' ? undefined : Number(req.body.priority);
  if (priority !== undefined && !(Number.isInteger(priority) && priority >= -100 && priority <= 100)) {
    return res.status(400).json({ error: 'priority must be a whole number -100..100' });
  }
  // A changed status does what that outcome means (services/leadStatus.js); checked below.
  let effect = null;
  const [rows] = await pool.query(
    'SELECT id, phone, status, alt_phone, priority, custom_data, campaign_id, assigned_user_id FROM leads WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'lead not found' });
  if (!campaignInScope(req.access.scope, campaignId)) {
    return res.status(400).json({ error: "that campaign isn't one of your teams'" });
  }
  if (campaignId) {
    const [c] = await pool.query('SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL', [campaignId]);
    if (!c[0]) return res.status(400).json({ error: 'campaign not found' });
  }
  if (listId) {
    // The dialer takes a list's leads for the list's campaign, so the two must agree.
    const [l] = await pool.query('SELECT name, campaign_id FROM lists WHERE id = ? AND deleted_at IS NULL', [listId]);
    if (!l[0]) return res.status(400).json({ error: 'list not found' });
    if (l[0].campaign_id !== campaignId)
      return res.status(400).json({ error: `list "${l[0].name}" belongs to a different campaign` });
  }
  if (status && status !== rows[0].status) {
    effect = statusEffect(status, await getDispositions(campaignId));
    if (effect.error) return res.status(400).json({ error: effect.error });
  }
  // assignedUserId left out = unchanged; null / '' = shared with the campaign again.
  let assigned;
  if (req.body.assignedUserId !== undefined) {
    assigned = req.body.assignedUserId ? Number(req.body.assignedUserId) : null;
    if (assigned) {
      const [u] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'agent' AND status = 'active'", [
        assigned,
      ]);
      if (!u[0]) return res.status(400).json({ error: 'agent not found (only active agents can be given leads)' });
      if (req.access.scope && !req.access.scope.agentIds.includes(assigned))
        return res.status(400).json({ error: "that agent isn't in your teams" });
    }
  }
  // customData left out = unchanged; otherwise checked against the form of
  // the campaign the lead ends up in.
  let customData = rows[0].custom_data;
  if (req.body.customData !== undefined) {
    const fields = campaignId ? await getCampaignFormFields(campaignId) : [];
    const r = applyCustomEdits(fields, rows[0].custom_data, req.body.customData);
    if (r.error) return res.status(400).json({ error: r.error });
    customData = r.value;
  }

  // One name per customer: the campaign form's Name field follows the lead's name.
  if (campaignId && (await getCampaignFormFields(campaignId)).some((x) => x.field_key === NAME_KEY)) {
    const c = { ...(customData || {}) };
    if (name) c[NAME_KEY] = String(name).trim();
    else delete c[NAME_KEY];
    customData = Object.keys(c).length ? c : null;
  }
  await pool.query(
    'UPDATE leads SET name = ?, phone = ?, alt_phone = ?, priority = ?, custom_data = ?, campaign_id = ?, list_id = ?, assigned_user_id = ?, updated_by = ? WHERE id = ?',
    [
      name || null,
      phone,
      altPhone === undefined ? rows[0].alt_phone : altPhone,
      priority === undefined ? rows[0].priority : priority,
      customData == null ? null : JSON.stringify(customData),
      campaignId,
      listId,
      assigned === undefined ? rows[0].assigned_user_id : assigned,
      req.session.user.id,
      req.params.id,
    ],
  );
  // Given to one agent: the dialer leaves it to them (a ready hopper row goes).
  if (assigned) await pool.query("DELETE FROM dial_hopper WHERE lead_id = ? AND status = 'ready'", [req.params.id]);
  if (effect) await applyStatus(pool, [{ id: rows[0].id, phone }], status, effect, req.session.user.id);
  res.json({ status: 'ok' });
});

// Delete always works and keeps history (its calls, answers, callbacks).
router.delete('/admin/leads/:id', requirePermission('leads', 'delete'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, campaign_id FROM leads WHERE id = ? AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id)) {
    return res.status(404).json({ error: 'lead not found' });
  }
  const notes = await deleteLead(Number(req.params.id), req.session.user.id);
  if (notes === null) return res.status(404).json({ error: 'lead not found' });
  res.json({ status: 'ok', notes });
});

router.post('/admin/leads/import', requirePermission('leads', 'import'), receiveLeadFile, async (req, res) => {
  const { listId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'choose an .xlsx or .csv file' });
  if (!listId) return res.status(400).json({ error: 'listId is required - create a list first' });
  const [listRows] = await pool.query('SELECT * FROM lists WHERE id = ? AND deleted_at IS NULL', [listId]);
  const list = listRows[0];
  if (!list || !campaignInScope(req.access.scope, list.campaign_id)) {
    return res.status(400).json({ error: 'list not found' });
  }
  const campaignId = list.campaign_id;

  const parsed = await readLeadUpload(req.file);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { headers, rows } = parsed;

  const fields = await getCampaignFormFields(campaignId);
  const known = new Set([...LEAD_BASE_COLUMNS.map((c) => c.key), ...fields.map((f) => f.field_key)]);
  if (!headers.includes('phone')) return res.status(400).json({ error: 'the file must have a "phone" column' });
  const unknown = headers.filter((h) => h && !known.has(h));
  if (unknown.length) {
    return res.status(400).json({
      error: `unknown column(s): ${unknown.join(', ')}. Allowed: ${[...known].join(', ')} - download the template for this list.`,
    });
  }

  // Duplicate check scope (services/leadDedupe.js); default = the campaign.
  const scope = DUP_SCOPES.includes(req.body.duplicateCheck) ? req.body.duplicateCheck : DEFAULT_SCOPE;
  const dryRun = req.body.dryRun === '1' || req.body.dryRun === 'true';
  const numbers = rows.map((r) => normalizePhone(r.values.phone)).filter(Boolean);
  const existing = await findExisting(numbers, scope, { listId: list.id, campaignId });
  const campaignMatches = await findCampaignMatches(numbers, campaignId);
  const [dncRows] = await pool.query('SELECT phone FROM dnc_numbers WHERE tenant_id = 1');
  const dnc = new Set(dncRows.map((r) => r.phone));
  // 'update' = a number already a lead of this campaign updates that lead (filled cells only).
  const onDuplicate = req.body.onDuplicate === 'update' ? 'update' : 'skip';
  const moveToList = req.body.moveToList === '1' || req.body.moveToList === 'true';
  const { toInsert, toUpdate, skipped, summary } = planImport({
    rows,
    fields,
    scope,
    existing,
    dnc,
    campaignInScope: (id) => campaignInScope(req.access.scope, id),
    onDuplicate,
    campaignMatches,
  });
  const updateAudits = [];
  let unchanged = 0;

  if (!dryRun && (toInsert.length || toUpdate.length)) {
    // One transaction, multi-row INSERTs in chunks - all or nothing, and
    // far fewer round-trips than one INSERT per lead.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const values = toInsert.map((r) => [
        1,
        r.phone,
        r.altPhone,
        r.name,
        campaignId,
        list.id,
        r.priority,
        Object.keys(r.custom).length ? JSON.stringify(r.custom) : null,
      ]);
      for (let i = 0; i < values.length; i += 500) {
        await conn.query(
          'INSERT INTO leads (tenant_id, phone, alt_phone, name, campaign_id, list_id, priority, custom_data) VALUES ?',
          [values.slice(i, i + 500)],
        );
      }
      // Updates: filled cells change the lead's current values; empty cells keep them.
      for (let i = 0; i < toUpdate.length; i += 500) {
        const part = toUpdate.slice(i, i + 500);
        const [cur] = await conn.query(
          'SELECT id, name, alt_phone, priority, custom_data, list_id FROM leads WHERE id IN (?) FOR UPDATE',
          [part.map((u) => u.leadId)],
        );
        const byId = new Map(cur.map((r) => [r.id, r]));
        for (const u of part) {
          const c = byId.get(u.leadId);
          if (!c) continue;
          const custom = mergeChanged(c.custom_data, u.custom, Object.keys(u.custom));
          const before = {
            name: c.name,
            alt_phone: c.alt_phone,
            priority: c.priority,
            list_id: c.list_id,
            custom_data: parseCustom(c.custom_data),
          };
          const after = {
            name: u.name ?? c.name,
            alt_phone: u.altPhone ?? c.alt_phone,
            priority: u.priority ?? c.priority,
            list_id: moveToList ? list.id : c.list_id,
            custom_data: custom,
          };
          if (JSON.stringify(before) === JSON.stringify(after)) {
            unchanged++;
            continue;
          }
          await conn.query(
            'UPDATE leads SET name = ?, alt_phone = ?, priority = ?, list_id = ?, custom_data = ?, updated_by = ? WHERE id = ?',
            [
              after.name,
              after.alt_phone,
              after.priority,
              after.list_id,
              Object.keys(custom).length ? JSON.stringify(custom) : null,
              req.session.user.id,
              u.leadId,
            ],
          );
          updateAudits.push({ id: u.leadId, before, after });
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.error('[lead import failed]', err);
      return res.status(500).json({ error: 'import failed - nothing was saved' });
    } finally {
      conn.release();
    }
  }
  // Each updated lead's history says what the upload changed, and from which file.
  const fileName = String((req.file && req.file.originalname) || 'file').slice(0, 120);
  for (const a of updateAudits) {
    await audit({
      user: req.session.user,
      action: 'leads.update',
      entity: 'leads',
      entityId: a.id,
      status: 200,
      summary: `upload ${fileName}`,
      before: a.before,
      after: a.after,
      ip: req.ip,
    });
  }
  if (dryRun) summary.imported = 0;
  if (!dryRun) summary.updated = updateAudits.length;
  if (!dryRun) {
    await pool.query(
      `INSERT INTO list_imports (list_id, user_id, file_name, total, imported, updated, skipped, duplicate_check, on_duplicate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        list.id,
        req.session.user.id,
        fileName,
        summary.total,
        toInsert.length,
        summary.updated,
        skipped.length,
        scope,
        onDuplicate,
      ],
    );
  }
  const reportId = skipped.length
    ? saveReport(req.session.user.id, {
        headers,
        skipped,
        summary: { ...summary, imported: toInsert.length },
        listName: list.name,
        scope,
        dryRun,
      })
    : null;
  res.json({
    ...summary,
    wouldImport: toInsert.length,
    wouldUpdate: toUpdate.length,
    unchanged,
    onDuplicate,
    duplicates: summary.inFile + summary.existing,
    scope,
    dryRun,
    reportId,
    errors: skipped
      .filter((x) => x.kind === 'invalid')
      .slice(0, 50)
      .map((x) => ({ row: x.rowNum, reason: x.reason })),
  });
});

// The rows an upload skipped, with the reason (Excel). Only for the uploader, kept 1 hour.
router.get('/admin/leads/import-report/:id', requirePermission('leads', 'import'), async (req, res) => {
  const report = getReport(req.session.user.id, req.params.id);
  if (!report) return res.status(404).json({ error: 'that report has expired - upload or check the file again' });
  const buf = await reportWorkbook(report);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-not-imported.xlsx"');
  res.send(Buffer.from(buf));
});

// Template built from the list's campaign form, so the columns always
// match what the import accepts. xlsx (default) adds an Instructions sheet.
router.get('/admin/leads/template', requirePermission('leads', 'view'), async (req, res) => {
  let fields = [];
  let fileName = 'leads-template';
  if (req.query.listId) {
    const [rows] = await pool.query(
      'SELECT l.name, l.campaign_id FROM lists l WHERE l.id = ? AND l.deleted_at IS NULL',
      [req.query.listId],
    );
    if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id)) {
      return res.status(404).json({ error: 'list not found' });
    }
    fields = await getCampaignFormFields(rows[0].campaign_id);
    fileName = `leads-${rows[0].name.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
  }
  const headers = [...LEAD_BASE_COLUMNS.map((c) => c.key), ...fields.map((f) => f.field_key)];
  const example = { phone: '9840012345', name: 'Ravi Kumar', alt_phone: '', priority: '0' };
  for (const f of fields) {
    const o = f.options || [];
    example[f.field_key] =
      {
        number: '50000',
        date: '2026-12-31',
        email: 'ravi@example.com',
        phone: '9840012346',
        dropdown: o[0],
        radio: o[0],
        checkbox: o.slice(0, 2).join(', '),
      }[f.field_type] || '';
  }

  if (req.query.format === 'csv') {
    const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.csv"`);
    return res.send(`${headers.join(',')}\n${headers.map((h) => esc(example[h] || '')).join(',')}\n`);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.addRow(headers).font = { bold: true };
  ws.addRow(headers.map((h) => example[h] || ''));
  ws.columns.forEach((col) => {
    col.width = 18;
  });
  ws.getColumn(1).numFmt = '@'; // keep phone numbers as text (no 9.84E+09)
  ws.getColumn(3).numFmt = '@';
  const info = wb.addWorksheet('Instructions');
  info.addRow(['Column', 'Required', 'Type', 'Allowed values / notes']).font = { bold: true };
  for (const c of LEAD_BASE_COLUMNS) info.addRow([c.key, c.required ? 'yes' : 'no', 'text', c.help]);
  for (const f of fields) {
    info.addRow([
      f.field_key,
      'no',
      f.field_type,
      `${f.label}${(f.options || []).length ? ' - one of: ' + f.options.join(', ') : ''}${f.field_type === 'checkbox' ? ' (comma-separate several)' : ''}${f.field_type === 'date' ? ' (YYYY-MM-DD)' : ''}`,
    ]);
  }
  info.addRow([]);
  info.addRow([
    'Row 2 of the Leads sheet is an example - replace or delete it. Numbers on the DNC list and numbers already in the campaign are skipped.',
  ]);
  info.columns.forEach((col, i) => {
    col.width = [16, 10, 12, 70][i];
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Old template URL kept working for bookmarks.
router.get('/admin/leads/csv-template', requirePermission('leads', 'view'), (req, res) =>
  res.redirect('/admin/leads/template?format=csv'),
);

// --- Bulk actions (services/leadBulk.js): ticked leads or all matching the filters.
router.post('/admin/leads/bulk', requirePermission('leads', 'view'), async (req, res) => {
  const body = req.body || {};
  try {
    const r = await runBulk(body, req.access, req.session.user.id);
    void audit({
      user: req.session.user,
      action: 'leads.bulk',
      entity: 'leads',
      status: 200,
      summary: `${r.action}: ${r.changed} lead(s)${r.notes.length ? ' - ' + r.notes.join('; ') : ''}`.slice(0, 250),
      request: { ...body, ids: Array.isArray(body.ids) ? `${body.ids.length} ids` : undefined },
      ip: req.ip,
    });
    res.json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// --- Export: the leads matching the filters, as Excel (services/leadExport.js). Audited.
router.get('/admin/leads/export', requirePermission('leads', 'export'), async (req, res) => {
  const n = await exportLeads(req.query, req.access.scope, res);
  void audit({
    user: req.session.user,
    action: 'leads.export',
    entity: 'leads',
    status: 200,
    summary: `${n} lead(s)`,
    request: req.query,
    ip: req.ip,
  });
});

// Agents for Leads (own teams' for a team role): active agents - the ones
// leads can be given to - plus inactive ones who still hold leads, so those
// can be found and handed to someone else (active: false).
router.get('/admin/leads/agents', requirePermission('leads', 'view'), async (req, res) => {
  const where = whereClause([
    [
      `role = 'agent' AND (status = 'active' OR id IN
        (SELECT assigned_user_id FROM leads WHERE deleted_at IS NULL AND assigned_user_id IS NOT NULL))`,
      [],
    ],
    scopeCondition(req.access.scope, 'agents', 'id'),
  ]);
  const [rows] = await pool.query(
    `SELECT id, username, status = 'active' AS active FROM users ${where.sql} ORDER BY username`,
    where.params,
  );
  res.json(rows.map((r) => ({ ...r, active: !!Number(r.active) })));
});

// --- One lead in full (Leads -> open a lead). A deleted lead still opens, read-only.
router.get('/admin/leads/:id', requirePermission('leads', 'view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.*, c.name AS campaign_name, ls.name AS list_name, ls.is_active AS list_active,
            au.username AS assigned_to, ub.username AS updated_by_name, dl.username AS deleted_by_name,
            (SELECT cb.callback_at FROM callbacks cb WHERE cb.lead_id = l.id AND cb.status = 'pending'
             ORDER BY cb.callback_at LIMIT 1) AS callback_at
     FROM leads l
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN lists ls ON ls.id = l.list_id
     LEFT JOIN users au ON au.id = l.assigned_user_id
     LEFT JOIN users ub ON ub.id = l.updated_by
     LEFT JOIN users dl ON dl.id = l.deleted_by
     WHERE l.id = ?`,
    [Number(req.params.id)],
  );
  const lead = rows[0];
  if (!lead || !campaignInScope(req.access.scope, lead.campaign_id))
    return res.status(404).json({ error: 'lead not found' });
  const fields = lead.campaign_id ? await getCampaignFormFields(lead.campaign_id) : [];
  res.json({
    ...lead,
    on_dnc: await isDnc(lead.phone),
    form_fields: fields.map((x) => ({ key: x.field_key, label: x.label })),
  });
});

module.exports = router;
