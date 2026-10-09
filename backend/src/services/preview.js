const pool = require('../../db');

// --- Agent: Preview mode (D6) ---
// The agent "claims" the next hopper lead: the row is locked to them
// (locked_by = user:<id>) so no other agent or the dialer can take it,
// they read it, then Dial (normal click2call) or Skip.
const previewLockOwner = (userId) => `user:${userId}`;

// Locks are given back to the hopper when the agent stops working that
// campaign (break, ACW, logout, switching queue) - otherwise a lead would
// sit locked until the engine's 10-minute stale-lock expiry.
async function releasePreviewLocks(userId, keepCampaignId) {
  await pool.query(
    `UPDATE dial_hopper SET status = 'ready', locked_at = NULL, locked_by = NULL
     WHERE locked_by = ? AND (? IS NULL OR campaign_id <> ?)`,
    [previewLockOwner(userId), keepCampaignId || null, keepCampaignId || null],
  );
}

module.exports = { previewLockOwner, releasePreviewLocks };
