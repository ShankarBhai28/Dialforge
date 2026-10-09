// What the browser softphone needs to reach Asterisk: the SIP-over-WebSocket
// URL, the SIP domain and the ICE (STUN/TURN) servers. Kept in .env, not in
// page code, so TURN credentials aren't published with the frontend.
//
// .env (all optional):
//   SIP_DOMAIN=dialforge.example.com      default: the host the browser used
//   WEBRTC_WS_URL=wss://host:8089/ws      default: wss://<SIP_DOMAIN>:8089/ws
//   STUN_URLS=stun:stun.l.google.com:19302
//   TURN_URLS=turn:1.2.3.4:3478,turns:host:443?transport=tcp
//   TURN_SECRET=...        coturn `static-auth-secret` (preferred): every login
//                          gets its own password that expires (TURN_TTL_SEC,
//                          default 12 h), so a leaked one is useless next day
//   TURN_USERNAME / TURN_PASSWORD   a fixed coturn user (only if no TURN_SECRET)
const crypto = require('crypto');

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * coturn "TURN REST API" credentials (use-auth-secret): the username carries
 * its own expiry time, the password is HMAC-SHA1(secret, username) - coturn
 * checks both, nothing is stored.
 */
function turnRestCredentials(secret, label, ttlSec, nowMs = Date.now()) {
  const username = `${Math.floor(nowMs / 1000) + ttlSec}:${label}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

function buildWebrtcConfig(env, requestHost, { userId = 0, nowMs } = {}) {
  const sipDomain = env.SIP_DOMAIN || requestHost;
  const iceServers = [];
  const stun = env.STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list(env.STUN_URLS);
  if (stun.length) iceServers.push({ urls: stun });
  const turn = list(env.TURN_URLS);
  if (turn.length && env.TURN_SECRET) {
    const ttl = Number(env.TURN_TTL_SEC) > 0 ? Number(env.TURN_TTL_SEC) : 12 * 60 * 60;
    iceServers.push({ urls: turn, ...turnRestCredentials(env.TURN_SECRET, `agent${userId}`, ttl, nowMs) });
  } else if (turn.length && env.TURN_USERNAME && env.TURN_PASSWORD) {
    iceServers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
  }
  return {
    sipDomain,
    wsUrl: env.WEBRTC_WS_URL || `wss://${sipDomain}:8089/ws`,
    iceServers,
  };
}

module.exports = { buildWebrtcConfig, turnRestCredentials };
