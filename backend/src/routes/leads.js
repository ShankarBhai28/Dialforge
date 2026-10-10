const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { requirePermission, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');
const { getDispositions } = require('../services/dispositions');
const { addDnc } = require('../services/dnc');
const { audit } = require('../services/audit');
const { likeTerm, pageResult, parsePaging, whereClause } = require('../services/paging');
const {
  LEAD_BASE_COLUMNS,
  applyCustomEdits,
  getCampaignFormFields,
  parseLeadCustomValue,
  readLeadUpload,
  receiveLeadFile,
} = require('../services/leadImport');

const { campaignInScope, scopeCondition } = require('../services/access');

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
      ORDER BY l.id DESC LIMIT 200
    `);
    return res.json(rows);
  }
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign) return res.json([]);
  const [rows] = await pool.query('SELECT * FROM leads WHERE campaign_id = ? ORDER BY id DESC LIMIT 100', [
    campaign.id,
  ]);
  res.json(rows);
});

// --- Admin: every lead, searched and paged on the server ---
// ?q= (name or phone) &campaignId= (or 'none') &listId= &status= &page= &pageSize=
router.get('/admin/leads', requirePermission('leads', 'view'), async (req, res) => {
  const paging = parsePaging(req.query);
  const { q, campaignId, listId, status } = req.query;
  const digits = normalizePhone(q || '');
  const where = whereClause([
    [
      q ? `(l.name LIKE ?${digits ? ' OR l.phone LIKE ?' : ''})` : '',
      q ? [likeTerm(q.trim()), ...(digits ? [likeTerm(digits)] : [])] : [],
    ],
    [
      campaignId === 'none' ? 'l.campaign_id IS NULL' : campaignId ? 'l.campaign_id = ?' : '',
      campaignId && campaignId !== 'none' ? [campaignId] : [],
    ],
    [listId ? 'l.list_id = ?' : '', [listId]],
    [status ? 'l.status = ?' : '', [status]],
    scopeCondition(req.access.scope, 'campaigns', 'l.campaign_id'),
  ]);
  const [rows] = await pool.query(
    `SELECT l.*, c.name AS campaign_name, ls.name AS list_name
     FROM leads l
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN lists ls ON ls.id = l.list_id
     ${where.sql}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...where.params, paging.pageSize, paging.offset],
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM leads l ${where.sql}`, where.params);
  // Statuses present (for the filter), within the chosen campaign if any.
  const scope = whereClause([
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
router.post('/leads/:id/disposition', requireCaller, async (req, res) => {
  const [leadRows] = await pool.query('SELECT id, phone, campaign_id, status FROM leads WHERE id = ?', [req.params.id]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  if (req.session.user.role === 'agent') {
    const campaign = await findCurrentCampaign(req.session.user.id);
    if (lead.campaign_id && (!campaign || campaign.id !== lead.campaign_id)) {
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
  const ext = req.session.user.extensionName;
  const [callRows] = await pool.query(
    'SELECT id, lead_id, to_number, campaign_id FROM calls WHERE id = ? AND (from_extension = ? OR transfer_ext = ?)',
    [req.params.callId, ext, ext],
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
    'SELECT id, phone, campaign_id, status FROM leads WHERE phone = ? AND campaign_id <=> ? ORDER BY id DESC LIMIT 1',
    [phone, campaignId],
  );
  let lead = existing[0];
  if (!lead) {
    const [result] = await pool.query('INSERT INTO leads (tenant_id, phone, campaign_id) VALUES (1, ?, ?)', [
      phone,
      campaignId,
    ]);
    lead = { id: result.insertId, phone, campaign_id: campaignId, status: 'new' };
  }
  await pool.query('UPDATE calls SET lead_id = ? WHERE id = ? AND lead_id IS NULL', [lead.id, call.id]);
  return saveDisposition(req, res, lead);
});

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
    summary: `${d.code}${req.params.callId ? ` (call ${req.params.callId})` : ''}`,
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
  if (status && status !== 'new') {
    const codes = (await getDispositions(campaignId)).map((x) => x.code);
    if (!codes.includes(status))
      return res.status(400).json({ error: `status must be new or one of: ${codes.join(', ')}` });
  }
  const [rows] = await pool.query('SELECT id, alt_phone, priority, custom_data, campaign_id FROM leads WHERE id = ?', [
    req.params.id,
  ]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'lead not found' });
  if (!campaignInScope(req.access.scope, campaignId)) {
    return res.status(400).json({ error: "that campaign isn't one of your teams'" });
  }
  if (campaignId) {
    const [c] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [campaignId]);
    if (!c[0]) return res.status(400).json({ error: 'campaign not found' });
  }
  if (listId) {
    // The dialer takes a list's leads for the list's campaign, so the two must agree.
    const [l] = await pool.query('SELECT name, campaign_id FROM lists WHERE id = ?', [listId]);
    if (!l[0]) return res.status(400).json({ error: 'list not found' });
    if (l[0].campaign_id !== campaignId)
      return res.status(400).json({ error: `list "${l[0].name}" belongs to a different campaign` });
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

  await pool.query(
    'UPDATE leads SET name = ?, phone = ?, alt_phone = ?, priority = ?, custom_data = ?, campaign_id = ?, list_id = ?, status = COALESCE(?, status), updated_by = ? WHERE id = ?',
    [
      name || null,
      phone,
      altPhone === undefined ? rows[0].alt_phone : altPhone,
      priority === undefined ? rows[0].priority : priority,
      customData == null ? null : JSON.stringify(customData),
      campaignId,
      listId,
      status || null,
      req.session.user.id,
      req.params.id,
    ],
  );
  res.json({ status: 'ok' });
});

router.delete('/admin/leads/:id', requirePermission('leads', 'delete'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, campaign_id FROM leads WHERE id = ?', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].campaign_id))
    return res.status(404).json({ error: 'lead not found' });

  const [callRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM calls WHERE lead_id = ?', [req.params.id]);
  if (callRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${callRefs[0].cnt} call record(s) reference this lead.` });
  }
  const [responseRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM form_responses WHERE lead_id = ?', [
    req.params.id,
  ]);
  if (responseRefs[0].cnt > 0) {
    return res
      .status(409)
      .json({ error: `Cannot delete - ${responseRefs[0].cnt} form response(s) reference this lead.` });
  }
  const [callbackRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM callbacks WHERE lead_id = ?', [req.params.id]);
  if (callbackRefs[0].cnt > 0) {
    return res.status(409).json({ error: `Cannot delete - ${callbackRefs[0].cnt} callback(s) reference this lead.` });
  }

  await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
  res.json({ status: 'ok' });
});

