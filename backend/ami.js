// Minimal hand-rolled AMI (Asterisk Manager Interface) client - same
// philosophy as ari.js: a small dependency-free client over Node's raw
// `net` module rather than pulling in a heavy/unmaintained npm package.
// AMI is a simple line-based text protocol over TCP, used here for the
// things ARI has no equivalent for: real queue membership, and (once a
// call is handed off to native Queue()) the only way left to know what
// happened to it, since Stasis stops receiving events for that channel.
const net = require('net');
const EventEmitter = require('events');

const AMI_HOST = process.env.AMI_HOST || '127.0.0.1';
const AMI_PORT = process.env.AMI_PORT || 5038;
const AMI_USER = process.env.AMI_USER || 'dialforge';
const AMI_PASS = process.env.AMI_PASS;

const events = new EventEmitter();

let socket = null;
let buffer = '';
let loggedIn = false;
const pending = new Map(); // actionId -> {resolve, reject}
let actionCounter = 0;

function connect() {
  if (socket) return;
  socket = net.createConnection(AMI_PORT, AMI_HOST);
  socket.setEncoding('utf8');

  socket.on('connect', () => {
    sendAction('Login', { Username: AMI_USER, Secret: AMI_PASS }).then(() => {
      loggedIn = true;
    }).catch((err) => console.error('[AMI] login failed:', err.message));
  });

  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 4);
      handlePacket(raw);
    }
  });

  socket.on('error', (err) => console.error('[AMI] socket error:', err.message));
  socket.on('close', () => {
    socket = null;
    loggedIn = false;
    setTimeout(connect, 3000); // reconnect - queue membership sync should survive a blip
  });
}

function handlePacket(raw) {
  const lines = raw.split('\r\n');
  const fields = {};
  for (const line of lines) {
    const sep = line.indexOf(': ');
    if (sep === -1) continue;
    fields[line.slice(0, sep)] = line.slice(sep + 2);
  }

  // Unsolicited events (queue activity, hangups, etc.) - anyone can
  // subscribe via ami.on('AgentConnect', handler) etc.
  if (fields.Event) {
    events.emit(fields.Event, fields);
    events.emit('*', fields);
  }

  const actionId = fields.ActionID;
  if (actionId && pending.has(actionId)) {
    const { resolve, reject } = pending.get(actionId);
    pending.delete(actionId);
    if (fields.Response === 'Error') reject(new Error(fields.Message || 'AMI action failed'));
    else resolve(fields);
  }
}

function sendAction(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('AMI not connected'));
    const actionId = `dialforge-${++actionCounter}`;
    pending.set(actionId, { resolve, reject });
    let packet = `Action: ${action}\r\nActionID: ${actionId}\r\n`;
    for (const [key, value] of Object.entries(params)) {
      packet += `${key}: ${value}\r\n`;
    }
    packet += '\r\n';
    socket.write(packet);
    setTimeout(() => {
      if (pending.has(actionId)) {
        pending.delete(actionId);
        reject(new Error(`AMI action ${action} timed out`));
      }
    }, 5000);
  });
}

async function action(name, params) {
  if (!socket || !loggedIn) throw new Error('AMI not ready');
  return sendAction(name, params);
}

function queueAdd(queue, interfaceName) {
  return action('QueueAdd', { Queue: queue, Interface: interfaceName, Paused: 'false' });
}

function queueRemove(queue, interfaceName) {
  return action('QueueRemove', { Queue: queue, Interface: interfaceName });
}

function queuePause(queue, interfaceName, paused) {
  return action('QueuePause', { Queue: queue, Interface: interfaceName, Paused: paused ? 'true' : 'false' });
}

function queueReload() {
  return action('QueueReload', { Members: 'yes', Rules: 'yes', Parameters: 'yes' });
}

function on(eventName, handler) {
  events.on(eventName, handler);
}

connect();

module.exports = { queueAdd, queueRemove, queuePause, queueReload, on };
