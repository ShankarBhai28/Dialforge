const express = require('express');
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
    ${cond ? `WHERE ${cond}` : ''}
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
  requirePermission('campaigns', 'manage'),
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

router.put('/admin/campaigns/:id', requirePermission('campaigns', 'manage'), async (req, res) => {
  const { name, queueId, outboundCallerId, autoAnswer, status, formId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [rows] = await pool.query('SELECT id, status FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const statusError = checkCampaignStatus(status, rows[0].status);
  if (statusError) return res.status(400).json({ error: statusError });
  const formError = await checkCampaignForm(formId);
  if (formError) return res.status(400).json({ error: formError });
  const { error, settings } = parseCampaignSettings(req.body);
  if (error) return res.status(400).json({ error });

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

router.delete(
  '/admin/campaigns/:id',
  requirePermission('campaigns', 'manage'),
  requireAllScope('delete campaigns'),
  async (req, res) => {
    const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'campaign not found' });

    // Checked explicitly (rather than relying on the raw FK error) so the
    // message can actually say what's in the way, not just "a constraint
    // failed" - the whole point of the "block with a clear error" choice.
    const [didRefs] = await pool.query('SELECT number FROM dids WHERE campaign_id = ?', [req.params.id]);
    const [leadRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM leads WHERE campaign_id = ?', [req.params.id]);
    const [callRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM calls WHERE campaign_id = ?', [req.params.id]);
    const [responseRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM form_responses WHERE campaign_id = ?', [
      req.params.id,
    ]);
    const [callbackRefs] = await pool.query('SELECT COUNT(*) AS cnt FROM callbacks WHERE campaign_id = ?', [
      req.params.id,
    ]);

    const blockers = [];
    if (didRefs.length) blockers.push(`${didRefs.length} DID number(s) (${didRefs.map((d) => d.number).join(', ')})`);
    if (leadRefs[0].cnt > 0) blockers.push(`${leadRefs[0].cnt} lead(s)`);
    if (callRefs[0].cnt > 0) blockers.push(`${callRefs[0].cnt} call record(s)`);
    if (responseRefs[0].cnt > 0) blockers.push(`${responseRefs[0].cnt} form response(s)`);
    if (callbackRefs[0].cnt > 0) blockers.push(`${callbackRefs[0].cnt} callback(s)`);
    if (blockers.length) {
      return res.status(409).json({
        error: `Cannot delete - still referenced by ${blockers.join(' and ')}. Reassign or remove them first.`,
      });
    }

    // Its settings rows go with it - a leftover team mapping would point at
    // a campaign that no longer exists.
    for (const table of ['team_campaigns', 'campaign_recycle_rules', 'campaign_dispositions', 'dialer_status']) {
      await pool.query(`DELETE FROM ${table} WHERE campaign_id = ?`, [req.params.id]);
    }
    await pool.query('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
    res.json({ status: 'ok' });
  },
);

// --- Admin: per-campaign dispositions ---
router.get('/admin/campaigns/:id/dispositions', requireAdminSide, async (req, res) => {
  if (!campaignInScope(req.access.scope, req.params.id)) return res.status(404).json({ error: 'campaign not found' });
  res.json(await getDispositions(Number(req.params.id)));
});

// Replaces the whole set. Leads keep whatever code they already have -
// a removed code just shows as its raw code in lists.
router.put('/admin/campaigns/:id/dispositions', requirePermission('campaigns', 'manage'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ?', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const { error, dispositions } = validateDispositions(req.body.dispositions);
  if (error) return res.status(400).json({ error });
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
