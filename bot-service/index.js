require('dotenv').config();
const dgram = require('dgram');
const ari = require('./ari');

if (!process.env.ARI_PASS) {
  console.error('Missing ARI_PASS environment variable. Copy .env.example to .env and fill in a real value.');
  process.exit(1);
}

const APP_NAME = 'dialforge-bot-app';
const UDP_PORT = 12000;
// This box's own private IP - externalMedia connects here since we're all
// running on the same server for now. Would be a different reachable
// address once the bot service is its own separate host.
const UDP_HOST = '172.31.10.157';

let packetCount = 0;
let byteCount = 0;
let lastLogTime = Date.now();

// RTP echo state. Opus over RTP always uses a 48000Hz clock (RFC 7587)
// regardless of the actual audio bandwidth; Asterisk's default ptime is
// 20ms, so 48000 * 0.020 = 960 timestamp units per packet.
const OPUS_CLOCK_RATE = 48000;
const TIMESTAMP_STEP = (OPUS_CLOCK_RATE * 20) / 1000; // 960
const echoSsrc = Math.floor(Math.random() * 0xffffffff);
let echoSeq = Math.floor(Math.random() * 0xffff);
let echoTimestamp = Math.floor(Math.random() * 0xffffffff);

function buildRtpPacket(payloadType, payload) {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding, no extension, no CSRC
  header[1] = payloadType & 0x7f; // marker bit 0
  header.writeUInt16BE(echoSeq & 0xffff, 2);
  header.writeUInt32BE(echoTimestamp >>> 0, 4);
  header.writeUInt32BE(echoSsrc, 8);
  echoSeq++;
  echoTimestamp = (echoTimestamp + TIMESTAMP_STEP) >>> 0;
  return Buffer.concat([header, payload]);
}

const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
  packetCount++;
  byteCount += msg.length;

  const now = Date.now();
  if (now - lastLogTime > 2000) {
    console.log(
      `[audio] ${packetCount} packets received so far, ${byteCount} bytes total (last packet ${msg.length} bytes from ${rinfo.address}:${rinfo.port})`,
    );
    lastLogTime = now;
  }

  // Echo: strip the 12-byte RTP header off, keep the encoded opus payload
  // as-is (no decode/re-encode needed for a straight loopback), and
  // re-wrap it in our own RTP header before sending it back.
  if (msg.length > 12) {
    const payloadType = msg[1] & 0x7f;
    const payload = msg.subarray(12);
    const echoPacket = buildRtpPacket(payloadType, payload);
    udpServer.send(echoPacket, rinfo.port, rinfo.address);
  }
});

udpServer.on('error', (err) => {
  console.error('[udp] server error:', err);
});

udpServer.bind(UDP_PORT, () => {
  console.log(`[udp] listening for external media audio on ${UDP_HOST}:${UDP_PORT}`);
});

ari.connectEvents(APP_NAME, async (event) => {
  try {
    if (event.type === 'StasisStart') {
      // Ignore the externalMedia channel's own StasisStart (it's a
      // "UnicastRTP" channel, not a real caller) - only react to real calls.
      if (event.channel.name.startsWith('UnicastRTP')) return;

      console.log(`[StasisStart] real caller channel=${event.channel.id}`);
      await ari.answer(event.channel.id);
      packetCount = 0;
      byteCount = 0;

      const externalChannel = await ari.createExternalMedia({
        app: APP_NAME,
        externalHost: `${UDP_HOST}:${UDP_PORT}`,
        format: 'slin',
      });
      console.log(`[externalMedia] created channel=${externalChannel.id}`);

      const bridge = await ari.createBridge();
      await ari.addChannelToBridge(bridge.id, event.channel.id);
      await ari.addChannelToBridge(bridge.id, externalChannel.id);
      console.log(`[Bridged] caller ${event.channel.id} <-> externalMedia ${externalChannel.id}`);

      // Prove the return-audio path using ARI's own play mechanism instead
      // of raw RTP - this is what the real bot will use for TTS playback.
      setTimeout(() => {
        ari
          .playToBridge(bridge.id, 'sound:hello-world')
          .then(() => console.log(`[play] triggered on bridge=${bridge.id}`))
          .catch((err) => console.error('[play] error:', err));
      }, 3000);
    } else if (event.type === 'StasisEnd') {
      console.log(`[StasisEnd] channel=${event.channel.id} - final count: ${packetCount} packets, ${byteCount} bytes`);
    }
  } catch (err) {
    console.error('[ARI event handler error]', err);
  }
});
