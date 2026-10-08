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

// timeout = seconds to ring before giving up; channelId lets the caller
// pick the channel's id up front, so events about it can be matched to
// our own record even before originate returns.
function originate({ endpoint, app, appArgs, callerId, timeout, channelId }) {
  const params = new URLSearchParams({ endpoint, app });
  if (appArgs) params.set('appArgs', appArgs);
  if (callerId) params.set('callerId', callerId);
  if (timeout) params.set('timeout', String(timeout));
  if (channelId) params.set('channelId', channelId);
  return ariRequest('POST', `/channels?${params.toString()}`);
}

// null when the channel no longer exists.
async function getChannel(channelId) {
  try {
    return await ariRequest('GET', `/channels/${encodeURIComponent(channelId)}`);
  } catch (err) {
    if (/ 404 /.test(err.message)) return null;
    throw err;
  }
}

function answer(channelId) {
  return ariRequest('POST', `/channels/${channelId}/answer`);
}

function hangup(channelId) {
  return ariRequest('DELETE', `/channels/${channelId}`);
}

// type 'mixing' (normal talking bridge) or 'holding' (participants hear
// music on hold - used to park a customer during a warm transfer).
async function createBridge(type = 'mixing') {
  return ariRequest('POST', `/bridges?type=${type}`);
}

function addChannelToBridge(bridgeId, channelId) {
  return ariRequest('POST', `/bridges/${bridgeId}/addChannel?channel=${channelId}`);
}

function removeChannelFromBridge(bridgeId, channelId) {
  return ariRequest('POST', `/bridges/${bridgeId}/removeChannel?channel=${channelId}`);
}

function startBridgeMoh(bridgeId) {
  return ariRequest('POST', `/bridges/${bridgeId}/moh?mohClass=default`);
}

function stopBridgeMoh(bridgeId) {
  return ariRequest('DELETE', `/bridges/${bridgeId}/moh`);
}

// media e.g. 'tone:ring;tonezone=in' (ringback while a transfer target rings).
function playOnBridge(bridgeId, media, playbackId) {
  const params = new URLSearchParams({ media });
  if (playbackId) params.set('playbackId', playbackId);
  return ariRequest('POST', `/bridges/${bridgeId}/play?${params.toString()}`);
}

function stopPlayback(playbackId) {
  return ariRequest('DELETE', `/playbacks/${playbackId}`);
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

// Reconnects by itself (e.g. after an Asterisk restart) - without this the
// app silently stops receiving events until the Node process restarts.
// onStateChange(true|false) lets callers know whether events are flowing.
function connectEvents(appName, onEvent, onStateChange) {
  const wsUrl = `ws://${ARI_HOST}:${ARI_PORT}/ari/events?app=${appName}&api_key=${ARI_USER}:${ARI_PASS}`;
  const open = () => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log(`[ARI] app "${appName}" connected`);
      if (onStateChange) onStateChange(true);
    });
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      onEvent(event);
    });
    ws.on('error', (err) => console.error(`[ARI] "${appName}" WebSocket error:`, err.message));
    ws.on('close', () => {
      console.log(`[ARI] app "${appName}" disconnected - retrying in 3s`);
      if (onStateChange) onStateChange(false);
      setTimeout(open, 3000);
    });
  };
  open();
}

module.exports = {
  originate,
  getChannel,
  answer,
  hangup,
  createBridge,
  addChannelToBridge,
  removeChannelFromBridge,
  startBridgeMoh,
  stopBridgeMoh,
  playOnBridge,
  stopPlayback,
  destroyBridge,
  isEndpointOnline,
  setChannelVar,
  continueInDialplan,
  connectEvents,
};
