// Same hand-rolled ARI client pattern as Phase 1/3 - kept as its own copy
// here rather than importing from the backend, since this is meant to be a
// genuinely separate, independently-deployable service (see RUNBOOK.md).
const WebSocket = require('ws');

const ARI_HOST = process.env.ARI_HOST || 'localhost';
const ARI_PORT = process.env.ARI_PORT || 8088;
const ARI_USER = process.env.ARI_USER || 'dialforge';
const ARI_PASS = process.env.ARI_PASS;

const authHeader = 'Basic ' + Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64');
const baseUrl = `http://${ARI_HOST}:${ARI_PORT}/ari`;

async function ariRequest(method, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ARI ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

function answer(channelId) {
  return ariRequest('POST', `/channels/${channelId}/answer`);
}

async function createBridge() {
  return ariRequest('POST', '/bridges?type=mixing');
}

function addChannelToBridge(bridgeId, channelId) {
  return ariRequest('POST', `/bridges/${bridgeId}/addChannel?channel=${channelId}`);
}

// Plays a media URI (e.g. 'sound:hello-world' - one of Asterisk's built-in
// core sounds) into a BRIDGE, so it gets mixed in for all participants.
// (Channel-level /play is for a channel before/outside a bridge - once a
// channel is already bridged, playing to the bridge itself is what actually
// gets heard.) This is what the real bot will use for TTS playback later.
function playToBridge(bridgeId, media) {
  return ariRequest('POST', `/bridges/${bridgeId}/play?media=${encodeURIComponent(media)}`);
}

// externalMedia: creates a channel that streams this call's audio as RTP to
// an address we control. connection_type=client means WE must already be
// listening on externalHost before this call, since Asterisk connects out to us.
function createExternalMedia({ app, externalHost, format }) {
  const params = new URLSearchParams({
    app,
    external_host: externalHost,
    format,
    encapsulation: 'rtp',
    transport: 'udp',
    connection_type: 'client',
    direction: 'both',
  });
  return ariRequest('POST', `/channels/externalMedia?${params.toString()}`);
}

function connectEvents(appName, onEvent) {
  const wsUrl = `ws://${ARI_HOST}:${ARI_PORT}/ari/events?app=${appName}&api_key=${ARI_USER}:${ARI_PASS}`;
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log(`[ARI] app "${appName}" connected`));
  ws.on('message', (data) => onEvent(JSON.parse(data.toString())));
  ws.on('error', (err) => console.error('[ARI] WebSocket error:', err));
  ws.on('close', () => console.log('[ARI] WebSocket closed'));
  return ws;
}

module.exports = { answer, createBridge, addChannelToBridge, createExternalMedia, playToBridge, connectEvents };
