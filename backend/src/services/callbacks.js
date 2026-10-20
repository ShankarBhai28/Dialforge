// Callbacks: the time rule shared by scheduling (a callback disposition) and
// editing, and the edit itself.
const pool = require('../../db');

const MAX_DAYS = 90;

/** A callback time: valid, not in the past (a minute's slack), within 90 days. { when } or { error }. */
function checkCallbackTime(value, now = Date.now()) {
  const when = new Date(value);
  if (!value || Number.isNaN(when.getTime())) return { error: 'pick a callback date and time' };
  if (when.getTime() < now - 60 * 1000) return { error: 'callback time is in the past' };
  if (when.getTime() > now + MAX_DAYS * 24 * 3600 * 1000) return { error: `callback must be within ${MAX_DAYS} days` };
  return { when };
}

/**
 * Change a pending callback: its time, note and who takes it (userId: an
 * agent, or null = anyone in the campaign; undefined = unchanged). The lead's
 * next call time follows the new time, so the dialer calls it then.
 * Returns { before, after } or { error, status }.
 */
async function editCallback(id, changes, deps = { pool }) {
  const conn = await deps.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cb]] = await conn.query(
      "SELECT id, lead_id, campaign_id, user_id, callback_at, note FROM callbacks WHERE id = ? AND status = 'pending' FOR UPDATE",
      [id],
    );
    if (!cb) {
      await conn.rollback();
      return { status: 404, error: 'no pending callback with that id' };
    }
    const next = { callback_at: cb.callback_at, note: cb.note, user_id: cb.user_id };
    if (changes.callbackAt !== undefined) {
      const t = checkCallbackTime(changes.callbackAt);
      if (t.error) {
        await conn.rollback();
        return { status: 400, error: t.error };
      }
      next.callback_at = t.when;
    }
    if (changes.note !== undefined) next.note = changes.note ? String(changes.note).trim().slice(0, 255) || null : null;
    if (changes.userId !== undefined) {
      if (changes.userId !== null) {
        const [[agent]] = await conn.query(
          "SELECT id FROM users WHERE id = ? AND role = 'agent' AND status = 'active'",
          [changes.userId],
        );
        if (!agent) {
          await conn.rollback();
          return { status: 400, error: 'pick an active agent (or anyone in the campaign)' };
        }
      }
      next.user_id = changes.userId;
    }
    await conn.query('UPDATE callbacks SET callback_at = ?, note = ?, user_id = ? WHERE id = ?', [
      next.callback_at,
      next.note,
      next.user_id,
      id,
    ]);
    // The lead waits for this callback: its next call moves with it.
    if (changes.callbackAt !== undefined)
      await conn.query('UPDATE leads SET next_call_at = ? WHERE id = ? AND is_final = 0', [
        next.callback_at,
        cb.lead_id,
      ]);
    await conn.commit();
    return {
      leadId: cb.lead_id,
      campaignId: cb.campaign_id,
      before: { callbackAt: cb.callback_at, note: cb.note, userId: cb.user_id },
      after: { callbackAt: next.callback_at, note: next.note, userId: next.user_id },
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { checkCallbackTime, editCallback };