router.post('/admin/leads/import', requirePermission('leads', 'import'), receiveLeadFile, async (req, res) => {
  const { listId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'choose an .xlsx or .csv file' });
  if (!listId) return res.status(400).json({ error: 'listId is required - create a list first' });
  const [listRows] = await pool.query('SELECT * FROM lists WHERE id = ?', [listId]);
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

  // Duplicates and DNC compared on the normalised number, so "+91 98400
  // 12345" in the file matches "9840012345" already in the campaign.
  const [existingRows] = await pool.query('SELECT phone FROM leads WHERE campaign_id = ?', [campaignId]);
  const existing = new Set(existingRows.map((r) => normalizePhone(r.phone)));
  const [dncRows] = await pool.query('SELECT phone FROM dnc_numbers WHERE tenant_id = 1');
  const dnc = new Set(dncRows.map((r) => r.phone));

  const summary = { total: rows.length, imported: 0, duplicates: 0, dnc: 0, invalid: 0 };
  const errors = [];
  const toInsert = [];
  const rowError = (rowNum, reason) => {
    summary.invalid++;
    if (errors.length < 50) errors.push({ row: rowNum, reason });
  };

  for (const { rowNum, values } of rows) {
    const phone = normalizePhone(values.phone);
    if (phone.length < 7 || phone.length > 15) {
      rowError(rowNum, `invalid phone "${values.phone}"`);
      continue;
    }
    let altPhone = null;
    if (values.alt_phone) {
      altPhone = normalizePhone(values.alt_phone);
      if (altPhone.length < 7 || altPhone.length > 15) {
        rowError(rowNum, `invalid alt_phone "${values.alt_phone}"`);
        continue;
      }
    }
    let priority = 0;
    if (values.priority) {
      priority = Number(values.priority);
      if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
        rowError(rowNum, 'priority must be a whole number -100..100');
        continue;
      }
    }
    const custom = {};
    let bad = null;
    for (const f of fields) {
      const raw = values[f.field_key];
      if (!raw) continue;
      const r = parseLeadCustomValue(f, raw);
      if (r.error) {
        bad = `${f.field_key} ${r.error}`;
        break;
      }
      custom[f.field_key] = r.value;
    }
    if (bad) {
      rowError(rowNum, bad);
      continue;
    }
    if (dnc.has(phone)) {
      summary.dnc++;
      continue;
    }
    if (existing.has(phone)) {
      summary.duplicates++;
      continue;
    }
    existing.add(phone);
    toInsert.push([
      1,
      phone,
      altPhone,
      values.name || null,
      campaignId,
      list.id,
      priority,
      Object.keys(custom).length ? JSON.stringify(custom) : null,
    ]);
  }

  // One transaction, multi-row INSERTs in chunks - all or nothing, and
  // far fewer round-trips than one INSERT per lead.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < toInsert.length; i += 500) {
      await conn.query(
        'INSERT INTO leads (tenant_id, phone, alt_phone, name, campaign_id, list_id, priority, custom_data) VALUES ?',
        [toInsert.slice(i, i + 500)],
      );
    }
    await conn.commit();
    summary.imported = toInsert.length;
  } catch (err) {
    await conn.rollback();
    console.error('[lead import failed]', err);
    return res.status(500).json({ error: 'import failed - nothing was saved' });
  } finally {
    conn.release();
  }
  res.json({ ...summary, errors });
});

// Template built from the list's campaign form, so the columns always
// match what the import accepts. xlsx (default) adds an Instructions sheet.
router.get('/admin/leads/template', requirePermission('leads', 'view'), async (req, res) => {
  let fields = [];
  let fileName = 'leads-template';
  if (req.query.listId) {
    const [rows] = await pool.query('SELECT l.name, l.campaign_id FROM lists l WHERE l.id = ?', [req.query.listId]);
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

module.exports = router;
