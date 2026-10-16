const express = require('express');
const { deleteCampaign } = require('../services/softDelete');
const pool = require('../../db');
const { requirePermission, requireAdminSide, requireAllScope } = require('../middleware/auth');
const { checkCampaignForm, parseCampaignSettings } = require('../services/campaigns');
const {
  DEFAULT_DISPOSITIONS,
  getDispositions,
  replaceDispositions,
  validateDispositions,
} = require('../services/dispositions');

const { campaignInScope, scopeCondition } = require('../services/access');

/** The auto disposition (if on) must be one of the campaign's, and not a callback (that needs a time). */
function checkAutoDispo(settings, dispositions) {
  if (!settings.auto_dispo_code) return null;
  const d = dispositions.find((x) => x.code === settings.auto_dispo_code);
  if (!d) return `auto disposition must be one of: ${dispositions.map((x) => x.code).join(', ')}`;
  if (d.is_callback) return 'a callback needs a date and time - pick another auto disposition';
  return null;
}

const router = express.Router();

// --- Admin: campaigns (each references one queue) ---
router.get('/admin/campaigns', requireAdminSide, async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'campaigns', 'c.id');
  const [rows] = await pool.query(
    `
    SELECT c.*, q.name AS queue_name, q.ring_strategy, q.wait_timeout, f.name AS form_name
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN forms f ON f.id = c.form_id
    WHERE c.deleted_at IS NULL${cond ? ` AND ${cond}` : ''}
    ORDER BY c.id DESC
  `,
    params,
  );
  res.json(rows);
});

// A campaign is active or paused. Edit also accepts the status it already
// has, so an older value doesn't block saving other changes.
const CAMPAIGN_STATUSES = ['active', 'paused'];
function checkCampaignStatus(status, current) {
  if (status === undefined || status === '' || CAMPAIGN_STATUSES.includes(status) || status === current) return null;
  return 'status must be active or paused';
}

router.post(
  '/admin/campaigns',
  requirePermission('campaigns', 'create'),
  requireAllScope('create campaigns'),
  async (req, res) => {
    const { name, queueId, outboundCallerId, autoAnswer, formId, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const statusError = checkCampaignStatus(status);
    if (statusError) return res.status(400).json({ error: statusError });
    const formError = await checkCampaignForm(formId);
    if (formError) return res.status(400).json({ error: formError });
    const { error, settings } = parseCampaignSettings(req.body);
    if (error) return res.status(400).json({ error });
    const autoError = checkAutoDispo(settings, DEFAULT_DISPOSITIONS);
    if (autoError) return res.status(400).json({ error: autoError });
    const conn = await pool.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      [result] = await conn.query('INSERT INTO campaigns SET ?', [
        {
          tenant_id: 1,
          name,
          queue_id: queueId || null,
          outbound_caller_id: outboundCallerId || null,
          auto_answer: autoAnswer ? 1 : 0,
          status: status || 'active',
          form_id: formId || null,
          ...settings,
        },
      ]);
      await replaceDispositions(conn, result.insertId, DEFAULT_DISPOSITIONS);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.error('[campaign create failed]', err);
      return res.status(500).json({ error: 'failed to create campaign' });
    } finally {
      conn.release();
    }
    res.status(201).json({ id: result.insertId, name });
  },
);

router.put('/admin/campaigns/:id', requirePermission('campaigns', 'edit'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer, status, formId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [rows] = await pool.query('SELECT id, status FROM campaigns WHERE id = ? AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const statusError = checkCampaignStatus(status, rows[0].status);
  if (statusError) return res.status(400).json({ error: statusError });
  const formError = await checkCampaignForm(formId);
  if (formError) return res.status(400).json({ error: formError });
  const { error, settings } = parseCampaignSettings(req.body);
  if (error) return res.status(400).json({ error });
  const autoError = checkAutoDispo(settings, await getDispositions(rows[0].id));
  if (autoError) return res.status(400).json({ error: autoError });

  await pool.query('UPDATE campaigns SET ? WHERE id = ?', [
    {
      name,
      queue_id: queueId || null,
      outbound_caller_id: outboundCallerId || null,
      auto_answer: autoAnswer ? 1 : 0,
      status: status || rows[0].status,
      form_id: formId || null,
      ...settings,
    },
    req.params.id,
  ]);
  if (settings.dial_mode === 'manual') {
    await pool.query("UPDATE campaigns SET dialer_state = 'stopped' WHERE id = ? AND dialer_state <> 'stopped'", [
      req.params.id,
    ]);
  }
  res.json({ id: Number(req.params.id), name });
});

// Delete always works and keeps history (services/softDelete.js): the dialer
// stops, DIDs / teams are unlinked, its lists and leads go with it.
router.delete(
  '/admin/campaigns/:id',
  requirePermission('campaigns', 'delete'),
  requireAllScope('delete campaigns'),
  async (req, res) => {
    const notes = await deleteCampaign(Number(req.params.id), req.session.user.id);
    if (notes === null) return res.status(404).json({ error: 'campaign not found' });
    res.json({ status: 'ok', notes });
  },
);

// --- Admin: per-campaign dispositions ---
router.get('/admin/campaigns/:id/dispositions', requireAdminSide, async (req, res) => {
  if (!campaignInScope(req.access.scope, req.params.id)) return res.status(404).json({ error: 'campaign not found' });
  res.json(await getDispositions(Number(req.params.id)));
});

// Replaces the whole set. Leads keep whatever code they already have -
// a removed code just shows as its raw code in lists.
router.put('/admin/campaigns/:id/dispositions', requirePermission('campaigns', 'edit'), async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, auto_dispo_sec, auto_dispo_code FROM campaigns WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const { error, dispositions } = validateDispositions(req.body.dispositions);
  if (error) return res.status(400).json({ error });
  // The campaign's auto disposition must stay (and stay a non-callback one):
  // otherwise every automatic save - and agents choosing it - would be refused.
  if (rows[0].auto_dispo_sec > 0 && rows[0].auto_dispo_code) {
    const auto = dispositions.find((d) => d.code === rows[0].auto_dispo_code);
    if (!auto)
      return res.status(400).json({
        error: `"${rows[0].auto_dispo_code}" is this campaign's auto disposition - choose another one (or turn auto disposition off) in the campaign's dialer settings first`,
      });
    if (auto.is_callback)
      return res
        .status(400)
        .json({ error: `"${auto.label}" is the auto disposition, so it can't be a callback (that needs a time)` });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await replaceDispositions(conn, req.params.id, dispositions);
    await conn.commit();
    res.json({ status: 'ok' });
  } catch (err) {
    await conn.rollback();
    console.error('[dispositions save failed]', err);
    res.status(500).json({ error: 'failed to save dispositions' });
  } finally {
    conn.release();
  }
});

module.exports = router;
