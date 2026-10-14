// The client's licence: what they pay for. Written by the provider only
// (install/set-licence.sh, root-owned /etc/viztex/licence.json) - the client
// has the web admin, never the server, so they can't change it.
//
//   { "customer": "Acme", "seats": 10, "channels": 15, "expires": "2026-12-31" }
//
// seats    - most agents logged in at the same time (admins / supervisors
//            and extensions not counted); enforced at agent login
// channels - most calls on the trunk at once, of every kind: dialer,
//            click-to-call, transfers out, inbound
// expires  - last day of service. Admins are warned before; after it agents
//            can't log in or call and the dialer stops. Admin logins and all
//            data stay, so the client can still export.
// No file = no limits (a dev server, or set up before licences existed).
const fs = require('fs');

const FILE = process.env.LICENCE_FILE || '/etc/viztex/licence.json';
const WARN_DAYS = 14;
const RECHECK_MS = 10000;

let cache = { at: 0, mtime: null, data: null };

/** File text -> the licence fields, or { error } (pure, for tests). */
function parseLicence(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'the licence file is not valid JSON' };
  }
  const posInt = (v) => v == null || (Number.isInteger(v) && v > 0);
  if (!posInt(raw.seats)) return { error: 'seats must be a whole number above 0' };
  if (!posInt(raw.channels)) return { error: 'channels must be a whole number above 0' };
  if (raw.expires != null && !/^\d{4}-\d{2}-\d{2}$/.test(raw.expires))
    return { error: 'expires must be a date like 2026-12-31' };
  return {
    customer: raw.customer ? String(raw.customer).slice(0, 100) : null,
    seats: raw.seats ?? null,
    channels: raw.channels ?? null,
    expires: raw.expires ?? null,
  };
}

/** Whole days from today (server's local date) to the last day; 0 = today is the last day, < 0 = over. */
function daysLeft(expires, now = new Date()) {
  const [y, m, d] = expires.split('-').map(Number);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86400000);
}

/** Licence fields + state: none | invalid | ok | expiring | expired. */
function describe(lic, now = new Date()) {
  if (!lic) return { state: 'none', customer: null, seats: null, channels: null, expires: null, daysLeft: null };
  if (lic.error) return { state: 'invalid', error: lic.error, seats: null, channels: null, expires: null };
  const left = lic.expires ? daysLeft(lic.expires, now) : null;
  const state = left == null ? 'ok' : left < 0 ? 'expired' : left < WARN_DAYS ? 'expiring' : 'ok';
  return { ...lic, daysLeft: left, state };
}

function readFile() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch (err) {
    cache.mtime = null;
    if (err.code === 'ENOENT') return null;
    // e.g. EACCES: a licence is set but the app can't reach it - say so (no limits meanwhile).
    const data = { error: `can't read the licence file (${err.code || err.message})` };
    console.error(`[licence] ${FILE}: ${data.error} - no limits applied`);
    return data;
  }
  if (cache.mtime === stat.mtimeMs) return cache.data;
  let data;
  try {
    data = parseLicence(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    data = { error: `can't read the licence file (${err.code || err.message})` };
  }
  if (data.error) console.error(`[licence] ${FILE}: ${data.error} - no limits applied`);
  cache = { at: Date.now(), mtime: stat.mtimeMs, data };
  return data;
}

/** The licence now. Re-reads the file when it changed (checked at most every 10 s), so no restart is needed. */
function getLicence(now = new Date()) {
  if (Date.now() - cache.at > RECHECK_MS) {
    const data = readFile();
    cache = { ...cache, at: Date.now(), data };
  }
  return describe(cache.data, now);
}

const isExpired = () => getLicence().state === 'expired';

const EXPIRED_MESSAGE = 'The VIZTEX subscription has ended - ask your admin to contact the provider.';

/** Calls on the trunk right now (Asterisk's own count, so every kind of call); null if Asterisk didn't answer. */
async function trunkCallsNow(ari, trunk) {
  return ari.endpointChannelCount(`PJSIP/${trunk}`);
}

/**
 * Before a new outside call: null when it may go, or a plain reason.
 * `extra` = this call's own channel when it's already counted (inbound).
 * Asterisk not answering doesn't block calls - the provider's own limit still holds.
 */
async function lineRefusal(ari, trunk, { extra = 0 } = {}) {
  const lic = getLicence();
  if (lic.state === 'expired') return EXPIRED_MESSAGE;
  if (!lic.channels) return null;
  const n = await trunkCallsNow(ari, trunk);
  if (n == null || n - extra < lic.channels) return null;
  return `All ${lic.channels} phone lines are in use - try again in a moment.`;
}

module.exports = {
  EXPIRED_MESSAGE,
  WARN_DAYS,
  daysLeft,
  describe,
  getLicence,
  isExpired,
  lineRefusal,
  parseLicence,
  trunkCallsNow,
  _reset: () => (cache = { at: 0, mtime: null, data: null }),
};
