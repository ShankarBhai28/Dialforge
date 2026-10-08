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
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
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
const RETRY_LIKE_NO_ANSWER = ['no_answer', 'busy', 'congestion', 'failed', 'machine'];
const CALL_BACK_SOON = ['abandoned', 'customer_hangup'];  // they answered - try again shortly

// Records the final result once (first writer wins - several events can
// report the same call ending) and reschedules the lead. Returns true if
// this call recorded it.
async function finishAttempt(pool, attemptId, result, hangupCause) {
  const [upd] = await pool.query(
    `UPDATE dial_attempts SET result = ?, hangup_cause = COALESCE(?, hangup_cause), status = 'ended', ended_at = NOW()
     WHERE id = ? AND result IS NULL`,
    [result, hangupCause == null ? null : hangupCause, attemptId]
  );
  if (!upd.affectedRows) return false;
  const [[attempt]] = await pool.query('SELECT lead_id, campaign_id, call_id FROM dial_attempts WHERE id = ?', [attemptId]);
  if (attempt.call_id) {
    await pool.query('UPDATE calls SET end_time = COALESCE(end_time, NOW()), disposition = ? WHERE id = ?', [result, attempt.call_id]);
  }
  if (RETRY_LIKE_NO_ANSWER.includes(result)) {
    // Same retry delay the campaign uses for the agent's "No Answer".
    const [d] = await pool.query(
      "SELECT retry_after_min FROM campaign_dispositions WHERE campaign_id = ? AND code = 'no_answer'", [attempt.campaign_id]
    );
    const retryMin = (d[0] && d[0].retry_after_min) || 60;
    await pool.query(
      "UPDATE leads SET status = 'no_answer', next_call_at = NOW() + INTERVAL ? MINUTE WHERE id = ? AND is_final = 0",
      [retryMin, attempt.lead_id]
    );
  } else if (CALL_BACK_SOON.includes(result)) {
    await pool.query('UPDATE leads SET next_call_at = NOW() + INTERVAL 2 MINUTE WHERE id = ? AND is_final = 0', [attempt.lead_id]);
  } else if (result === 'invalid') {
    await pool.query("UPDATE leads SET status = 'invalid_number', is_final = 1 WHERE id = ?", [attempt.lead_id]);
  }
  return true;
}

module.exports = { normalizePhone, localTimeIn, isWithinCallWindow, finishAttempt };
