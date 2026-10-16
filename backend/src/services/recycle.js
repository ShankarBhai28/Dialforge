// Which leads a manual recycle (Leads -> Recycle, bulk "Make dialable") may
// make dialable again - shared so both follow exactly the same rules.
// Never recycled:
//   - Do Not Call leads and numbers on the DNC list;
//   - a lead on a call right now (dialer or manual), or in wrap-up (an
//     answered call in the last 30 min without an outcome yet);
//   - a lead with a pending callback (it keeps its callback time);
//   - without "Reset attempt count": a lead that already used the campaign's
//     max attempts (the dialer would still skip it).
const { normalizePhone, OUTCOME_HOLD_MIN } = require('../../dialer-common');

const CHUNK = 1000;
const chunks = (a) =>
  Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));

async function idsWhere(db, sql, ids) {
  const out = new Set();
  for (const part of chunks(ids)) {
    const [rows] = await db.query(sql, [part]);
    rows.forEach((r) => out.add(r.lead_id));
  }
  return out;
}

/**
 * leads: [{ id, phone, status, attempts, campaign_id }]. maxAttempts(campaignId) -> number.
 * Returns { ids: [...recyclable], skipped: { dnc, onCall, callback, usedUp } }.
 */
async function planRecycle(db, leads, { resetAttempts = false, maxAttempts = () => 3 } = {}) {
  const ids = leads.map((l) => l.id);
  const phones = [...new Set(leads.map((l) => normalizePhone(l.phone)).filter(Boolean))];
  const dnc = new Set();
  for (const part of chunks(phones)) {
    const [rows] = await db.query('SELECT phone FROM dnc_numbers WHERE tenant_id = 1 AND phone IN (?)', [part]);
    rows.forEach((r) => dnc.add(r.phone));
  }
  const busy = new Set([
    ...(await idsWhere(
      db,
      "SELECT DISTINCT lead_id FROM dial_attempts WHERE lead_id IN (?) AND status <> 'ended'",
      ids,
    )),
    ...(await idsWhere(
      db,
      `SELECT DISTINCT lead_id FROM calls WHERE lead_id IN (?) AND start_time > NOW() - INTERVAL 3 HOUR AND (
         end_time IS NULL
         OR (agent_connect_time IS NOT NULL AND outcome IS NULL AND end_time > NOW() - INTERVAL ${OUTCOME_HOLD_MIN} MINUTE))`,
      ids,
    )),
  ]);
  const callbacks = await idsWhere(
    db,
    "SELECT DISTINCT lead_id FROM callbacks WHERE lead_id IN (?) AND status = 'pending'",
    ids,
  );

  const skipped = { dnc: 0, onCall: 0, callback: 0, usedUp: 0 };
  const ok = [];
  for (const l of leads) {
    if (l.status === 'do_not_call' || dnc.has(normalizePhone(l.phone))) skipped.dnc++;
    else if (busy.has(l.id)) skipped.onCall++;
    else if (callbacks.has(l.id)) skipped.callback++;
    else if (!resetAttempts && Number(l.attempts) >= maxAttempts(l.campaign_id)) skipped.usedUp++;
    else ok.push(l.id);
  }
  return { ids: ok, skipped };
}

/** Makes the planned leads dialable now (rule tries count again from now). Returns how many changed. */
async function applyRecycle(db, ids, { resetAttempts = false, userId = null } = {}) {
  let n = 0;
  for (const part of chunks(ids)) {
    const [r] = await db.query(
      `UPDATE leads SET is_final = 0, next_call_at = NULL, recycled_at = NOW(), attempts = IF(?, 0, attempts),
         updated_by = COALESCE(?, updated_by) WHERE id IN (?)`,
      [resetAttempts ? 1 : 0, userId, part],
    );
    n += r.affectedRows;
  }
  return n;
}

/** "3 skipped: 1 on the DNC list, 2 have a callback" - for notes and the dialog. */
function skippedNotes(s) {
  const parts = [];
  if (s.dnc) parts.push(`${s.dnc} Do Not Call / on the DNC list`);
  if (s.onCall) parts.push(`${s.onCall} on a call or in wrap-up`);
  if (s.callback) parts.push(`${s.callback} with a pending callback (kept for its time)`);
  if (s.usedUp) parts.push(`${s.usedUp} used all attempts - tick "Reset attempt count" to include them`);
  return parts;
}

module.exports = { planRecycle, applyRecycle, skippedNotes };
