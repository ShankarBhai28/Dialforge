const express = require('express');
const pool = require('../../db');
const ari = require('../../ari');
const { isWithinCallWindow, normalizePhone } = require('../../dialer-common');
const { APP_NAME } = require('../config');
const { requirePermission, requireCaller } = require('../middleware/auth');
const { findCurrentCampaign } = require('../services/agents');
const { logEvent } = require('../services/calls');
const { isDnc } = require('../services/dnc');
const { previewLockOwner } = require('../services/preview');
const { activeCalls } = require('../state');

const { likeTerm, pageResult, parsePaging, whereClause } = require('../services/paging');

const { scopeCondition } = require('../services/access');

const router = express.Router();

// --- Calls (admin sees everything, agent sees only their own extension's calls) ---
router.get('/calls', requireCaller, async (req, res) => {
  if (req.session.user.role === 'admin') {
    const [rows] = await pool.query('SELECT * FROM calls ORDER BY id DESC LIMIT 100');
    return res.json(rows);
  }
  const [rows] = await pool.query('SELECT * FROM calls WHERE from_extension = ? ORDER BY id DESC LIMIT 100', [
    req.session.user.extensionName,
  ]);
  res.json(rows);
});

// --- Admin: call log, searched and paged on the server ---
// ?q= (number) &direction= &disposition= ('none' = not answered) &extension= &from=&to= (YYYY-MM-DD) &page=
router.get('/admin/calls', requirePermission('calls', 'view'), async (req, res) => {
  const paging = parsePaging(req.query);
  const { q, direction, disposition, extension, from, to } = req.query;
  const digits = normalizePhone(q || '');
  const where = whereClause([
    [digits ? 'ca.to_number LIKE ?' : '', [likeTerm(digits)]],
    [direction ? 'ca.direction = ?' : '', [direction]],
    [
      disposition === 'none' ? 'ca.disposition IS NULL' : disposition ? 'ca.disposition = ?' : '',
      disposition && disposition !== 'none' ? [disposition] : [],
    ],
    [extension ? 'ca.from_extension = ?' : '', [extension]],
    [from ? 'ca.start_time >= ?' : '', [from]],
    [to ? 'ca.start_time < DATE_ADD(?, INTERVAL 1 DAY)' : '', [to]],
    scopeCondition(req.access.scope, 'campaigns', 'ca.campaign_id'),
  ]);
  const [rows] = await pool.query(
    `SELECT ca.*, c.name AS campaign_name, l.name AS lead_name
     FROM calls ca
     LEFT JOIN campaigns c ON c.id = ca.campaign_id
     LEFT JOIN leads l ON l.id = ca.lead_id
     ${where.sql}
     ORDER BY ca.id DESC LIMIT ? OFFSET ?`,
    [...where.params, paging.pageSize, paging.offset],
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM calls ca ${where.sql}`, where.params);
  res.json(pageResult(rows, count.n, paging));
});

router.post('/calls/click2call', requireCaller, async (req, res) => {
  const { toNumber, leadId } = req.body;
  // Agents can only ever call from their own assigned extension - never
  // trust a client-supplied fromExtension for that role. Admins (who have
  // no extension of their own) may still specify one for testing.
  const fromExtension = req.session.user.role === 'agent' ? req.session.user.extensionName : req.body.fromExtension;

  if (!fromExtension || !toNumber) {
    return res.status(400).json({ error: 'fromExtension and toNumber are required' });
  }

  // Do Not Call is enforced here, not just a label an agent can override -
  // real compliance behavior, not cosmetic.
  if (leadId) {
    const [leadRows] = await pool.query('SELECT status FROM leads WHERE id = ?', [leadId]);
    if (leadRows[0] && leadRows[0].status === 'do_not_call') {
      return res.status(403).json({ error: 'this lead is marked Do Not Call' });
    }
  }

  if (await isDnc(toNumber)) {
    return res.status(403).json({ error: 'this number is on the Do Not Call list' });
  }

  const campaign = req.session.user.role === 'agent' ? await findCurrentCampaign(req.session.user.id) : null;

  // Calling hours only apply to real outside calls through the trunk,
  // not to internal extension-to-extension test calls.
  const [extRows] = await pool.query('SELECT 1 FROM extensions WHERE name = ? LIMIT 1', [toNumber]);
  if (campaign && extRows.length === 0 && !isWithinCallWindow(campaign)) {
    return res.status(403).json({
      error: `outside this campaign's calling hours (${campaign.call_window_start.slice(0, 5)}-${campaign.call_window_end.slice(0, 5)} ${campaign.timezone})`,
    });
  }

  if (leadId) {
    const [inHopper] = await pool.query('SELECT locked_by FROM dial_hopper WHERE lead_id = ?', [leadId]);
    if (inHopper[0] && inHopper[0].locked_by && inHopper[0].locked_by !== previewLockOwner(req.session.user.id)) {
      return res.status(409).json({ error: 'another agent is previewing this lead right now' });
    }
    await pool.query('DELETE FROM dial_hopper WHERE lead_id = ?', [leadId]);
    await pool.query('UPDATE leads SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?', [leadId]);
  }

  const [insertResult] = await pool.query(
    `INSERT INTO calls (tenant_id, lead_id, direction, from_extension, to_number, campaign_id)
     VALUES (1, ?, 'outbound', ?, ?, ?)`,
    [leadId || null, fromExtension, toNumber, campaign ? campaign.id : null],
  );
  const callId = insertResult.insertId;
  await logEvent(callId, 'originated', { fromExtension, toNumber });

  try {
    // Leg 1: ring the agent's own extension first.
    const agentChannel = await ari.originate({
      endpoint: `PJSIP/${fromExtension}`,
      app: APP_NAME,
      appArgs: `click2call,${callId},agent`,
    });
    activeCalls.set(callId, { agentChannelId: agentChannel.id, destChannelId: null, bridgeId: null });
    res.status(202).json({ callId, status: 'ringing_agent' });
  } catch (err) {
    await logEvent(callId, 'error', { message: err.message });
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
