// The lead holds the CURRENT version of its form fields (leads.custom_data):
// agents' form saves, admin edits and upload updates all change it, and
// each change is kept in the history (form_responses.changes, audit log).
const { normalizePhone } = require('../../dialer-common');

// One name per customer: a campaign form field with this key IS the lead's
// name (leads.name) - an agent saving it renames the lead, and the form shows
// the lead's name. Kept in custom_data too, so the form keeps working as is.
const NAME_KEY = 'name';

const parse = (v) => (v == null ? {} : typeof v === 'string' ? JSON.parse(v || '{}') : v) || {};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** [{ key, from, to }] for the keys whose value differs (empty and missing count as the same). */
function diffCustom(before, after, keys = null) {
  const b = parse(before);
  const a = parse(after);
  const all = keys || [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return all
    .filter((k) => !(empty(b[k]) && empty(a[k])) && !same(b[k], a[k]))
    .map((k) => ({ key: k, from: empty(b[k]) ? null : b[k], to: empty(a[k]) ? null : a[k] }));
}

/**
 * The current values after a save that changed only `keys` to the values in
 * `values` (an empty value removes the key). Values not in `keys` stay as
 * they are - so a stale screen can't undo someone else's change.
 */
function mergeChanged(current, values, keys) {
  const next = { ...parse(current) };
  for (const k of keys) {
    if (empty(values[k])) delete next[k];
    else next[k] = values[k];
  }
  return next;
}

/**
 * A first call's lead was just created (or found) at the outcome: answers
 * saved during that call, before the lead existed, now belong to it and
 * fill its current values where it has none.
 */
async function adoptCallForms(db, leadId, callId) {
  if (!leadId || !callId) return 0;
  const [rows] = await db.query(
    'SELECT id, data FROM form_responses WHERE call_id = ? AND lead_id IS NULL ORDER BY id',
    [callId],
  );
  if (!rows.length) return 0;
  await db.query('UPDATE form_responses SET lead_id = ? WHERE id IN (?)', [leadId, rows.map((r) => r.id)]);
  const [[lead]] = await db.query('SELECT custom_data FROM leads WHERE id = ?', [leadId]);
  const next = parse(lead && lead.custom_data);
  for (const r of rows) for (const [k, v] of Object.entries(parse(r.data))) if (!empty(v)) next[k] = v;
  // The form's Name is the lead's name when the lead has none yet.
  const name = empty(next[NAME_KEY]) ? null : String(next[NAME_KEY]).slice(0, 100);
  await db.query("UPDATE leads SET custom_data = ?, name = COALESCE(NULLIF(name, ''), ?) WHERE id = ?", [
    Object.keys(next).length ? JSON.stringify(next) : null,
    name,
    leadId,
  ]);
  return rows.length;
}

/** Variants a number is stored under in calls (as dialled / received). */
const numberVariants = (phones) =>
  phones
    .map(normalizePhone)
    .filter(Boolean)
    .flatMap((n) => [n, `91${n}`, `0${n}`, `+91${n}`]);

module.exports = { NAME_KEY, diffCustom, mergeChanged, adoptCallForms, numberVariants, parseCustom: parse };
