# DialForge — Deployment Guide

This is the procedural "how to actually run this" checklist, written so you
can follow it start to finish on a **brand new AWS server** without needing
help. For the narrative *why* behind these decisions, see `RUNBOOK.md`. For
current server facts about the *existing* live server, see `STATUS.md`.

Cloning the repo gets you the **code**. It does not get you a running system
- secrets, Asterisk, and the database schema still have to be set up once per
server, following the steps below.

**Scope of this walkthrough**: a fully working second server with Asterisk +
WebRTC calling + the full DialForge app (admin/agent panels, MySQL, queues,
campaigns, leads, reporting) - everything except the real PSTN trunk. The
trunk is deliberately left out (see Appendix B) because it requires your
trunk provider to allowlist this new server's IP, which is a conversation
with them, not something any document can do for you. Everything else here
works fully standalone with the two WebRTC test extensions (`1001`/`1002`).

---

## 0. Before you start

- **Time**: budget 2-3 hours including the Asterisk compile (which alone
  takes 20-40 minutes of just waiting - don't assume it's stuck).
- **Cost**: this needs more than a free-tier micro instance once everything's
  running (Asterisk + MySQL + Node together). Check **AWS Console → Billing
  → Free Tier** for your account's actual current entitlement before you
  launch anything, and pick an instance size you're comfortable paying for if
  it's outside free tier (the original server ended up on a `c7i-flex.large`,
  2 vCPU / ~3.7GB RAM, after outgrowing a micro instance).
- **A second domain/hostname**: your existing `dialforge.ddnsfree.com`
  already points at the original server - don't repoint it. Register a new
  free DDNS hostname (same Dynu service, or any free DDNS provider) for this
  new server once you have its Elastic IP.
- **Known gotchas you'll hit** (so you recognize them instead of panicking):
  - Asterisk's systemd unit needs `Type=simple`, not the bundled `Type=notify`
    default - without `libsystemd-dev` installed at compile time, systemd
    will show `activating` forever even though Asterisk is fully up.
  - coturn (TURN server) ships **disabled by default** on Ubuntu - you must
    explicitly enable it in `/etc/default/coturn`.
  - AWS EC2's public Elastic IP isn't bound to the network interface itself -
    Asterisk/WebRTC need to be explicitly told about it (NAT settings below),
    or calls will connect with zero audio.
  - Let's Encrypt's cert files are root-only readable by default - both
    Asterisk and the Node app run as non-root users, so both need a renewal
    hook that copies the cert somewhere they can read it.
  - Any AWS security group change you make has to actually be saved/confirmed
    - don't assume a step worked without checking it back.

---

## 1. Launch the EC2 instance

1. **AWS Console → EC2 → Launch Instance.**
   - AMI: Ubuntu Server 24.04 LTS.
   - Instance type: at least comparable to what the original server needed
     (see cost note above) - a `t3.medium` or larger is a safer starting
     point than a micro if you want headroom without resizing later.
   - Create/select a key pair (`.pem` file) - **this is the only way in**,
     there's no password login and no recovery if you lose it. Back it up
     somewhere other than just this one PC.
   - Allocate and associate an **Elastic IP** (static) so it never changes on
     reboot. Don't leave an allocated Elastic IP unattached to a running
     instance - that starts costing money even if you're not using it.

