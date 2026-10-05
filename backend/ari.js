// Minimal hand-rolled ARI client - same approach as the Phase 1 hello-world,
// just factored into reusable functions instead of one inline script.
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

function originate({ endpoint, app, appArgs, callerId }) {
  const params = new URLSearchParams({ endpoint, app });
  if (appArgs) params.set('appArgs', appArgs);
  if (callerId) params.set('callerId', callerId);
  return ariRequest('POST', `/channels?${params.toString()}`);
}

function answer(channelId) {
  return ariRequest('POST', `/channels/${channelId}/answer`);
}

function hangup(channelId) {
  return ariRequest('DELETE', `/channels/${channelId}`);
}

async function createBridge() {
  return ariRequest('POST', '/bridges?type=mixing');
}

function addChannelToBridge(bridgeId, channelId) {
  return ariRequest('POST', `/bridges/${bridgeId}/addChannel?channel=${channelId}`);
}

function destroyBridge(bridgeId) {
  return ariRequest('DELETE', `/bridges/${bridgeId}`);
}

function setChannelVar(channelId, variable, value) {
  const params = new URLSearchParams({ variable, value });
  return ariRequest('POST', `/channels/${channelId}/variable?${params.toString()}`);
}

// Hands a channel back from our Stasis app to plain dialplan execution -
// this is how a call reaches Asterisk's native Queue() app: our code
// decides which queue, sets it as a variable, then steps out of the way.
function continueInDialplan(channelId, { context, extension, priority }) {
  const params = new URLSearchParams({ context, extension, priority: String(priority) });
  return ariRequest('POST', `/channels/${channelId}/continue?${params.toString()}`);
}

// Real reachability check (registered contact present, e.g. "online"),
// not just trusting our own DB's possibly-stale "available" status -
// this is what should be checked before ever attempting to originate.
async function isEndpointOnline(techResource) {
  try {
    const endpoint = await ariRequest('GET', `/endpoints/${techResource}`);
    return endpoint.state === 'online';
  } catch (err) {
    return false;
  }
}

function connectEvents(appName, onEvent) {
  const wsUrl = `ws://${ARI_HOST}:${ARI_PORT}/ari/events?app=${appName}&api_key=${ARI_USER}:${ARI_PASS}`;
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log(`[ARI] app "${appName}" connected`));
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    onEvent(event);
  });
  ws.on('error', (err) => console.error('[ARI] WebSocket error:', err));
  ws.on('close', () => console.log('[ARI] WebSocket closed'));
  return ws;
}

module.exports = {
  originate,
  answer,
  hangup,
  createBridge,
  addChannelToBridge,
  destroyBridge,
  isEndpointOnline,
  setChannelVar,
  continueInDialplan,
  connectEvents,
};
