const express = require('express');
const pool = require('../../db');
const { DEFAULT_RECYCLE_RULES, getRecycleRules } = require('../../dialer-common');
const { requirePermission } = require('../middleware/auth');
const { getDispositions } = require('../services/dispositions');
const { applyRecycle, planRecycle, skippedNotes } = require('../services/recycle');

const { campaignInScope } = require('../services/access');

const router = express.Router();

// --- Recycling (D9) ---
// Automatic: per-campaign rules for when the dialer redials after an
// unsuccessful call (applied in dialer-common.js finishAttempt).
const RECYCLE_RULE_LABELS = {
  no_answer: 'No answer',
  busy: 'Busy',
  machine: 'Answering machine',
  congestion: 'Network error',
  abandoned: 'Abandoned',
};

router.get('/admin/campaigns/:id/recycle-rules', requirePermission('campaigns', 'view'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const rules = await getRecycleRules(pool, Number(req.params.id));
  res.json(Object.keys(rules).map((key) => ({ result: key, label: RECYCLE_RULE_LABELS[key], ...rules[key] })));
});

router.put('/admin/campaigns/:id/recycle-rules', requirePermission('campaigns', 'edit'), async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!rows[0] || !campaignInScope(req.access.scope, rows[0].id))
    return res.status(404).json({ error: 'campaign not found' });
  const input = req.body.rules || {};
  const values = [];
  for (const key of Object.keys(DEFAULT_RECYCLE_RULES)) {
    const r = input[key];
    const label = RECYCLE_RULE_LABELS[key];
    if (!r) return res.status(400).json({ error: `${label}: rule missing` });
    const delay = Number(r.delayMin);
    const tries = Number(r.maxTries);
    if (!Number.isInteger(delay) || delay < 1 || delay > 10080) {
      return res.status(400).json({ error: `${label}: "redial after" must be 1-10080 minutes` });
    }
    if (!Number.isInteger(tries) || tries < 1 || tries > 20) {
      return res.status(400).json({ error: `${label}: "max times" must be a whole number 1-20` });
    }
    values.push([req.params.id, key, r.enabled ? 1 : 0, delay, tries]);
  }
  await pool.query(
    `INSERT INTO campaign_recycle_rules (campaign_id, result, enabled, delay_min, max_tries) VALUES ?
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), delay_min = VALUES(delay_min), max_tries = VALUES(max_tries)`,
    [values],
  );
  res.json({ status: 'ok' });
});

// Manual: "recycle" a list - leads with the chosen statuses become
// dialable again right away. Do Not Call is never recycled, nor any number
// on the DNC list or a lead on a call right now.
const NEVER_RECYCLE = ['do_not_call'];

async function listWithCampaign(listId) {
  const [rows] = await pool.query(
    `SELECT ls.id, ls.name, ls.campaign_id, COALESCE(c.max_attempts, 3) AS max_attempts
     FROM lists ls LEFT JOIN campaigns c ON c.id = ls.campaign_id WHERE ls.id = ? AND ls.deleted_at IS NULL`,
    [listId],
  );
  return rows[0] || null;
}

// What's in the list, by lead status: how many can be dialed now, are
// waiting for their retry time, or are done (final / attempts used up).
router.get('/admin/lists/:id/recycle', requirePermission('leads', 'view'), async (req, res) => {
  const list = await listWithCampaign(req.params.id);
  if (!list || !campaignInScope(req.access.scope, list.campaign_id))
    return res.status(404).json({ error: 'list not found' });
  const [statuses] = await pool.query(
    `SELECT status, COUNT(*) AS total,
       SUM(is_final = 0 AND attempts < ? AND (next_call_at IS NULL OR next_call_at <= NOW())) AS dialable,
       SUM(is_final = 0 AND attempts < ? AND next_call_at > NOW()) AS scheduled,
       SUM(is_final = 1 OR attempts >= ?) AS done
     FROM leads WHERE list_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY total DESC`,
    [list.max_attempts, list.max_attempts, list.max_attempts, list.id],
  );
  const dispositions = await getDispositions(list.campaign_id);
  const labels = Object.fromEntries(dispositions.map((d) => [d.code, d.label]));
  const success = new Set(dispositions.filter((d) => d.is_success).map((d) => d.code));
  const [history] = await pool.query(
    `SELECT r.statuses, r.reset_attempts, r.leads_recycled, r.created_at, u.username
     FROM recycle_log r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.list_id = ? ORDER BY r.id DESC LIMIT 5`,
    [list.id],
  );
  res.json({
    list: { id: list.id, name: list.name, maxAttempts: list.max_attempts },
    statuses: statuses.map((s) => ({
      status: s.status,
      label: labels[s.status] || null,
      total: Number(s.total),
      dialable: Number(s.dialable),
      scheduled: Number(s.scheduled),
      done: Number(s.done),
      recyclable: !NEVER_RECYCLE.includes(s.status),
      // A success outcome (sale, interested): recycling it calls those customers again.
      success: success.has(s.status),
    })),
    history,
  });
});

router.post('/admin/lists/:id/recycle', requirePermission('leads', 'recycle'), async (req, res) => {
  const list = await listWithCampaign(req.params.id);
  if (!list || !campaignInScope(req.access.scope, list.campaign_id))
    return res.status(404).json({ error: 'list not found' });
  const { statuses, resetAttempts } = req.body;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((s) => typeof s === 'string' && s.length <= 30)
  ) {
    return res.status(400).json({ error: 'pick at least one status to recycle' });
  }
  if (statuses.some((s) => NEVER_RECYCLE.includes(s))) {
    return res.status(400).json({ error: 'Do Not Call leads can never be recycled' });
  }
  const [candidates] = await pool.query(
    'SELECT id, phone, status, attempts, campaign_id FROM leads WHERE list_id = ? AND deleted_at IS NULL AND status IN (?)',
    [list.id, statuses],
  );
  // The same rules as bulk "Make dialable" (services/recycle.js).
  const { ids, skipped } = await planRecycle(pool, candidates, {
    resetAttempts: !!resetAttempts,
    maxAttempts: () => Number(list.max_attempts),
  });
  await applyRecycle(pool, ids, { resetAttempts: !!resetAttempts, userId: req.session.user.id });
  await pool.query(
    'INSERT INTO recycle_log (list_id, user_id, statuses, reset_attempts, leads_recycled) VALUES (?, ?, ?, ?, ?)',
    [list.id, req.session.user.id, statuses.join(', ').slice(0, 500), resetAttempts ? 1 : 0, ids.length],
  );
  res.json({
    recycled: ids.length,
    skippedDnc: skipped.dnc,
    skippedOnCall: skipped.onCall,
    skippedCallback: skipped.callback,
    skippedUsedUp: skipped.usedUp,
    notes: skippedNotes(skipped),
  });
});

module.exports = router;
