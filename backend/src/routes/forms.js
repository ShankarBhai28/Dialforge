const express = require('express');
const { deleteForm } = require('../services/softDelete');
const pool = require('../../db');
const { requirePermission, requireAdminSide, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');
const { loadFormsWithFields, validateFormData, validateFormFields } = require('../services/forms');

const { scopeCondition } = require('../services/access');
const { NAME_KEY, diffCustom, mergeChanged, parseCustom } = require('../services/leadData');

const router = express.Router();
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

router.get('/admin/forms', requireAdminSide, async (req, res) => {
  const forms = await loadFormsWithFields('WHERE deleted_at IS NULL');
  const [usage] = await pool.query(
    "SELECT form_id, GROUP_CONCAT(name ORDER BY name SEPARATOR ', ') AS campaigns FROM campaigns WHERE form_id IS NOT NULL AND deleted_at IS NULL GROUP BY form_id",
  );
  const [counts] = await pool.query('SELECT form_id, COUNT(*) AS cnt FROM form_responses GROUP BY form_id');
  res.json(
    forms.map((f) => ({
      ...f,
      campaigns: (usage.find((u) => u.form_id === f.id) || {}).campaigns || null,
      response_count: (counts.find((c) => c.form_id === f.id) || {}).cnt || 0,
    })),
  );
});

// Create and edit replace the whole field list in one transaction. Old
// responses are stored by field_key, so re-creating field rows is safe.
async function saveForm(formId, { name, description, status, fields }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (formId) {
      await conn.query('UPDATE forms SET name = ?, description = ?, status = ? WHERE id = ?', [
        name,
        description || null,
        status || 'active',
        formId,
      ]);
      await conn.query('DELETE FROM form_fields WHERE form_id = ?', [formId]);
    } else {
      const [result] = await conn.query(
        'INSERT INTO forms (tenant_id, name, description, status) VALUES (1, ?, ?, ?)',
        [name, description || null, status || 'active'],
      );
      formId = result.insertId;
    }
    for (const f of fields) {
      await conn.query(
        'INSERT INTO form_fields (form_id, field_key, label, field_type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [formId, f.key, f.label, f.type, f.options ? JSON.stringify(f.options) : null, f.required, f.order],
      );
    }
    await conn.commit();
    return formId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function handleFormSave(req, res, formId) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { error, fields } = validateFormFields(req.body.fields);
  if (error) return res.status(400).json({ error });
  // Deactivating a form a campaign still points at would silently remove
  // the form from agents' screens - make the admin unlink it first.
  if (formId && req.body.status === 'inactive') {
    const [refs] = await pool.query('SELECT name FROM campaigns WHERE form_id = ? AND deleted_at IS NULL', [formId]);
    if (refs.length) {
      return res.status(409).json({
        error: `Cannot deactivate - used by campaign(s): ${refs.map((r) => r.name).join(', ')}. Pick another form for them first.`,
      });
    }
  }
  try {
    const id = await saveForm(formId, { ...req.body, name, fields });
    res.status(formId ? 200 : 201).json({ id, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'a form with that name already exists' });
    console.error('[form save failed]', err);
    res.status(500).json({ error: 'failed to save form' });
  }
}

router.post('/admin/forms', requirePermission('forms', 'create'), (req, res) => handleFormSave(req, res, null));

router.put('/admin/forms/:id', requirePermission('forms', 'edit'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM forms WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'form not found' });
  return handleFormSave(req, res, Number(req.params.id));
});

// Blocked while referenced: a campaign using it, or saved responses
// (those are real call data - deactivate the form instead).
// Delete always works and keeps history (its saved answers): campaigns
// using it lose it.
router.delete('/admin/forms/:id', requirePermission('forms', 'delete'), async (req, res) => {
  const notes = await deleteForm(Number(req.params.id), req.session.user.id);
  if (notes === null) return res.status(404).json({ error: 'form not found' });
  res.json({ status: 'ok', notes });
});

