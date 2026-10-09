// What the Dialer screen shows: the engine heartbeat, every campaign's
// dialer state and last tick, and today's attempt counts. Used by
// GET /admin/dialer and by the live feed (realtime/dialerFeed.js).
const pool = require('../../db');

async function dialerOverview(deps = { pool }) {
  // Row 0 is the engine's heartbeat: no tick for 15s+ means it's down.
  const [engineRows] = await deps.pool.query(
    'SELECT note AS engine_id, last_tick_at, TIMESTAMPDIFF(SECOND, last_tick_at, NOW()) AS age_sec FROM dialer_status WHERE campaign_id = 0',
  );
  const engine = engineRows[0];
  const [campaigns] = await deps.pool.query(`
    SELECT c.id, c.name, c.status, c.dial_mode, c.dial_ratio, c.max_dial_ratio, c.dialer_state, c.dialer_state_changed_at,
      u.username AS changed_by, q.name AS queue_name,
      s.hopper_ready, s.hopper_locked, s.idle_agents, s.would_dial, s.in_flight, s.active_calls, s.note, s.last_tick_at,
      s.current_ratio, s.answer_rate, s.abandon_pct, s.ratio_adjust, s.pacing_note
    FROM campaigns c
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN users u ON u.id = c.dialer_state_changed_by
    LEFT JOIN dialer_status s ON s.campaign_id = c.id
    ORDER BY c.dialer_state = 'running' DESC, c.dialer_state = 'paused' DESC, c.name
  `);
  // Today = since midnight in India (server clock is UTC).
  const [stats] = await deps.pool.query(`
    SELECT campaign_id, COUNT(*) AS attempts,
      SUM(answered_at IS NOT NULL) AS answered,
      SUM(result = 'connected') AS connected,
      SUM(result = 'abandoned' OR result = 'customer_hangup') AS abandoned,
      SUM(result IN ('no_answer', 'busy', 'congestion', 'failed', 'invalid')) AS not_reached,
      SUM(result = 'machine') AS machine
    FROM dial_attempts
    WHERE started_at >= CONVERT_TZ(DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')), '+05:30', '+00:00')
    GROUP BY campaign_id
  `);
  return {
    engine: engine ? { ...engine, alive: engine.age_sec <= 15 } : { alive: false },
    campaigns: campaigns.map((c) => ({ ...c, today: stats.find((x) => x.campaign_id === c.id) || null })),
  };
}

/** The overview limited to a team-scoped role's campaigns (scope null = all). */
function scopeOverview(overview, scope) {
  if (!scope) return overview;
  return { ...overview, campaigns: overview.campaigns.filter((c) => scope.campaignIds.includes(c.id)) };
}

module.exports = { dialerOverview, scopeOverview };
