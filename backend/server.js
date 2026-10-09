// DialForge backend entry point (systemd: dialforge-backend).
// Loads settings, connects to Asterisk, starts the HTTPS server.
// The app itself lives in src/ - see docs/ARCHITECTURE.md for the map.
require('dotenv').config();

const https = require('https');
const fs = require('fs');
const path = require('path');

// Fail loudly at startup, not with a confusing runtime error the first
// time something tries to use a missing secret - a fresh deploy that
// forgot to fill in .env should never limp along silently.
const REQUIRED_ENV_VARS = ['DB_PASSWORD', 'ARI_PASS', 'AMI_PASS', 'SESSION_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missingEnvVars.join(', ')}. Copy .env.example to .env and fill in real values.`,
  );
  process.exit(1);
}

// Safety net: an uncaught error in any async route handler otherwise
// crashes the entire process (Node terminates on unhandled rejections
// by default) - log it instead of taking down every agent's call.
process.on('unhandledRejection', (err) => {
  console.error('[Unhandled rejection - not crashing]', err);
});

const ami = require('./ami');
const { createApp, createSessionMiddleware } = require('./src/app');
const telephony = require('./src/telephony/events');
const hub = require('./src/realtime/hub');

ami.connect();
const sessionMiddleware = createSessionMiddleware();
const app = createApp({ sessionMiddleware });
telephony.start();

const PORT = process.env.PORT || 3000;
// HTTPS is required, not just nicer - browsers block microphone access
// (getUserMedia, which JsSIP/WebRTC needs) on any page that isn't a
// secure context, so the embedded softphone in agent.html can't work
// over plain HTTP.
const CERT_DIR = path.join(__dirname, 'certs');
const tlsOptions = {
  key: fs.readFileSync(path.join(CERT_DIR, 'privkey.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'fullchain.pem')),
};
const server = https.createServer(tlsOptions, app);
hub.attach(server, sessionMiddleware);
server.listen(PORT, () => console.log(`DialForge backend listening on port ${PORT} (HTTPS)`));