router.get('/admin/forms/:id/responses', requirePermission('forms', 'view'), async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'campaigns', 'r.campaign_id');
  const [rows] = await pool.query(
    `
    SELECT r.id, r.data, r.created_at, r.lead_id, r.call_id, u.username, c.name AS campaign_name, l.phone AS lead_phone
    FROM form_responses r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN campaigns c ON c.id = r.campaign_id
    LEFT JOIN leads l ON l.id = r.lead_id
    WHERE r.form_id = ?${cond ? ` AND ${cond}` : ''}
    ORDER BY r.id DESC LIMIT 200
  `,
    [req.params.id, ...params],
  );
  res.json(rows);
});

// --- Agent: the form for the campaign they're currently working ---
router.get('/agent/form', requireCaller, async (req, res) => {
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || !campaign.form_id) return res.json(null);
  const [form] = await loadFormsWithFields("WHERE id = ? AND status = 'active'", [campaign.form_id]);
  res.json(form || null);
});

// --- Agent: the form as typed, kept automatically (form_drafts) ---
// One draft per agent per lead / call / blank form, restored when that form
// opens again until it is saved or discarded.
const draftKey = (leadId, callId) =>
  Number(leadId) > 0 ? `lead:${Number(leadId)}` : Number(callId) > 0 ? `call:${Number(callId)}` : 'blank';
const MAX_DRAFT_BYTES = 64 * 1024;

async function agentForm(req, res) {
  if (req.session.user.role !== 'agent') {
    res.status(403).json({ error: 'agents only' });
    return null;
  }
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || !campaign.form_id) {
    res.status(400).json({ error: 'your current campaign has no form' });
    return null;
  }
  const [form] = await loadFormsWithFields("WHERE id = ? AND status = 'active'", [campaign.form_id]);
  if (!form) {
    res.status(400).json({ error: 'your current campaign has no active form' });
    return null;
  }
  return { campaign, form };
}

router.get('/agent/form-draft', requireCaller, async (req, res) => {
  const ctx = await agentForm(req, res);
  if (!ctx) return;
  const [[d]] = await pool.query(
    `SELECT data, updated_at FROM form_drafts
     WHERE user_id = ? AND draft_key = ? AND form_id = ? AND saved_at IS NULL AND discarded_at IS NULL`,
    [req.session.user.id, draftKey(req.query.leadId, req.query.callId), ctx.form.id],
  );
  res.json(d ? { data: typeof d.data === 'string' ? JSON.parse(d.data) : d.data, updatedAt: d.updated_at } : null);
});

router.put('/agent/form-draft', requireCaller, async (req, res) => {
  const ctx = await agentForm(req, res);
  if (!ctx) return;
  const { leadId, callId, data } = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return res.status(400).json({ error: 'data must be an object' });
  // Only this form's fields.
  const keys = ctx.form.fields.map((f) => f.field_key);
  const json = JSON.stringify(pick(data, keys));
  if (Buffer.byteLength(json) > MAX_DRAFT_BYTES)
    return res.status(400).json({ error: 'the form is too large to keep' });
  await pool.query(
    `INSERT INTO form_drafts (user_id, draft_key, form_id, campaign_id, lead_id, call_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE form_id = VALUES(form_id), campaign_id = VALUES(campaign_id), lead_id = VALUES(lead_id),
       call_id = VALUES(call_id), data = VALUES(data), updated_at = NOW(), saved_at = NULL, discarded_at = NULL`,
    [
      req.session.user.id,
      draftKey(leadId, callId),
      ctx.form.id,
      ctx.campaign.id,
      Number(leadId) > 0 ? Number(leadId) : null,
      Number(callId) > 0 ? Number(callId) : null,
      json,
    ],
  );
  res.json({ status: 'ok' });
});

// Discard: the agent chose to start again from the lead's current details (kept for support).
router.delete('/agent/form-draft', requireCaller, async (req, res) => {
  await pool.query(
    'UPDATE form_drafts SET discarded_at = NOW() WHERE user_id = ? AND draft_key = ? AND saved_at IS NULL AND discarded_at IS NULL',
    [req.session.user.id, draftKey(req.query.leadId, req.query.callId)],
  );
  res.json({ status: 'ok' });
});

/** The form was saved: its draft is done (kept, marked saved). */
async function draftSaved(userId, leadId, callId) {
  await pool
    .query('UPDATE form_drafts SET saved_at = NOW() WHERE user_id = ? AND draft_key = ? AND saved_at IS NULL', [
      userId,
      draftKey(leadId, callId),
    ])
    .catch((err) => console.error('[form draft: marking saved failed]', err.message));
}

