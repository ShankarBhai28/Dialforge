// Auto disposition, server side: the agent screen counts down and saves the
// campaign's auto disposition itself; this catches the calls where no screen
// did (browser closed, network lost). A call an agent answered, ended more
// than the campaign's auto-disposition seconds + 60 s ago, still without a
// disposition, gets it - the same effect as an agent choosing it, recorded
// in the lead's history as "Auto disposition" by "system".
const pool = require('../../db');
const { getDispositions } = require('./dispositions');
const { applyStatus, statusEffect } = require('./leadStatus');
const { audit } = require('./audit');
const { forEachTenant } = require('./tenants');

const GRACE_SEC = 60;
const NOTE = 'Auto disposition (none given in time)';

async function sweepAutoDispo(deps = { pool, getDispositions, audit }) {
  const db = deps.pool;
  const [calls] = await db.query(
    `SELECT ca.id, ca.lead_id, ca.campaign_id, ca.end_time, c.auto_dispo_code, l.phone
     FROM calls ca
     JOIN campaigns c ON c.id = ca.campaign_id
     JOIN leads l ON l.id = ca.lead_id AND l.deleted_at IS NULL
     WHERE c.auto_dispo_sec > 0 AND c.auto_dispo_code IS NOT NULL
       AND ca.agent_connect_time IS NOT NULL AND ca.outcome IS NULL AND ca.end_time IS NOT NULL
       AND ca.end_time < NOW() - INTERVAL (c.auto_dispo_sec + ${GRACE_SEC}) SECOND
       AND ca.end_time > NOW() - INTERVAL 1 DAY
       -- not given meanwhile on the lead (e.g. later from the call log)
       AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'leads.outcome' AND a.entity = 'leads'
                       AND a.entity_id = ca.lead_id AND a.at >= ca.end_time)
     ORDER BY ca.id LIMIT 100`,
  );
  let saved = 0;
  for (const c of calls) {
    const effect = statusEffect(c.auto_dispo_code, await deps.getDispositions(c.campaign_id));
    if (effect.error) continue;
    await applyStatus(db, [{ id: c.lead_id, phone: c.phone }], c.auto_dispo_code, effect, null);
    await db.query('UPDATE calls SET outcome = ?, outcome_at = NOW() WHERE id = ? AND outcome IS NULL', [
      c.auto_dispo_code,
      c.id,
    ]);
    await deps.audit({
      user: null,
      action: 'leads.outcome',
      entity: 'leads',
      entityId: c.lead_id,
      status: 200,
      summary: `${c.auto_dispo_code} (call ${c.id})`,
      request: { status: c.auto_dispo_code, note: NOTE },
    });
    saved++;
  }
  return saved;
}

/** Every company's calls (Cloud edition), one company at a time per worker. */
function startAutoDispoSweeper(everyMs = 30000) {
  const once = async () => {
    const n = await sweepAutoDispo();
    if (n) console.log(`[auto disposition] saved for ${n} call(s) nobody gave one`);
  };
  const tick = () =>
    forEachTenant(once, { label: 'auto disposition' }).catch((err) =>
      console.error('[auto disposition] sweep failed:', err.message),
    );
  return setInterval(tick, everyMs);
}

module.exports = { sweepAutoDispo, startAutoDispoSweeper, NOTE };
