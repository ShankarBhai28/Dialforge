// "Delete" that always works and keeps history (migration 0003).
//
// Campaigns, queues, lists, leads, forms and extensions are referenced by
// calls and reports, so they're marked deleted (deleted_at / deleted_by)
// rather than removed: they disappear from every screen, dropdown, the
// dialer and Asterisk, while history keeps showing them. Whatever still
// pointed at the item is unlinked here, in the same transaction, and the
// result says what was unlinked so the screen can tell the admin.
// Roles have no history, so a role is really deleted (its users lose it).
const pool = require('../../db');

/** Runs fn(conn) in a transaction. */
async function inTransaction(fn, deps = { pool }) {
  const conn = await deps.pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const affected = ([r]) => r.affectedRows || 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Soft-deletes leads (by condition) and cleans what was waiting on them. */
async function retireLeads(conn, where, params, userId) {
  await conn.query(
    `DELETE FROM dial_hopper WHERE lead_id IN (SELECT id FROM leads WHERE ${where} AND deleted_at IS NULL)`,
    params,
  );
  const cancelled = affected(
    await conn.query(
      `UPDATE callbacks SET status = 'cancelled' WHERE status = 'pending'
       AND lead_id IN (SELECT id FROM leads WHERE ${where} AND deleted_at IS NULL)`,
      params,
    ),
  );
  const leads = affected(
    await conn.query(`UPDATE leads SET deleted_at = NOW(), deleted_by = ? WHERE ${where} AND deleted_at IS NULL`, [
      userId,
      ...params,
    ]),
  );
  return { leads, cancelled };
}

function deleteCampaign(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    // The dialer only works "running" campaigns: stop it first.
    await conn.query(
      "UPDATE campaigns SET deleted_at = NOW(), deleted_by = ?, dialer_state = 'stopped', status = 'paused' WHERE id = ?",
      [userId, id],
    );
    const dids = affected(await conn.query('UPDATE dids SET campaign_id = NULL WHERE campaign_id = ?', [id]));
    const teams = affected(await conn.query('DELETE FROM team_campaigns WHERE campaign_id = ?', [id]));
    await conn.query('DELETE FROM dialer_status WHERE campaign_id = ?', [id]);
    const lists = affected(
      await conn.query(
        'UPDATE lists SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE campaign_id = ? AND deleted_at IS NULL',
        [userId, id],
      ),
    );
    const { leads, cancelled } = await retireLeads(conn, 'campaign_id = ?', [id], userId);
    const notes = [];
    if (lists || leads) notes.push(`${plural(lists, 'list')} and ${plural(leads, 'lead')} removed with it`);
    if (dids) notes.push(`${plural(dids, 'DID number')} no longer route to it`);
    if (teams) notes.push(`taken off ${plural(teams, 'team')}`);
    if (cancelled) notes.push(`${plural(cancelled, 'pending callback')} cancelled`);
    return notes;
  }, deps);
}

function deleteQueue(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM queues WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    const [using] = await conn.query('SELECT name FROM campaigns WHERE queue_id = ? AND deleted_at IS NULL', [id]);
    // A campaign without a queue can't dial: stop its dialer too.
    await conn.query("UPDATE campaigns SET queue_id = NULL, dialer_state = 'stopped' WHERE queue_id = ?", [id]);
    await conn.query('UPDATE queues SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [userId, id]);
    return using.length
      ? [`${using.map((c) => c.name).join(', ')} no longer ${using.length === 1 ? 'has' : 'have'} a queue`]
      : [];
  }, deps);
}

function deleteList(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM lists WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    await conn.query('UPDATE lists SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?', [userId, id]);
    const { leads, cancelled } = await retireLeads(conn, 'list_id = ?', [id], userId);
    const notes = [];
    if (leads) notes.push(`${plural(leads, 'lead')} removed with it`);
    if (cancelled) notes.push(`${plural(cancelled, 'pending callback')} cancelled`);
    return notes;
  }, deps);
}

function deleteLead(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    const { cancelled } = await retireLeads(conn, 'id = ?', [id], userId);
    return cancelled ? [`${plural(cancelled, 'pending callback')} cancelled`] : [];
  }, deps);
}

function deleteForm(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM forms WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    const [using] = await conn.query('SELECT name FROM campaigns WHERE form_id = ? AND deleted_at IS NULL', [id]);
    await conn.query('UPDATE campaigns SET form_id = NULL WHERE form_id = ?', [id]);
    await conn.query('UPDATE forms SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [userId, id]);
    return using.length
      ? [`${using.map((c) => c.name).join(', ')} no longer ${using.length === 1 ? 'has' : 'have'} a form`]
      : [];
  }, deps);
}

/** Returns { notes, userIds } - the users who lost the extension (their sessions are ended by the route). */
function deleteExtension(id, userId, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM extensions WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows[0]) return null;
    const [users] = await conn.query('SELECT id, username FROM users WHERE extension_id = ?', [id]);
    await conn.query('UPDATE users SET extension_id = NULL WHERE extension_id = ?', [id]);
    await conn.query('UPDATE extensions SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [userId, id]);
    return {
      notes: users.length
        ? [`${users.map((u) => u.username).join(', ')} no longer ${users.length === 1 ? 'has' : 'have'} an extension`]
        : [],
      userIds: users.map((u) => u.id),
    };
  }, deps);
}

/** Really deleted (no history). Returns { notes, userIds } of users who lost it. */
function deleteRole(id, deps) {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id FROM roles WHERE id = ? FOR UPDATE', [id]);
    if (!rows[0]) return null;
    const [users] = await conn.query('SELECT id, username FROM users WHERE role_id = ?', [id]);
    await conn.query('UPDATE users SET role_id = NULL WHERE role_id = ?', [id]);
    await conn.query('DELETE FROM roles WHERE id = ?', [id]);
    return {
      notes: users.length
        ? [
            `${users.map((u) => u.username).join(', ')} lost ${users.length === 1 ? 'their' : 'their'} admin access (give them another role in Users)`,
          ]
        : [],
      userIds: users.map((u) => u.id),
    };
  }, deps);
}

module.exports = { deleteCampaign, deleteQueue, deleteList, deleteLead, deleteForm, deleteExtension, deleteRole };
