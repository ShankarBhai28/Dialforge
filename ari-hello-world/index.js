// Phase 1 historical artifact, superseded by backend/ari.js - kept for
// reference only. If ever run again, set ARI_PASS in the environment first.
require('dotenv').config();
const WebSocket = require('ws');

const ARI_HOST = process.env.ARI_HOST || 'localhost';
const ARI_PORT = process.env.ARI_PORT || 8088;
const ARI_USER = process.env.ARI_USER || 'dialforge';
const ARI_PASS = process.env.ARI_PASS;
const APP_NAME = 'dialforge-app';

const authHeader = 'Basic ' + Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64');
const baseUrl = `http://${ARI_HOST}:${ARI_PORT}/ari`;

async function ariPost(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ARI POST ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

let waitingChannelId = null;

async function handleStasisStart(channelId, channelName) {
  console.log(`[StasisStart] channel=${channelId} name=${channelName}`);
  await ariPost(`/channels/${channelId}/answer`);

  if (!waitingChannelId) {
    waitingChannelId = channelId;
    console.log(`[Waiting] ${channelId} is waiting for a second caller...`);
    return;
  }

  const first = waitingChannelId;
  waitingChannelId = null;

  const bridge = await ariPost('/bridges?type=mixing');
  await ariPost(`/bridges/${bridge.id}/addChannel?channel=${first}`);
  await ariPost(`/bridges/${bridge.id}/addChannel?channel=${channelId}`);
  console.log(`[Bridged] ${first} <-> ${channelId} via bridge ${bridge.id}`);
}

function handleStasisEnd(channelId) {
  console.log(`[StasisEnd] channel=${channelId}`);
  if (waitingChannelId === channelId) waitingChannelId = null;
}

const wsUrl = `ws://${ARI_HOST}:${ARI_PORT}/ari/events?app=${APP_NAME}&api_key=${ARI_USER}:${ARI_PASS}`;
const ws = new WebSocket(wsUrl);

ws.on('open', () => console.log(`ARI app "${APP_NAME}" connected, listening for events...`));

ws.on('message', (data) => {
  const event = JSON.parse(data.toString());
  if (event.type === 'StasisStart') {
    handleStasisStart(event.channel.id, event.channel.name).catch((err) =>
      console.error('StasisStart handler error:', err)
    );
  } else if (event.type === 'StasisEnd') {
    handleStasisEnd(event.channel.id);
  }
});

ws.on('error', (err) => console.error('WebSocket error:', err));
ws.on('close', () => console.log('ARI WebSocket closed'));
