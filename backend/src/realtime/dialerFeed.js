// Live Dialer screen. The engine (dialer-engine.js) is a separate process
// that writes its state to the DB every tick; it doesn't talk to /ws.
// Instead of every open Dialer screen asking every few seconds, the backend
// reads the same overview once every 2s - only while an admin is connected -
// and publishes `dialer.status` (the GET /admin/dialer payload) when
// something on the screen changed.
const hub = require('./hub');
const { dialerOverview } = require('../services/dialer');

const POLL_MS = 2000;

// Tick times move every engine tick even when nothing else does; the
// screen shows them, but they alone aren't worth a message.
function fingerprint(overview) {
  const { age_sec, last_tick_at, ...engine } = overview.engine;
  return JSON.stringify({
    engine,
    campaigns: overview.campaigns.map(({ last_tick_at, ...c }) => c),
  });
}

function createDialerFeed({ load, publish, hasAdmins, intervalMs = POLL_MS }) {
  let last = null;
  let busy = false;
  let again = false;
  let timer = null;

  /** Reads the overview and publishes it if it changed (or `force`). */
  async function check({ force = false } = {}) {
    if (!hasAdmins()) {
      last = null; // the next admin starts from a fresh comparison
      return;
    }
    if (busy) {
      // A read is running but may predate the change that asked for this
      // one (start/pause/stop) - read again as soon as it finishes.
      if (force) again = true;
      return;
    }
    busy = true;
    try {
      const overview = await load();
      const fp = fingerprint(overview);
      if (force || fp !== last) {
        last = fp;
        publish('dialer.status', overview);
      }
    } catch (err) {
      console.error('[dialer feed]', err.message);
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await check({ force: true });
    }
  }

  return {
    check,
    start() {
      if (timer) return;
      timer = setInterval(check, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

const feed = createDialerFeed({
  load: () => dialerOverview(),
  publish: (type, data) => hub.publish(type, data),
  hasAdmins: () => hub.adminCount() > 0,
});

module.exports = { ...feed, createDialerFeed, fingerprint };
