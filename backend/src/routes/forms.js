const express = require('express');
const { deleteForm } = require('../services/softDelete');
const pool = require('../../db');
const { requirePermission, requireAdminSide, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');
const { loadFormsWithFields, validateFormData, validateFormFields } = require('../services/forms');

const { scopeCondition } = require('../services/access');
const { diffCustom, mergeChanged, parseCustom } = require('../services/leadData');

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

router.post('/agent/form-responses', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || !campaign.form_id) return res.status(400).json({ error: 'your current campaign has no form' });
  const [form] = await loadFormsWithFields("WHERE id = ? AND status = 'active'", [campaign.form_id]);
  if (!form) return res.status(400).json({ error: 'your current campaign has no active form' });

  const { leadId, callId } = req.body;
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

  if (!leadId) {
    // A first call (no lead yet): kept with the call; the lead created at the
    // outcome takes these answers (leadData.adoptCallForms).
    const { error, data } = validateFormData(form.fields, submitted);
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'INSERT INTO form_responses (tenant_id, form_id, campaign_id, lead_id, call_id, user_id, data) VALUES (1, ?, ?, NULL, ?, ?, ?)',
      [form.id, campaign.id, callId || null, req.session.user.id, JSON.stringify(data)],
    );
    return res.status(201).json({ id: result.insertId, changes: [] });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locked: two saves at once can't lose each other's fields.
    const [[lead]] = await conn.query('SELECT custom_data FROM leads WHERE id = ? FOR UPDATE', [leadId]);
    const current = parseCustom(lead && lead.custom_data);
    const { error, data } = validateFormData(form.fields, { ...current, ...pick(submitted, changed) }, changed);
    if (error) {
      await conn.rollback();
      return res.status(400).json({ error });
    }
    const next = mergeChanged(current, data, changed);
    const changes = diffCustom(current, next, changed);
    await conn.query('UPDATE leads SET custom_data = ?, updated_by = ? WHERE id = ?', [
      Object.keys(next).length ? JSON.stringify(next) : null,
      req.session.user.id,
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
    res.status(201).json({ id: result.insertId, changes });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = router;
