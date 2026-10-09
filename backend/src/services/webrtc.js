// What the browser softphone needs to reach Asterisk: the SIP-over-WebSocket
// URL, the SIP domain and the ICE (STUN/TURN) servers. Kept in .env, not in
// page code, so TURN credentials aren't published with the frontend.
//
// .env (all optional except the TURN pair, needed for agents behind strict NAT):
//   SIP_DOMAIN=dialforge.example.com      default: the host the browser used
//   WEBRTC_WS_URL=wss://host:8089/ws      default: wss://<SIP_DOMAIN>:8089/ws
//   STUN_URLS=stun:stun.l.google.com:19302
//   TURN_URLS=turn:1.2.3.4:3478,turns:host:443?transport=tcp
//   TURN_USERNAME=...   TURN_PASSWORD=...
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function buildWebrtcConfig(env, requestHost) {
  const sipDomain = env.SIP_DOMAIN || requestHost;
  const iceServers = [];
  const stun = env.STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list(env.STUN_URLS);
  if (stun.length) iceServers.push({ urls: stun });
  const turn = list(env.TURN_URLS);
  if (turn.length && env.TURN_USERNAME && env.TURN_PASSWORD) {
    iceServers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
  }
  return {
    sipDomain,
    wsUrl: env.WEBRTC_WS_URL || `wss://${sipDomain}:8089/ws`,
    iceServers,
  };
}

module.exports = { buildWebrtcConfig };