2. **Security group** - create a new one for this server (don't reuse the
   original's), with these inbound rules:

   | Port | Protocol | Source | Purpose |
   |---|---|---|---|
   | 22 | TCP | Your IP only | SSH |
   | 80 | TCP | Anywhere | Let's Encrypt HTTP-01 challenge (temporary use, fine to leave open) |
   | 8088 | TCP | Anywhere | Asterisk HTTP (ARI, static test page) |
   | 8089 | TCP | Anywhere | Asterisk HTTPS/WSS (WebRTC signaling) |
   | 10000-20000 | UDP | Anywhere | RTP media (call audio) |
   | 3478 | TCP + UDP | Anywhere | TURN server |
   | 49152-49300 | UDP | Anywhere | TURN relay media |
   | 3000 | TCP | Anywhere | DialForge app (HTTPS) |

   Not opened: `3306` (MySQL), `5038` (AMI) - both stay bound to `127.0.0.1`
   only, nothing external needs to reach them.

   The "Your IP only" rule on port 22 will need updating later if your IP
   changes (home/office ISPs usually assign dynamic IPs) - if SSH suddenly
   stops connecting, check this first before assuming something's broken on
   the server.

3. SSH in to confirm access before doing anything else:
   ```
   ssh -i your-key.pem ubuntu@<your-elastic-ip>
   ```

---

## 2. Base OS setup

```
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y build-essential git wget subversion libncurses5-dev \
  libssl-dev libxml2-dev libsqlite3-dev uuid-dev libjansson-dev pkg-config \
  libedit-dev automake libtool python3 unzip libsrtp2-dev
mkdir -p ~/src
```

---

## 3. Build Asterisk 22 from source

```
cd ~/src
wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz
tar xzf asterisk-22-current.tar.gz
cd asterisk-22.11.0   # or whatever the current 22.x patch version is
sudo contrib/scripts/install_prereq install
./configure
make                  # 20-40 minutes - this is normal, let it run
sudo make install
sudo make samples
sudo make config
```

Run Asterisk as its own non-root user (never run a public-facing daemon as
root):
```
sudo useradd -r -d /var/lib/asterisk asterisk 2>/dev/null || true
sudo chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /usr/lib/asterisk
```

Install the systemd unit, with the `Type=simple` fix mentioned in section 0:
```
sudo tee /etc/systemd/system/asterisk.service > /dev/null << 'EOF'
[Unit]
Description=Asterisk PBX and telephony daemon.
After=network.target

[Service]
Type=simple
Environment=HOME=/var/lib/asterisk
WorkingDirectory=/var/lib/asterisk
User=asterisk
Group=asterisk
ExecStart=/usr/sbin/asterisk -mqf -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
RuntimeDirectory=asterisk
LimitCORE=infinity
Restart=always
RestartSec=4
StandardOutput=null
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now asterisk
sudo asterisk -rx "core show version"   # confirm it's actually running
```

---

## 4. PJSIP: WebRTC transport + two test extensions

Edit `/etc/asterisk/pjsip.conf` - **replace its contents entirely** (the
`make samples` default is just reference noise) with:

```ini
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0
external_media_address=<YOUR ELASTIC IP>
external_signaling_address=<YOUR ELASTIC IP>
local_net=<YOUR PRIVATE SUBNET, e.g. 172.31.0.0/20 - check with `hostname -I` and your VPC CIDR>

[1001]
type=endpoint
context=internal
disallow=all
allow=ulaw,opus
auth=1001
aors=1001
webrtc=yes

[1001]
type=auth
auth_type=userpass
username=1001
password=<pick a strong password>

[1001]
type=aor
max_contacts=1
remove_existing=yes

[1002]
type=endpoint
context=internal
disallow=all
allow=ulaw,opus
auth=1002
aors=1002
webrtc=yes

[1002]
type=auth
auth_type=userpass
username=1002
password=<pick a strong password>

[1002]
type=aor
max_contacts=1
remove_existing=yes
```

`ulaw` is listed before `opus` deliberately - stock Asterisk can't *encode*
opus (only pass through already-opus audio), so `ulaw` needs to be the
preferred codec; `opus` stays as a fallback for browser compatibility.

Edit `/etc/asterisk/extensions.conf`, add (or replace the `[internal]`
context if `make samples` created a placeholder one):
```ini
[internal]
exten => 1001,1,NoOp(Calling 1001)
 same => n,Dial(PJSIP/1001,20)
 same => n,Hangup()

exten => 1002,1,NoOp(Calling 1002)
 same => n,Dial(PJSIP/1002,20)
 same => n,Hangup()

exten => 9000,1,NoOp(Entering ARI Stasis app)
 same => n,Stasis(dialforge-app)
 same => n,Hangup()
```
(`9000` is the extension the DialForge Node app actually controls via ARI -
this is what the agent panel's WebRTC softphone ultimately uses.)

Edit `/etc/asterisk/http.conf` - **edit the existing `[general]` section in
place, don't paste a second `[general]` below it.** `make samples` already
created one (with `bindaddr=127.0.0.1`), and Asterisk only reads the *first*
`[general]` in this file - a second one is silently ignored, leaving the HTTP
server disabled. Remove/comment the stock `bindaddr=127.0.0.1` line, so the
file ends up with exactly one `[general]` containing:
```ini
[general]
enabled=yes
enablestatic=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/dialforge.crt
tlsprivatekey=/etc/asterisk/keys/dialforge.key
```
(The cert files don't exist yet - section 6 creates them. Asterisk will fail
to start TLS until then; that's expected at this point.)

After section 6 (once the cert exists), verify it actually took effect:
```
sudo asterisk -rx "http show status"
```
It must say `Server Enabled and Bound to 0.0.0.0:8088` **and**
`HTTPS Server Enabled and Bound to 0.0.0.0:8089`, and list `/static/...`
under Enabled URIs. `Server Disabled` means a duplicate `[general]` (above).

**The AWS NAT fix** (section 0's gotcha) - edit `/etc/asterisk/rtp.conf`,
find/add the `[ice_host_candidates]` section:
```ini
[ice_host_candidates]
<YOUR PRIVATE IP, from `hostname -I`> => <YOUR ELASTIC IP>
```
Without this, WebRTC calls will connect but have zero audio in both
directions - Asterisk advertises its private IP as an ICE candidate, which
is unreachable from outside AWS's network.

```
sudo mkdir -p /etc/asterisk/keys
sudo chown asterisk:asterisk /etc/asterisk/keys
```

---

## 5. TURN server (coturn)

Needed for real-world WebRTC - direct peer-to-peer media fails behind
symmetric NAT (common on corporate/mobile networks), and TURN relays the
media through this server instead.

```
sudo apt-get install -y coturn
```
Edit `/etc/turnserver.conf`:
```ini
listening-port=3478
listening-ip=0.0.0.0
external-ip=<YOUR ELASTIC IP>/<YOUR PRIVATE IP>
relay-ip=<YOUR PRIVATE IP>
min-port=49152
max-port=49300
realm=<YOUR ELASTIC IP>
lt-cred-mech
user=dialforge:<pick a strong password>
fingerprint
no-cli
no-tls
no-dtls
log-file=/var/log/turnserver/turnserver.log
simple-log
```
**Enable it** (ships disabled by default - section 0's gotcha):
```
sudo sed -i 's/TURNSERVER_ENABLED=0/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo mkdir -p /var/log/turnserver && sudo chown turnserver:turnserver /var/log/turnserver
sudo systemctl enable --now coturn
sudo systemctl status coturn   # confirm it's actually running, not just enabled
```

---

## 6. Domain + Let's Encrypt cert

Point your new free DDNS hostname (section 0) at this server's Elastic IP
before continuing - the cert can't be issued until DNS actually resolves.

```
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d your-new-hostname.example.com
```
(`--standalone` briefly binds port 80 itself for the HTTP-01 challenge - the
security group rule from section 1 needs port 80 open for this to succeed.)

Both Asterisk and the Node app run as non-root users that can't read
Let's Encrypt's own cert storage directly, so each needs a renewal hook that
copies the cert somewhere they can read:

```
sudo tee /etc/letsencrypt/renewal-hooks/deploy/asterisk-cert-copy.sh > /dev/null << 'EOF'
#!/bin/bash
set -e
cp /etc/letsencrypt/live/your-new-hostname.example.com/fullchain.pem /etc/asterisk/keys/dialforge.crt
cp /etc/letsencrypt/live/your-new-hostname.example.com/privkey.pem /etc/asterisk/keys/dialforge.key
chown asterisk:asterisk /etc/asterisk/keys/dialforge.crt /etc/asterisk/keys/dialforge.key
systemctl restart asterisk
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/asterisk-cert-copy.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/asterisk-cert-copy.sh   # run it once now, manually
```

Certs auto-renew via certbot's own systemd timer going forward - this hook
runs automatically on every future renewal, not just this first time.

```
sudo systemctl restart asterisk
sudo asterisk -rx "core show version"   # confirm it came back up with TLS enabled
```

**Test the Phase-0 milestone before going any further**: Asterisk ships a
static file server (enabled via `enablestatic=yes` above). The test page is
`phase0/test.html` in this repo - a two-tab register-and-call JsSIP page with
no credentials inside (you type them into the page at test time). Copy it up
(from your PC, Git Bash):
```
scp -i <your-key>.pem phase0/test.html ubuntu@<YOUR ELASTIC IP>:/tmp/
```
then on the server:
```
sudo mv /tmp/test.html /var/lib/asterisk/static-http/
sudo chown asterisk:asterisk /var/lib/asterisk/static-http/test.html
```
Open `https://your-new-hostname.example.com:8089/static/test.html` in two
browser windows (Chrome normal + Incognito works well on one PC; headphones
avoid echo). Fill in the hostname, extension (`1001` / `1002`), SIP password
from `pjsip.conf`, TURN IP/user/password from `turnserver.conf`, and
**leave "Force TURN relay only" unticked for the first test**. Register both,
call from one, click **Answer** in the other within 20s (`Dial()` timeout),
and confirm audio both ways. Check `sudo asterisk -rx "pjsip show contacts"`
lists both. **Don't move on to the app layer until this works** - it's much
easier to debug WebRTC/NAT/TURN issues in isolation than mixed in with the
Node app.

Once the direct test passes, repeat with **"Force TURN relay only" ticked**
in both windows - this proves coturn works from a browser, which real users
on strict corporate/mobile networks will depend on.

Phase-0 troubleshooting (all hit for real on the DialForge_Testing rebuild):

| Symptom | Cause / fix |
|---|---|
| Page won't load, `http show status` says `Server Disabled` | Duplicate `[general]` in `http.conf` (section 4) |
| Browser console: `ERR_NAME_NOT_RESOLVED` for the hostname | Local DNS cached "doesn't exist" from before the DDNS record was created - `ipconfig /flushdns` + Chrome `chrome://net-internals/#dns` → Clear host cache |
| Clicking Call does nothing for 20-40s, or callee rings but never answers | Browser slow at ICE gathering (VPN/VirtualBox/Hyper-V adapters on Windows). `test.html` already works around this by sending after the first usable candidate or 3s - make sure the server has the current version (hard-refresh with Ctrl+Shift+R) |
| Call "connects" but no audio; SIP trace (`pjsip set logger on`) shows `c=IN IP4 0.0.0.0` / `m=audio 9` with no `a=candidate` lines, and Asterisk logs "placed on hold" | Browser produced zero ICE candidates - almost always "Force TURN relay only" ticked while the browser's TURN login fails (wrong TURN user/password typed). Untick it, or fix the credentials; `chrome://webrtc-internals` → `icecandidateerror` shows the code (`401` = bad credentials, `701` = TURN unreachable) |
| `Unable to find a codec translation path (ulaw/opus)` warnings | Harmless as long as both legs negotiate `ulaw` (they do with the endpoint config above) |

---

## 7. Node.js

```
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v24.x
```

---

## 8. MySQL

```
sudo apt-get install -y mysql-server
sudo mysql -e "
CREATE DATABASE dialforge_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'dialforge'@'localhost' IDENTIFIED BY '<pick a strong password>';
GRANT ALL PRIVILEGES ON dialforge_dev.* TO 'dialforge'@'localhost';
"
```

---

## 9. Clone the repo and load the schema

```
cd ~
git clone https://github.com/ShankarBhai28/Dialforge.git dialforge-backend-repo
```
(Clone wherever you like; the rest of this guide assumes the backend ends up
running from `~/dialforge-backend` - either clone directly there, or copy
`backend/` out of the repo into that path. Keeping the git clone itself
separate from the running copy is optional but keeps `git pull` simple later
- pick whichever you'll remember.)

```
cd ~/dialforge-backend-repo/backend
mysql -u dialforge -p dialforge_dev < schema.sql
```

Seed the two test extensions this app expects (matching the PJSIP config
from section 4):
```sql
mysql -u dialforge -p dialforge_dev -e "
INSERT INTO tenants (id, name) VALUES (1, 'Default') ON DUPLICATE KEY UPDATE name=name;
INSERT INTO extensions (tenant_id, name, sip_password) VALUES
  (1, '1001', '<same password as pjsip.conf [1001] auth>'),
  (1, '1002', '<same password as pjsip.conf [1002] auth>');
"
```

---

## 10. App secrets (`.env`)

```
cp .env.example .env
```
Fill in every value - this is the single place all the passwords you picked
in sections 4/5/8 come together:

| Variable | Value |
|---|---|
| `DB_PASSWORD` | the MySQL password from section 8 |
| `ARI_PASS` | pick a new strong value - goes in `ari.conf` too (section 11) |
| `AMI_PASS` | pick a new strong value - goes in `manager.conf` too (section 11) |
| `SESSION_SECRET` | any long random string, e.g. `openssl rand -base64 36` |
| `ADMIN_PASSWORD` / `AGENT1001_PASSWORD` / `AGENT1002_PASSWORD` | pick strong values - used once by `seed-users.js` below |
| `TRUNK_ENDPOINT` / `TRUNK_CALLER_ID` | leave the `.env.example` defaults - unused until you add a trunk (Appendix B) |
| everything else | the `.env.example` defaults are fine |

**Never commit `.env`** - it's git-ignored for exactly this reason.

---

## 11. Asterisk-side ARI/AMI users (must match `.env`)

Edit `/etc/asterisk/ari.conf`, add at the bottom:
```ini
[dialforge]
type=user
read_only=no
password=<same value as ARI_PASS in .env>
```

Edit `/etc/asterisk/manager.conf`, add at the bottom:
```ini
[dialforge]
secret=<same value as AMI_PASS in .env>
deny=0.0.0.0/0.0.0.0
permit=127.0.0.1/255.255.255.255
read=system,call,agent,user,config
write=system,call,agent,user,config
```
(Scoped permissions, not `all` - least privilege. Bound to localhost via
`permit`/`deny` here, and `manager.conf`'s `[general]` `bindaddr=127.0.0.1`
should already default that way from `make samples`.)

```
sudo asterisk -rx "module reload res_ari.so"
sudo asterisk -rx "manager reload"
```

Edit `/etc/asterisk/queues.conf` - leave the `[general]` section from
`make samples` as-is (just needs `persistentmembers = yes` to exist, which
it does by default). **Don't hand-author queue stanzas below it** - the app
itself writes/edits/removes those at runtime (see `backend/server.js`'s
`QUEUES_CONF_PATH` handling); anything you add by hand will be clobbered the
first time an admin creates a queue through the UI.

---

## 12. Node backend's own cert copy + renewal hook

The Node app can't read Let's Encrypt's root-only cert storage either:
```
mkdir -p ~/dialforge-backend/certs
sudo cp /etc/letsencrypt/live/your-new-hostname.example.com/fullchain.pem ~/dialforge-backend/certs/
sudo cp /etc/letsencrypt/live/your-new-hostname.example.com/privkey.pem ~/dialforge-backend/certs/
sudo chown ubuntu:ubuntu ~/dialforge-backend/certs/*.pem
chmod 600 ~/dialforge-backend/certs/privkey.pem
```
```
sudo tee /etc/letsencrypt/renewal-hooks/deploy/node-cert-copy.sh > /dev/null << 'EOF'
#!/bin/bash
set -e
DEST=/home/ubuntu/dialforge-backend/certs
cp /etc/letsencrypt/live/your-new-hostname.example.com/fullchain.pem "$DEST/fullchain.pem"
cp /etc/letsencrypt/live/your-new-hostname.example.com/privkey.pem "$DEST/privkey.pem"
chown ubuntu:ubuntu "$DEST"/fullchain.pem "$DEST"/privkey.pem
chmod 600 "$DEST"/privkey.pem
systemctl restart dialforge-backend
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/node-cert-copy.sh
```

---

## 13. Install, seed, and run the app

```
cd ~/dialforge-backend-repo/backend
npm install
node seed-users.js
```
(Reads `ADMIN_PASSWORD`/`AGENT1001_PASSWORD`/`AGENT1002_PASSWORD` from `.env`
- creates the three initial login accounts.)

Run once directly to confirm it starts clean:
```
node server.js
```
You should see `[ARI] app "dialforge-app" connected` and `DialForge backend
listening on port 3000 (HTTPS)` with no errors. `Ctrl-C` to stop it, then
install as a systemd service:
```
sudo tee /etc/systemd/system/dialforge-backend.service > /dev/null << 'EOF'
[Unit]
Description=DialForge Node.js backend
After=network.target mysql.service asterisk.service
Wants=mysql.service asterisk.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/dialforge-backend-repo/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/home/ubuntu/dialforge-backend-repo/backend/server.log
StandardError=append:/home/ubuntu/dialforge-backend-repo/backend/server.log

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now dialforge-backend
curl -k https://localhost:3000/health   # expect {"status":"ok","db":"connected"}
```

---

## 14. End-to-end verification checklist

Work through these in order - each one isolates a different layer, so if
something fails you'll know roughly where:

1. `curl -k https://localhost:3000/health` → `{"status":"ok","db":"connected"}`
2. `https://your-new-hostname.example.com:3000/login.html` loads without a
   certificate warning (confirms the domain/cert, not just the raw IP).
3. Log in as `admin` with the password you set in `.env` → lands on the
   admin dashboard.
4. **Users** section shows the three seeded accounts.
5. Log in as `agent1001` in a second browser (or incognito tab) → agent
   panel loads, and the embedded WebRTC softphone registers (check the
   status indicator in the panel).
6. From the agent panel, dial `9000` (or whatever test flow the panel
   exposes) and confirm the call connects with audio - this is the real
   proof that Asterisk, ARI, AMI, and the app are all correctly wired
   together, not just individually running.
7. Admin panel's **Queues**/**Campaigns** sections - create one of each,
   confirm `asterisk -rx "queue show"` on the server reflects the new queue
   (proves the app's live `queues.conf` editing + reload is working).

If all seven pass, you have a fully working, independent DialForge
environment on a new server.

---

## 15. Deploying an update to an existing server

**Preferred:** `scripts/deploy-dev.sh` from a developer machine. It does the backup, the build of the React app (`backend/web-dist`), the install, a restart of only what changed, and the health checks; see `docs/CONTRIBUTING.md` §6. The `git pull` route below is for a server that has the repo checked out. Either way, the React app has to be built (`npm run build:web`), because `backend/web-dist` is not in git.

Once a server is set up per sections 1-14, day-to-day updates are a normal
git pull, not a file-by-file push:
```
cd ~/dialforge-backend-repo
git pull
cd backend && npm install        # only picks up new/changed dependencies
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

## Appendix A — Troubleshooting index

| Symptom | Likely cause |
|---|---|
| `systemctl status asterisk` stuck on `activating` forever | `Type=notify` instead of `Type=simple` in the unit (section 3) |
| WebRTC call connects, zero audio both directions | Missing/wrong `[ice_host_candidates]` in `rtp.conf` (section 4), or `external_media_address` missing from the PJSIP transport |
| WebRTC call drops or never connects for some networks only | Symmetric NAT on that network - confirms you need coturn (section 5), or coturn isn't actually enabled (`TURNSERVER_ENABLED`) |
| Browser cert warning on the test page or app | You're hitting the raw IP, not the domain - the cert is only valid for the hostname |
| Asterisk won't start after editing `http.conf` | Cert files referenced in `tlscertfile`/`tlsprivatekey` don't exist yet - do section 6 first |
| `node server.js` exits immediately listing missing env vars | `.env` incomplete - check against `.env.example` |
| Admin login works but agent's WebRTC softphone never registers | PJSIP password in `pjsip.conf` doesn't match what's in the `extensions` table's `sip_password` column (section 9) |
| SSH suddenly stops connecting | Your IP changed and the security group's "My IP" rule is stale (section 1) - update it in the AWS Console |
| `queue show` doesn't reflect a queue created in the admin UI | Check `server.log` for a `[Queue config write/reload failed]` error - usually a permissions issue on `queues.conf` |

## Appendix B — Adding the real PSTN trunk later

Deliberately skipped in this walkthrough. When you're ready:
1. Contact your trunk provider (nxtra/Tata, or whichever you use for this
   server) and give them this server's Elastic IP to allowlist.
2. Add a `[your-trunk-name]` endpoint/auth/aor set to `pjsip.conf` (see
   `RUNBOOK.md` Phase 2 for the exact shape used on the original server -
   structure only, the real credentials are provider-specific and never
   committed anywhere).
3. Set `TRUNK_ENDPOINT`/`TRUNK_CALLER_ID` in `.env` to match.
4. Add a DID → campaign mapping in the admin UI's **DID Numbers** section.

## Appendix C — What this guide deliberately doesn't cover

- Multi-tenant provisioning (Phase 4, not started).
- A CI pipeline or automated tests (none exist yet - see `STATUS.md`'s tech
  debt list).
- Zero-downtime deploys - a restart currently drops in-flight WebSocket/ARI
  event handling for a few seconds. Acceptable at current scale; worth
  revisiting before real customer traffic.
- phpMyAdmin / Apache setup (nice-to-have DB GUI on the original server, not
  required for the app to function - see `STATUS.md` if you want it too).
