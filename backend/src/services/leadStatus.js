// An admin changing a lead's status (Leads -> Edit, or bulk Status) does
// what that outcome means, the same as when an agent saves it after a call:
//   final        -> done, never dialled again (pending callback cancelled)
//   retry N min  -> dialable again after N minutes
//   other        -> dialable again now
//   marks DNC    -> the number goes on the DNC list too
//   New          -> a fresh lead: dialable now, attempts back to 0
// A callback outcome needs a date and time, which only the agent's outcome
// (or the Callbacks screen) sets, so it isn't offered here.
const { addDnc } = require('./dnc');
const { normalizePhone } = require('../../dialer-common');

const CHUNK = 1000;

/** Pure: what a status means for dialling. Returns { error } or the effect. */
function statusEffect(status, dispositions) {
  if (status === 'new') return { isFinal: 0, retryMin: null, resetAttempts: true, dnc: false };
  const d = dispositions.find((x) => x.code === status);
  if (!d) return { error: `status must be new or one of: ${dispositions.map((x) => x.code).join(', ')}` };
  if (d.is_callback)
    return { error: `"${d.label}" needs a callback date and time - the agent sets it with the outcome after a call` };
  return {
    isFinal: d.is_final ? 1 : 0,
    retryMin: !d.is_final && d.retry_after_min ? Number(d.retry_after_min) : null,
    resetAttempts: false,
    dnc: !!d.marks_dnc,
  };
}

/**
 * Applies a status and its effect to leads ({id, phone}). Returns the
 * number of leads changed and how many numbers went on the DNC list.
 */
async function applyStatus(db, leads, status, effect, userId, deps = { addDnc }) {
  let changed = 0;
  for (let i = 0; i < leads.length; i += CHUNK) {
    const ids = leads.slice(i, i + CHUNK).map((l) => l.id);
    const [r] = await db.query(
      `UPDATE leads SET status = ?, is_final = ?,
         next_call_at = ${effect.retryMin ? 'NOW() + INTERVAL ? MINUTE' : 'NULL'},
         attempts = IF(?, 0, attempts), updated_by = ?
       WHERE id IN (?)`,
      [
        status,
        effect.isFinal,
        ...(effect.retryMin ? [effect.retryMin] : []),
        effect.resetAttempts ? 1 : 0,
        userId,
        ids,
      ],
    );
    changed += r.affectedRows;
    if (effect.isFinal || effect.dnc) {
      // Done or blocked: out of the dialer, and nobody should call back.
      await db.query("DELETE FROM dial_hopper WHERE lead_id IN (?) AND status = 'ready'", [ids]);
      await db.query("UPDATE callbacks SET status = 'cancelled' WHERE lead_id IN (?) AND status = 'pending'", [ids]);
    }
  }
  let dnc = 0;
  if (effect.dnc) {
    const phones = [...new Set(leads.map((l) => normalizePhone(l.phone)).filter(Boolean))];
    for (const p of phones) if (await deps.addDnc(p, 'leads', userId)) dnc++;
  }
  return { changed, dnc };
}

module.exports = { statusEffect, applyStatus };
