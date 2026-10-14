// Undo a list delete (Leads -> Lists -> Deleted lists -> Restore).
//
// A deleted list's leads were deleted in the same transaction, so they carry
// the list's exact deleted_at: those (and only those - leads deleted on
// their own before stay deleted) come back with their ids, attempts, status
// and history. A number that has an active lead again in the campaign (the
// number was re-imported or re-created meanwhile) stays deleted, so there are
// no duplicates. The list comes back inactive: the dialer doesn't start on it
// until someone switches it on. Callbacks cancelled by the delete stay
// cancelled (they can't be told apart from ones cancelled otherwise).
const pool = require('../../db');

/** Leads deleted together with the list, and which of them clash with an active lead now. */
const CANDIDATES = `
  SELECT l.id, l.phone,
         EXISTS (SELECT 1 FROM leads a
                 WHERE a.deleted_at IS NULL AND a.campaign_id <=> l.campaign_id AND a.id <> l.id
                   AND (a.phone = l.phone OR a.alt_phone = l.phone
                        OR (l.alt_phone IS NOT NULL AND l.alt_phone <> '' AND (a.phone = l.alt_phone OR a.alt_phone = l.alt_phone)))
         ) AS clash
  FROM leads l JOIN lists ls ON ls.id = l.list_id
  WHERE l.list_id = ? AND l.deleted_at = ls.deleted_at`;

/** Deleted lists the caller may see, newest first, with what a restore would do. */
async function deletedLists(inScope, deps = { pool }) {
  const [rows] = await deps.pool.query(
    `SELECT ls.id, ls.name, ls.campaign_id, c.name AS campaign, c.deleted_at AS campaign_deleted_at,
            ls.deleted_at, u.username AS deleted_by
     FROM lists ls
     LEFT JOIN campaigns c ON c.id = ls.campaign_id
     LEFT JOIN users u ON u.id = ls.deleted_by
     WHERE ls.deleted_at IS NOT NULL
     ORDER BY ls.deleted_at DESC LIMIT 200`,
  );
  const out = [];
  for (const r of rows.filter((x) => inScope(x.campaign_id))) {
    const [cands] = await deps.pool.query(CANDIDATES, [r.id]);
    const clashes = cands.filter((x) => Number(x.clash)).length;
    out.push({
      id: r.id,
      name: r.name,
      campaignId: r.campaign_id,
      campaign: r.campaign,
      campaignDeleted: !!r.campaign_deleted_at,
      deletedAt: r.deleted_at,
      deletedBy: r.deleted_by || null,
      leads: cands.length,
      clashes,
    });
  }
  return out;
}

class RestoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Restores the list and its leads (one transaction). Returns { restored, skipped }. */
async function restoreList(id, { inScope }, deps = { pool }) {
  const conn = await deps.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT ls.id, ls.name, ls.campaign_id, ls.deleted_at, c.deleted_at AS campaign_deleted_at
       FROM lists ls LEFT JOIN campaigns c ON c.id = ls.campaign_id WHERE ls.id = ? FOR UPDATE`,
      [id],
    );
    const list = rows[0];
    if (!list || !inScope(list.campaign_id)) throw new RestoreError(404, 'list not found');
    if (!list.deleted_at) throw new RestoreError(409, 'this list is not deleted');
    if (list.campaign_deleted_at) {
      throw new RestoreError(409, "its campaign is deleted too - a list can't come back without its campaign");
    }
    const [cands] = await conn.query(CANDIDATES, [id]);
    const restoreIds = cands.filter((x) => !Number(x.clash)).map((x) => x.id);
    const skipped = cands.length - restoreIds.length;
    // List first: the leads are found by the list's deleted_at.
    if (restoreIds.length) {
      await conn.query('UPDATE leads SET deleted_at = NULL, deleted_by = NULL WHERE id IN (?)', [restoreIds]);
    }
    await conn.query('UPDATE lists SET deleted_at = NULL, deleted_by = NULL, is_active = 0 WHERE id = ?', [id]);
    await conn.commit();
    return { id: list.id, name: list.name, restored: restoreIds.length, skipped };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { deletedLists, restoreList, RestoreError };
