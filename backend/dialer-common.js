// Shared by the web backend (server.js) and the dialer engine
// (dialer-engine.js) so both apply exactly the same rules.

// One canonical form for comparing numbers (DNC lookups): digits only, and
// an Indian number written as 91xxxxxxxxxx / 0xxxxxxxxxx reduced to its 10
// digits, so "+91 98400 12345", "098400 12345" and "9840012345" all match.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// Current wall-clock time in the campaign's timezone as "HH:MM:SS" - the
// server itself runs in UTC, so this can't just use new Date().getHours().
function localTimeIn(timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
}

function isWithinCallWindow(campaign) {
  const now = localTimeIn(campaign.timezone || 'Asia/Kolkata');
  return now >= campaign.call_window_start && now < campaign.call_window_end;
}

// --- Dial attempt results (D7) ---
// Used by the engine (unanswered calls: busy, no answer, ...) and the web
// backend (answered calls: AMI tells it abandoned / machine), so a lead is
// rescheduled the same way whichever process saw the outcome.
// --- Recycling (D9) ---
// Each unsuccessful result belongs to one recycle rule (per campaign, see
// campaign_recycle_rules): redial after delay_min minutes, at most
// max_tries times. The lead's status shows what last happened.
const RECYCLE_RULE_FOR_RESULT = {
  no_answer: 'no_answer',
  busy: 'busy',
  machine: 'machine',
  congestion: 'congestion',
  failed: 'congestion',
  abandoned: 'abandoned',
  customer_hangup: 'abandoned',
};
const RECYCLE_LEAD_STATUS = {
  no_answer: 'no_answer',
  busy: 'busy',
  machine: 'machine',
  congestion: 'network_error',
  abandoned: 'abandoned',
};
const DEFAULT_RECYCLE_RULES = {
  no_answer: { enabled: 1, delay_min: 60, max_tries: 3 },
  busy: { enabled: 1, delay_min: 15, max_tries: 3 },
  machine: { enabled: 1, delay_min: 120, max_tries: 2 },
  congestion: { enabled: 1, delay_min: 10, max_tries: 3 },
  abandoned: { enabled: 1, delay_min: 2, max_tries: 3 }, // they answered and got no agent - call back soon
};

// A campaign's rules, defaults filled in for any result it has no row for.
async function getRecycleRules(pool, campaignId) {
  const [rows] = await pool.query(
    'SELECT result, enabled, delay_min, max_tries FROM campaign_recycle_rules WHERE campaign_id = ?',
    [campaignId],
  );
  const rules = {};
  for (const key of Object.keys(DEFAULT_RECYCLE_RULES)) {
    const r = rows.find((x) => x.result === key);
    rules[key] = r
      ? { enabled: r.enabled, delay_min: r.delay_min, max_tries: r.max_tries }
      : { ...DEFAULT_RECYCLE_RULES[key] };
  }
  return rules;
}

// Records the final result once (first writer wins - several events can
// report the same call ending) and reschedules the lead by the campaign's
// recycle rule for that result. Returns true if this call recorded it.
async function finishAttempt(pool, attemptId, result, hangupCause) {
  const [upd] = await pool.query(
    `UPDATE dial_attempts SET result = ?, hangup_cause = COALESCE(?, hangup_cause), status = 'ended', ended_at = NOW()
     WHERE id = ? AND result IS NULL`,
    [result, hangupCause == null ? null : hangupCause, attemptId],
  );
  if (!upd.affectedRows) return false;
  const [[attempt]] = await pool.query('SELECT lead_id, campaign_id, call_id FROM dial_attempts WHERE id = ?', [
    attemptId,
  ]);
  if (attempt.call_id) {
    await pool.query('UPDATE calls SET end_time = COALESCE(end_time, NOW()), disposition = ? WHERE id = ?', [
      result,
      attempt.call_id,
    ]);
  }
  const ruleKey = RECYCLE_RULE_FOR_RESULT[result];
  if (ruleKey) {
    const rule = (await getRecycleRules(pool, attempt.campaign_id))[ruleKey];
    const sameKind = Object.keys(RECYCLE_RULE_FOR_RESULT).filter((r) => RECYCLE_RULE_FOR_RESULT[r] === ruleKey);
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM dial_attempts a JOIN leads l ON l.id = a.lead_id
       WHERE a.lead_id = ? AND a.result IN (?) AND a.started_at >= COALESCE(l.recycled_at, '1000-01-01')`,
      [attempt.lead_id, sameKind],
    );
    const status = RECYCLE_LEAD_STATUS[ruleKey];
    if (rule.enabled && n < rule.max_tries) {
      await pool.query(
        'UPDATE leads SET status = ?, next_call_at = NOW() + INTERVAL ? MINUTE WHERE id = ? AND is_final = 0',
        [status, rule.delay_min, attempt.lead_id],
      );
    } else {
      // Rule off or tries used up: the dialer leaves it alone until an
      // admin recycles the list (Leads -> Recycle).
      await pool.query('UPDATE leads SET status = ?, is_final = 1, next_call_at = NULL WHERE id = ? AND is_final = 0', [
        status,
        attempt.lead_id,
      ]);
    }
  } else if (result === 'invalid') {
    await pool.query("UPDATE leads SET status = 'invalid_number', is_final = 1 WHERE id = ?", [attempt.lead_id]);
  }
  return true;
}

module.exports = {
  normalizePhone,
  localTimeIn,
  isWithinCallWindow,
  finishAttempt,
  DEFAULT_RECYCLE_RULES,
  RECYCLE_LEAD_STATUS,
  getRecycleRules,
};