router.post('/agent/form-responses', requireCaller, async (req, res) => {
  const ctx = await agentForm(req, res);
  if (!ctx) return;
  const { campaign, form } = ctx;

  let { leadId } = req.body;
  const { callId } = req.body;
  const screenLeadId = leadId; // the draft is kept under what the screen had
  // The lead must belong to the campaign being worked, and the call must
  // be one this agent placed/took - otherwise answers could be attached
  // to someone else's record.
  if (leadId) {
    const [leads] = await pool.query('SELECT id FROM leads WHERE id = ? AND campaign_id = ?', [leadId, campaign.id]);
    if (!leads[0]) return res.status(400).json({ error: 'that lead is not in your current campaign' });
  }
  if (callId) {
    const [calls] = await pool.query('SELECT id FROM calls WHERE id = ? AND from_extension = ?', [
      callId,
      req.session.user.extensionName,
    ]);
    if (!calls[0]) return res.status(400).json({ error: 'that call is not yours' });
  }

  // The fields this agent changed on their screen (older screens send none:
  // then every field counts). Only those change the lead's current values,
  // so a screen opened before someone else's edit can't undo it.
  const keys = form.fields.map((f) => f.field_key);
  const submitted = req.body.data && typeof req.body.data === 'object' ? req.body.data : {};
  const changed = Array.isArray(req.body.changed) ? keys.filter((k) => req.body.changed.includes(k)) : keys;

  if (!leadId && callId) {
    // The screen didn't know the lead (a typed number, or the outcome already
    // linked the call): the call's lead in this campaign, if it has one.
    const [[c]] = await pool.query(
      'SELECT l.id FROM calls ca JOIN leads l ON l.id = ca.lead_id WHERE ca.id = ? AND l.campaign_id = ? AND l.deleted_at IS NULL',
      [callId, campaign.id],
    );
    if (c) leadId = c.id;
  }
  if (!leadId) {
    // A first call (no lead yet): kept with the call; the lead created at the
    // outcome takes these answers (leadData.adoptCallForms).
    const { error, data } = validateFormData(form.fields, submitted);
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'INSERT INTO form_responses (tenant_id, form_id, campaign_id, lead_id, call_id, user_id, data) VALUES (1, ?, ?, NULL, ?, ?, ?)',
      [form.id, campaign.id, callId || null, req.session.user.id, JSON.stringify(data)],
    );
    await draftSaved(req.session.user.id, screenLeadId, callId);
    return res.status(201).json({ id: result.insertId, changes: [] });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locked: two saves at once can't lose each other's fields.
    const [[lead]] = await conn.query('SELECT name, custom_data FROM leads WHERE id = ? FOR UPDATE', [leadId]);
    // The lead's name is the form's Name (one name per customer).
    const current = parseCustom(lead && lead.custom_data);
    if (keys.includes(NAME_KEY) && lead && lead.name) current[NAME_KEY] = lead.name;
    const { error, data } = validateFormData(form.fields, { ...current, ...pick(submitted, changed) }, changed);
    if (error) {
      await conn.rollback();
      return res.status(400).json({ error });
    }
    const next = mergeChanged(current, data, changed);
    const changes = diffCustom(current, next, changed);
    const renamed = changed.includes(NAME_KEY);
    await conn.query(`UPDATE leads SET custom_data = ?, updated_by = ?${renamed ? ', name = ?' : ''} WHERE id = ?`, [
      Object.keys(next).length ? JSON.stringify(next) : null,
      req.session.user.id,
      ...(renamed ? [next[NAME_KEY] ? String(next[NAME_KEY]).slice(0, 100) : null] : []),
      leadId,
    ]);
    // The save itself, with its full answers (Forms -> Responses) and what it changed (history).
    const [result] = await conn.query(
      'INSERT INTO form_responses (tenant_id, form_id, campaign_id, lead_id, call_id, user_id, data, changes) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      [
        form.id,
        campaign.id,
        leadId,
        callId || null,
        req.session.user.id,
        JSON.stringify(data),
        JSON.stringify(changes),
      ],
    );
    await conn.commit();
    await draftSaved(req.session.user.id, screenLeadId, callId);
    res.status(201).json({ id: result.insertId, changes });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = router;
