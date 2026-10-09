const express = require('express');
const pool = require('../../db');
const { isWithinCallWindow } = require('../../dialer-common');
const { requireCaller } = require('../middleware/auth');
const { currentAgentStatus, findCurrentCampaign } = require('../services/agents');
const { previewLockOwner } = require('../services/preview');

const router = express.Router();

async function previewLeadDetails(hopperRow) {
  const [rows] = await pool.query(
    `
    SELECT l.id, l.name, l.phone, l.alt_phone, l.status, l.attempts, l.custom_data, ls.name AS list_name,
      cb.callback_at, cb.note AS callback_note
    FROM leads l
    LEFT JOIN lists ls ON ls.id = l.list_id
    LEFT JOIN callbacks cb ON cb.lead_id = l.id AND cb.status = 'pending'
    WHERE l.id = ?
  `,
    [hopperRow.lead_id],
  );
  return rows[0] ? { ...rows[0], is_callback: !!hopperRow.is_callback } : null;
}

// Why the agent can't get a preview lead right now (null = they can).
async function previewBlocker(userId, campaign) {
  if (!campaign) return 'pick a queue first';
  if (campaign.dial_mode !== 'preview') return 'not a preview campaign';
  if (campaign.dialer_state !== 'running') return `dialer is ${campaign.dialer_state} for this campaign`;
  if (!isWithinCallWindow(campaign)) return 'outside calling hours';
  if ((await currentAgentStatus(userId)) !== 'available') return 'go Available to get leads';
  return null;
}

router.get('/agent/preview', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const campaign = await findCurrentCampaign(req.session.user.id);
  if (!campaign || campaign.dial_mode !== 'preview') return res.json({ enabled: false });
  const [held] = await pool.query('SELECT * FROM dial_hopper WHERE locked_by = ? AND campaign_id = ? LIMIT 1', [
    previewLockOwner(req.session.user.id),
    campaign.id,
  ]);
  res.json({
    enabled: true,
    blocker: await previewBlocker(req.session.user.id, campaign),
    autodialSec: campaign.preview_autodial_sec || 0,
    lead: held[0] ? await previewLeadDetails(held[0]) : null,
  });
});

router.post('/agent/preview/next', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const userId = req.session.user.id;
  const campaign = await findCurrentCampaign(userId);
  const blocker = await previewBlocker(userId, campaign);
  if (blocker) return res.json({ lead: null, blocker });

  const owner = previewLockOwner(userId);
  // Already holding one (e.g. page refresh) - give the same lead back.
  const [held] = await pool.query('SELECT * FROM dial_hopper WHERE locked_by = ? AND campaign_id = ? LIMIT 1', [
    owner,
    campaign.id,
  ]);
  if (held[0]) return res.json({ lead: await previewLeadDetails(held[0]) });

  // FOR UPDATE SKIP LOCKED: two agents asking at the same moment each get
  // a different row instead of one waiting on (or stealing) the other's.
  const conn = await pool.getConnection();
  let row = null;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `
      SELECT * FROM dial_hopper
      WHERE campaign_id = ? AND status = 'ready' AND (reserved_user_id IS NULL OR reserved_user_id = ?)
      ORDER BY (reserved_user_id = ?) DESC, is_callback DESC, list_priority DESC, lead_priority DESC, attempts, lead_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `,
      [campaign.id, userId, userId],
    );
    row = rows[0] || null;
    if (row) {
      await conn.query("UPDATE dial_hopper SET status = 'locked', locked_at = NOW(), locked_by = ? WHERE id = ?", [
        owner,
        row.id,
      ]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[preview next failed]', err);
    return res.status(500).json({ error: 'failed to get next lead' });
  } finally {
    conn.release();
  }
  if (!row) return res.json({ lead: null, blocker: 'no leads waiting - the hopper is empty' });
  res.json({ lead: await previewLeadDetails(row) });
});

// Skip: lead leaves the hopper and isn't offered again for 15 minutes.
router.post('/agent/preview/skip', requireCaller, async (req, res) => {
  if (req.session.user.role !== 'agent') return res.status(403).json({ error: 'agents only' });
  const [held] = await pool.query('SELECT id, lead_id FROM dial_hopper WHERE locked_by = ?', [
    previewLockOwner(req.session.user.id),
  ]);
  if (!held[0]) return res.status(404).json({ error: 'you have no preview lead' });
  await pool.query('DELETE FROM dial_hopper WHERE id = ?', [held[0].id]);
  await pool.query('UPDATE leads SET next_call_at = NOW() + INTERVAL 15 MINUTE WHERE id = ?', [held[0].lead_id]);
  res.json({ status: 'ok' });
});

module.exports = router;
