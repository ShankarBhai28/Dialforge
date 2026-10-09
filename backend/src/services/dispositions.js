const pool = require('../../db');

// Seeded into every new campaign - same codes the system always used.
const DEFAULT_DISPOSITIONS = [
  { code: 'interested', label: 'Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'not_interested', label: 'Not Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'callback', label: 'Callback', is_final: 0, retry_after_min: null, marks_dnc: 0, is_callback: 1 },
  { code: 'no_answer', label: 'No Answer', is_final: 0, retry_after_min: 60, marks_dnc: 0, is_callback: 0 },
  { code: 'do_not_call', label: 'Do Not Call', is_final: 1, retry_after_min: null, marks_dnc: 1, is_callback: 0 },
];

// A lead with no campaign (e.g. added by an admin without one) falls back
// to the defaults so it can still be dispositioned.
async function getDispositions(campaignId) {
  if (!campaignId) return DEFAULT_DISPOSITIONS;
  const [rows] = await pool.query(
    'SELECT code, label, is_final, retry_after_min, marks_dnc, is_callback FROM campaign_dispositions WHERE campaign_id = ? ORDER BY sort_order, id',
    [campaignId],
  );
  return rows;
}

function validateDispositions(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'a campaign needs at least one disposition' };
  const seen = new Set();
  const cleaned = [];
  for (const d of list) {
    const code = String(d.code || '').trim();
    const label = String(d.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(code))
      return { error: `code "${code}" must be lowercase letters, digits, underscores, starting with a letter` };
    if (code === 'new') return { error: '"new" is reserved for leads not yet called' };
    if (seen.has(code)) return { error: `code "${code}" is used twice` };
    seen.add(code);
    if (!label) return { error: `disposition "${code}" needs a label` };
    const retry = d.retryAfterMin === '' || d.retryAfterMin == null ? null : Number(d.retryAfterMin);
    if (retry !== null && (!Number.isInteger(retry) || retry < 1 || retry > 43200)) {
      return { error: `"${label}": retry must be a whole number of minutes (1-43200)` };
    }
    const isFinal = d.isFinal ? 1 : 0;
    const isCallback = d.isCallback ? 1 : 0;
    const marksDnc = d.marksDnc ? 1 : 0;
    if (isFinal && (retry !== null || isCallback))
      return { error: `"${label}": a final disposition can't also retry or schedule a callback` };
    if (marksDnc && !isFinal) return { error: `"${label}": Do-Not-Call dispositions must also be final` };
    if (isCallback && retry !== null) return { error: `"${label}": pick either callback or retry, not both` };
    cleaned.push({
      code,
      label,
      is_final: isFinal,
      retry_after_min: retry,
      marks_dnc: marksDnc,
      is_callback: isCallback,
    });
  }
  return { dispositions: cleaned };
}

async function replaceDispositions(conn, campaignId, list) {
  await conn.query('DELETE FROM campaign_dispositions WHERE campaign_id = ?', [campaignId]);
  for (const [i, d] of list.entries()) {
    await conn.query(
      `INSERT INTO campaign_dispositions (campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [campaignId, d.code, d.label, d.is_final, d.retry_after_min, d.marks_dnc, d.is_callback, i],
    );
  }
}

module.exports = { DEFAULT_DISPOSITIONS, getDispositions, replaceDispositions, validateDispositions };
