const express = require('express');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { requirePermission, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');

const { likeTerm, pageResult, parsePaging, whereClause } = require('../services/paging');

const { campaignInScope, scopeCondition } = require('../services/access');
const { audit } = require('../services/audit');
const { editCallback } = require('../services/callbacks');

const router = express.Router();

// Pending callbacks the agent should see: their own, plus "anyone"
// callbacks in the campaign they're currently working.
router.get('/agent/callbacks', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  const [rows] = await pool.query(
    `
    SELECT cb.id, cb.lead_id, cb.callback_at, cb.note, cb.user_id, l.name, l.phone, c.name AS campaign_name
    FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    WHERE cb.status = 'pending'
      AND (cb.user_id = ? OR (cb.user_id IS NULL AND cb.campaign_id = ?))
    ORDER BY cb.callback_at
    LIMIT 100
  `,
    [req.session.user.id, campaign ? campaign.id : -1],
  );
  res.json(rows);
});

// ?status= pending|overdue|done|cancelled &campaignId= &q= (lead name or phone) &page= &pageSize=
router.get('/admin/callbacks', requirePermission('callbacks', 'view'), async (req, res) => {
  const paging = parsePaging(req.query);
  const { status, campaignId, q } = req.query;
  const digits = normalizePhone(q || '');
  const where = whereClause([
    [
      status === 'overdue'
        ? "cb.status = 'pending' AND cb.callback_at <= NOW()"
        : ['pending', 'done', 'cancelled'].includes(status)
          ? 'cb.status = ?'
          : '',
      status === 'overdue' ? [] : [status],
    ],
    [campaignId ? 'cb.campaign_id = ?' : '', [campaignId]],
    scopeCondition(req.access.scope, 'campaigns', 'cb.campaign_id'),
    [
      q ? `(l.name LIKE ?${digits ? ' OR l.phone LIKE ?' : ''})` : '',
      q ? [likeTerm(q.trim()), ...(digits ? [likeTerm(digits)] : [])] : [],
    ],
  ]);
  const from = `FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    LEFT JOIN campaigns c ON c.id = cb.campaign_id
    LEFT JOIN users u ON u.id = cb.user_id
    JOIN users cu ON cu.id = cb.created_by
    ${where.sql}`;
  const [rows] = await pool.query(
    `SELECT cb.id, cb.callback_at, cb.status, cb.note, cb.campaign_id, cb.user_id, l.name, l.phone, c.name AS campaign_name,
      u.username AS assigned_to, cu.username AS created_by_name
     ${from}
     ORDER BY cb.status = 'pending' DESC, cb.callback_at
     LIMIT ? OFFSET ?`,
    [...where.params, paging.pageSize, paging.offset],
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n ${from}`, where.params);
  res.json(pageResult(rows, count.n, paging));
});

// Edit a pending callback: time, note, who takes it (userId: an agent; null = anyone in the campaign).
router.put('/admin/callbacks/:id', requirePermission('callbacks', 'edit'), async (req, res) => {
  const [[cb]] = await pool.query("SELECT campaign_id FROM callbacks WHERE id = ? AND status = 'pending'", [
    req.params.id,
  ]);
  if (!cb || !campaignInScope(req.access.scope, cb.campaign_id))
    return res.status(404).json({ error: 'no pending callback with that id' });
  const { callbackAt, note } = req.body;
  const userId = req.body.userId === undefined ? undefined : req.body.userId ? Number(req.body.userId) : null;
  if (userId) {
    const agents = await campaignAgents(cb.campaign_id);
    if (!agents.some((a) => a.id === userId))
      return res.status(400).json({ error: "that agent isn't in a team working this campaign" });
  }
  const r = await editCallback(Number(req.params.id), { callbackAt, note, userId });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ status: 'ok', callback: r.after });
});

// Who a callback can be given to: active agents of the teams working its campaign.
async function campaignAgents(campaignId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id, u.username FROM users u
     JOIN team_members tm ON tm.user_id = u.id
     JOIN team_campaigns tc ON tc.team_id = tm.team_id
     WHERE u.role = 'agent' AND u.status = 'active' AND tc.campaign_id = ?
     ORDER BY u.username`,
    [campaignId],
  );
  return rows;
}

router.get('/admin/callbacks/:id/agents', requirePermission('callbacks', 'edit'), async (req, res) => {
  const [[cb]] = await pool.query('SELECT campaign_id FROM callbacks WHERE id = ?', [req.params.id]);
  if (!cb || !campaignInScope(req.access.scope, cb.campaign_id))
    return res.status(404).json({ error: 'callback not found' });
  res.json(await campaignAgents(cb.campaign_id));
});

// Agent: change a callback they can see (their own, or "anyone" in their
// current campaign): time, note, and mine (true = me, false = anyone).
router.put('/agent/callbacks/:id', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const me = req.session.user.id;
  const campaign = await findCurrentCampaign(me);
  const [[cb]] = await pool.query(
    `SELECT id FROM callbacks WHERE id = ? AND status = 'pending'
       AND (user_id = ? OR (user_id IS NULL AND campaign_id = ?))`,
    [req.params.id, me, campaign ? campaign.id : -1],
  );
  if (!cb) return res.status(404).json({ error: 'no pending callback of yours with that id' });
  const { callbackAt, note, mine } = req.body;
  const r = await editCallback(Number(req.params.id), {
    callbackAt,
    note,
    userId: mine === undefined ? undefined : mine ? me : null,
  });
  if (r.error) return res.status(r.status).json({ error: r.error });
  await audit({
    user: req.session.user,
    action: 'callbacks.edit',
    entity: 'callbacks',
    entityId: Number(req.params.id),
    status: 200,
    summary: 'Callback changed by the agent',
    request: req.body,
    before: r.before,
    after: r.after,
    ip: req.ip,
  }).catch((err) => console.error('[audit callbacks.edit failed]', err.message));
  res.json({ status: 'ok', callback: r.after });
});

router.post('/admin/callbacks/:id/cancel', requirePermission('callbacks', 'cancel'), async (req, res) => {
  const [cond, params] = scopeCondition(req.access.scope, 'campaigns', 'campaign_id');
  const [result] = await pool.query(
    `UPDATE callbacks SET status = 'cancelled' WHERE id = ? AND status = 'pending'${cond ? ` AND ${cond}` : ''}`,
    [req.params.id, ...params],
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'no pending callback with that id' });
  res.json({ status: 'ok' });
});

module.exports = router;
