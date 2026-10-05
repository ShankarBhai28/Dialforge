# DialForge — Deployment Guide

This is the procedural "how to actually run this" checklist. For the narrative
*why* behind these decisions (why HTTPS is required, why queues are real
Asterisk queues, why certain bugs were fixed a certain way), see `RUNBOOK.md`.
For current server facts (exact versions, ports, access), see `STATUS.md`.

Cloning the repo gets you the **code**. It does not get you a running system -
secrets, Asterisk, and the database schema still have to be set up once per
server, following the steps below.

---

## 1. Fresh server setup (once per new server)

### 1.1 Base OS and packages
- Ubuntu 24.04 LTS (what this project is built/tested against).
- Node.js 24.x LTS (via NodeSource), MySQL 8.x, and whatever TLS cert tooling
  you'll use (this project uses `certbot`, webroot method).

### 1.2 Asterisk 22, built from source
Needs PJSIP, ARI, and the WebRTC transport enabled at build time. See
`RUNBOOK.md` Phase 0 for the full build narrative. Once built, configure:

- **`pjsip.conf`** - a WebRTC transport, your own test extensions (e.g.
  `1001`/`1002`, `ulaw` preferred, `opus` allowed as fallback for browser
  compatibility), and your PSTN trunk endpoint/auth/aor objects (real
  credentials come from your provider - never commit these):
  ```
  [your-trunk-name]
  type=endpoint
  context=your-inbound-context
  disallow=all
  allow=ulaw,alaw
  auth=your-trunk-name
  aors=your-trunk-name

  [your-trunk-name]
  type=auth
  auth_type=userpass
  username=<from provider>
  password=<from provider>

  [your-trunk-name]
  type=aor
  contact=<from provider>
  ```
- **`extensions.conf`** - dialplan that hands calls into Stasis (this app's
  `APP_NAME`, see `.env`), passing the dialed DID (`${EXTEN}`) through as an
  arg so inbound DID-to-campaign mapping works.
- **`ari.conf`** - one `[dialforge]` user (`type=user`), password set to
  match `ARI_PASS` in `.env` (see step 2 below).
- **`manager.conf`** - one `[dialforge]` user with `secret` matching
  `AMI_PASS`, `read`/`write` scoped to `system,call,agent,user,config`
  (not `all` - least privilege), bound to `127.0.0.1` only.
- **`queues.conf`** - just the `[general]` section to start; this app
  appends/edits/removes queue stanzas itself at runtime (see
  `backend/server.js`'s `QUEUES_CONF_PATH` handling) - don't hand-author
  queue stanzas, they'll be overwritten.

Reload after any manual config edit: `sudo asterisk -rx "module reload res_ari.so"` / `sudo asterisk -rx "manager reload"` / `sudo asterisk -rx "queue reload all"` as applicable - these are lightweight reloads, not a full Asterisk restart, so active calls aren't dropped.

### 1.3 MySQL
```
CREATE DATABASE dialforge_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'dialforge'@'localhost' IDENTIFIED BY '<pick a strong password>';
GRANT ALL PRIVILEGES ON dialforge_dev.* TO 'dialforge'@'localhost';
```
Then load the schema (no data, just structure - this is the authoritative
baseline, regenerated from the live server whenever the schema changes):
```
mysql -u dialforge -p dialforge_dev < backend/schema.sql
```
Seed the initial extensions this app expects to exist (`1001`, `1002`, your
trunk-facing numbers) directly in the `extensions` table, then run:
```
cd backend && node seed-users.js
```
(reads `ADMIN_PASSWORD`/`AGENT1001_PASSWORD`/`AGENT1002_PASSWORD` from `.env` -
set those first).

### 1.4 App secrets
```
cd backend
cp .env.example .env
```
Fill in every value in `.env` - real DB/ARI/AMI passwords (matching what you
set in steps 1.2/1.3 above), a long random `SESSION_SECRET`, and your trunk's
`TRUNK_ENDPOINT`/`TRUNK_CALLER_ID`. **Never commit `.env`** - it's git-ignored
for exactly this reason. `bot-service/.env` and `ari-hello-world/` (if you
ever run the latter) need the same treatment for `ARI_PASS`.

### 1.5 Install and run
```
cd backend
npm install
```
HTTPS is required (not cosmetic) - browsers block microphone access on
non-secure pages, which the embedded WebRTC softphone needs. Get a cert
(`certbot`, webroot method) and point `backend/certs/privkey.pem` /
`fullchain.pem` at it (a renewal deploy hook should re-copy these on
renewal, since certbot's own storage path usually isn't readable by the
app's user).

Run directly once to confirm it starts clean (`node server.js`, then
`Ctrl-C`), then install as a systemd service:
```ini
# /etc/systemd/system/dialforge-backend.service
[Unit]
Description=DialForge Node.js backend
After=network.target mysql.service asterisk.service
Wants=mysql.service asterisk.service

[Service]
Type=simple
User=<your-app-user>
WorkingDirectory=/path/to/dialforge-backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/path/to/dialforge-backend/server.log
StandardError=append:/path/to/dialforge-backend/server.log

[Install]
WantedBy=multi-user.target
```
```
sudo systemctl daemon-reload
sudo systemctl enable --now dialforge-backend
curl -k https://localhost:3000/health   # {"status":"ok","db":"connected"}
```

### 1.6 Security group / firewall
Only expose what actually needs to be reachable from outside:
- `22` (SSH) - restrict to your own IP, not "Anywhere". This rule needs
  periodic attention if your IP changes (see RUNBOOK's Phase 14 SSH-outage
  note for what that looks like when it bites you).
- `3000` (this app, HTTPS)
- `5060` (SIP, UDP) - restrict to your trunk provider's IP(s) only.
- `10000-20000` (RTP, UDP)
- `8088`/`8089` (Asterisk HTTP/WSS, for WebRTC signaling)
- TURN ports if you run coturn (`3478`, `443`, `49152-49300` UDP relay range).
- **Not exposed**: MySQL (`3306`), AMI (`5038`) - both bound to localhost
  only, the app is the only thing that talks to them.

---

## 2. Deploying an update to an existing server

Once a server is set up per section 1, day-to-day updates are a normal git
pull, not a file-by-file push:
```
cd /path/to/dialforge-backend
git pull
npm install        # only picks up new/changed dependencies
sudo systemctl restart dialforge-backend
curl -k https://localhost:3000/health
```
If the update includes a schema change, apply the specific migration file
first (see `backend/migration-*.sql`), then regenerate `backend/schema.sql`
from the now-current live schema so the next fresh install stays accurate:
```
mysqldump -u dialforge -p --no-data --routines --triggers dialforge_dev > backend/schema.sql
```

---

## 3. What this guide deliberately doesn't cover yet

- Multi-tenant provisioning (Phase 4, not started).
- A CI pipeline or automated tests (none exist yet - see STATUS.md's tech
  debt list).
- Zero-downtime deploys - a restart currently drops in-flight WebSocket/ARI
  event handling for a few seconds. Acceptable at current scale; worth
  revisiting before real customer traffic.
