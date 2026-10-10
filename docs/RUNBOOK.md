# DialForge — Setup Runbook

This is a running log of every infrastructure/setup step taken on this project, why it was done, and what to watch out for. Goal: you should be able to read this and redo/understand/manage everything here without needing anyone's help.

---

## Server: dialforge-dev

- **Provider**: AWS, region `ap-south-1` (Mumbai)
- **Instance**: EC2, free-tier-eligible micro type (t2.micro/t3.micro), Ubuntu Server 24.04.4 LTS
- **Elastic IP**: `3.7.241.104` (static — associated to the instance so it never changes on reboot)
- **Login**: `ssh -i dialforge-key.pem ubuntu@3.7.241.104` — the `.pem` key is the *only* way in, there is no password login and no recovery if it's lost. Keep a backup copy somewhere safe (not just one folder on one PC).
- **AWS access**: logged in via IAM user (`shankar-admin`), MFA enabled on the root account, root itself is not used day-to-day and has no API access keys. This is correct practice — don't change it.

### Security group (`dialforge-sg`) rules

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | My IP only | SSH login |
| 5060 | TCP | Anywhere | SIP signaling (for when the trunk arrives) |
| 8089 | TCP | Anywhere | Asterisk HTTPS/WebSocket (WebRTC) |
| 10000-20000 | UDP | Anywhere | RTP media (actual call audio) |
| 3478 | TCP + UDP | Anywhere | TURN server signaling |
| 49152-49300 | UDP | Anywhere | TURN relay media |
| 443 | TCP + UDP | Anywhere | **TODO — needs to be added by you in AWS Console**: fallback TURN listener for restrictive networks (see below) |

**Note on port 22**: it's locked to "My IP" as of setup time — if your home/office IP changes (most ISPs assign dynamic IPs), you'll need to update this rule in the AWS Console (EC2 → Security Groups → dialforge-sg → Edit inbound rules) or you'll be locked out of SSH. This is a real thing that will happen eventually — don't be alarmed, just update the rule.

---

## Software installed so far

### 1. System update
```
sudo apt-get update -y && sudo apt-get upgrade -y
```
Standard practice on any fresh server before installing anything else.

### 2. Build tools & libraries
```
sudo apt-get install -y build-essential git wget subversion libncurses5-dev \
  libssl-dev libxml2-dev libsqlite3-dev uuid-dev libjansson-dev pkg-config \
  libedit-dev automake libtool python3 unzip libsrtp2-dev
```
Needed to compile Asterisk and its dependencies from source (we're not using the Ubuntu `apt` Asterisk package — it's an older version without full PJSIP support).

### 3. pjproject 2.17 (manual build — turned out to be optional, see note)
```
cd ~/src
git clone --depth 1 --branch 2.17 https://github.com/pjsip/pjproject.git
cd pjproject
./configure --enable-shared --disable-sound --disable-resample --disable-video --disable-opencore-amr CFLAGS='-O2 -DNDEBUG'
make dep && make && sudo make install && sudo ldconfig
```
**Learning note**: Asterisk's own build system actually ended up using its *own bundled copy* of pjproject (under `asterisk-22.11.0/third-party/pjproject/`) instead of this system-wide one — that's normal, expected behavior since Asterisk 13+. Asterisk maintains its own tested/patched pjproject fork rather than trusting whatever version is installed system-wide, since subtle version mismatches there can cause hard-to-debug call issues. This manual build wasn't wasted — good to understand both paths exist — but wasn't strictly required.

### 4. Asterisk 22.11.0 (current LTS)
Asterisk uses **even-numbered releases as LTS** (~4 years of support) and odd-numbered as short-term releases. 22 is the current LTS as of this build — the right choice for something meant to run long-term, rather than the newest (23) which gets dropped sooner.

```
cd ~/src
wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz
tar xzf asterisk-22-current.tar.gz
cd asterisk-22.11.0
sudo contrib/scripts/install_prereq install   # OS-level deps Asterisk itself needs
./configure                                    # confirmed: detected bundled pjproject correctly
make                                           # <- IN PROGRESS as of this writing
```

**Status**: build completed successfully, installed via `sudo make install`, `make samples`, `make config`.

### 5. Running Asterisk as a proper (non-root) systemd service
Created a dedicated `asterisk` system user/group (security best practice — never run a public-facing daemon as root), set ownership of `/etc/asterisk`, `/var/lib/asterisk`, `/var/log/asterisk`, `/var/spool/asterisk`, `/usr/lib/asterisk`. Installed the bundled unit at `contrib/systemd/asterisk.service` → `/etc/systemd/system/asterisk.service`.

**Gotcha hit**: the bundled unit uses `Type=notify`, which requires Asterisk to have been compiled with `libsystemd-dev` (we didn't install it) so it can signal systemd when it's actually ready. Without that, systemd sits forever showing `activating` even though Asterisk is fully running — confirmed via `asterisk -rx 'core show version'` responding fine while systemd disagreed. Fixed by changing the unit to `Type=simple`, which doesn't need that signal. (Nice-to-have for later: rebuild with `libsystemd-dev` and revert to `Type=notify` for more accurate systemd health reporting — not urgent.)

### 6. PJSIP config — two test WebRTC endpoints (Phase 0 milestone)
- `pjsip.conf`: one `wss` transport, two endpoints (`1001`, `1002`) using the `webrtc=yes` shortcut (auto-configures ICE, DTLS, rtcp-mux — the standard WebRTC endpoint settings).
- `extensions.conf`: minimal dialplan so `1001` and `1002` can dial each other directly.
- Self-signed TLS cert generated for now (`/etc/asterisk/keys/dialforge.crt`/`.key`) — browsers will warn about it until we get a real domain + Let's Encrypt cert (see "Next: real domain" below).
- A test softphone page (JsSIP-based) hosted directly via Asterisk's own static file server at `https://3.7.241.104:8089/static/test.html` — lets two browser tabs register as 1001/1002 and call each other without needing a separate web server.

### 7. Debugging the first real WebRTC test call — three real bugs found and fixed
This is worth reading in full since these are exactly the kind of issues every WebRTC deployment hits, not mistakes specific to us:

1. **Call wouldn't connect at all** — the test page's own JS threw an error (`session.connection` was `null`) before it ever reached the line that actually answers the call. Fixed by using JsSIP's `peerconnection` event instead, which reliably fires once the connection object actually exists. *Lesson: for an incoming WebRTC call, the underlying connection object isn't created until you call `answer()` — don't assume it exists earlier.*
2. **Call connected but zero audio, both directions** — Asterisk was advertising its *private* EC2 IP (`172.31.10.157`) in the call's media info instead of the public Elastic IP. This is an AWS-specific gotcha: the public IP is mapped by AWS's network layer, not bound to the actual network interface, so Asterisk has no way to know it unless told. Fixed with **two separate settings** (both are needed, they solve different things):
   - `external_media_address`/`external_signaling_address`/`local_net` on the PJSIP transport (classic NAT handling)
   - `[ice_host_candidates]` mapping in `rtp.conf` (`172.31.10.157 => 3.7.241.104`) — this is the one that actually matters for WebRTC specifically, since WebRTC always negotiates via ICE candidates, not the classic path.
   - Also added a public STUN server (`stun.l.google.com:19302`) to the browser side, since your home/office network is behind NAT too and needs to discover its own public address.
3. **One-way / no audio despite everything above** — confirmed via `rtp set debug on`: Asterisk was sending media out fine to both real (distinct, geographically separate) callers, but receiving *zero* packets back from either side. This is the signature of **symmetric NAT** on one or both client networks — the ICE connectivity check can succeed (it's a small back-and-forth) while the actual continuous media stream never lands correctly. The standard, expected fix (not a workaround) is a **TURN server** — see next section.

### 8. TURN server (coturn)
Every real WebRTC deployment needs one of these, not just STUN — it relays media through a public server when direct peer-to-peer traversal fails (symmetric NAT, restrictive corporate firewalls, etc.).
```
sudo apt-get install -y coturn
```
Config at `/etc/turnserver.conf`:
```
listening-port=3478
external-ip=3.7.241.104/172.31.10.157
relay-ip=172.31.10.157
min-port=49152
max-port=49300
realm=3.7.241.104
lt-cred-mech
user=dialforge:<password>   # replaced 2026-10-09 by use-auth-secret - see "TURN secured" below
```
Enabled via `/etc/default/coturn` (`TURNSERVER_ENABLED=1` — the Debian/Ubuntu package ships disabled by default, a common first-run gotcha). Test page's `pcConfig.iceServers` updated to include this TURN server alongside the STUN one.

### 9. TURN on port 443 — restrictive-network fallback
After getting TURN working on 3478, we discovered (via an independent test using the public "Trickle ICE" tool at `webrtc.github.io/samples/src/content/peerconnection/trickle-ice`, with no dependency on our own app at all) that port 3478 was unreachable specifically from the tester's own network/ISP/office firewall — confirmed by testing the *same* port from a completely different network, which worked fine. This is a very common real-world problem: many restrictive networks block "unusual" ports but virtually never block 443, since that's what HTTPS itself depends on.

Fix: a **second coturn instance** listening on port 443 (plain TCP+UDP, no TLS needed — testing whether the block is port-based or protocol-based):
- New config: `/etc/turnserver-443.conf` (same settings as the main one, just `listening-port=443`)
- Granted the `turnserver` binary permission to bind low ports without running as root: `sudo setcap 'cap_net_bind_service=+ep' /usr/bin/turnserver`
- New systemd service `coturn-443.service` (copy of the main `coturn.service` pattern, pointing at the new config)
- Test page's `iceServers` list now includes a third entry: `turn:3.7.241.104:443?transport=tcp`

**Still needed**: the security group rule for port 443 (see table above) — AWS Console changes have to be done by you, I don't have API access to your account (see [[feedback-dialforge-workstyle]] on why, and the earlier discussion about not using root API keys).

**Also found and fixed along the way**: two bugs in the test page itself while debugging this —
- A Python-string-escaping mistake on my end left literal raw newlines inside JS string literals, breaking the whole page's script. Lesson for future edits: when pushing file content over SSH, pipe the raw file directly (`cat file | ssh ... "tee remotefile"`) rather than embedding it inside nested Python/bash string escaping — zero risk of corruption that way.
- The ICE debug panel only ever showed data for the *callee* tab, not the caller — because for an outgoing call, JsSIP can create the underlying `RTCPeerConnection` before our `peerconnection` event listener even gets attached, so the event fires and is missed. Fixed by also checking `session.connection` immediately after session creation, in addition to listening for the event — covers both timing cases.

### PHASE 0 MILESTONE — COMPLETE ✅ (2026-09-24)
Two WebRTC extensions (1001, 1002) register and place a call to each other with **working audio in both directions**, over a fully fresh stack (own AWS box, own Asterisk 22 build, own PJSIP/ARI setup, own TURN infra, real domain + cert) — none of it copied from anywhere else.

**Root cause of the last blocker** (worth remembering — it wasn't the sophisticated network/DPI theory it looked like at first): the port 443 security group rule had been asked for but never actually confirmed added, because the conversation moved on to the domain/certbot setup before it was done. Once actually added (TCP + UDP, 0.0.0.0/0), the TURNS-on-443 fallback worked immediately. **Lesson for next time**: when a fix depends on the user completing an external action (AWS Console change), get an explicit yes/confirmation before treating it as done and moving on to the next diagnosis — don't assume silence means it happened.

Turned `rtp set debug`/`pjsip set logger` back off now that this is confirmed working — they're noisy and only needed while actively diagnosing.

### 10. Real domain + Let's Encrypt cert (done)
- Domain: **`dialforge.ddnsfree.com`** (via Dynu, free dynamic DNS) → points at Elastic IP `3.7.241.104`.
- Certificate obtained via `certbot certonly --standalone -d dialforge.ddnsfree.com` (needed port 80 open temporarily for the HTTP-01 challenge — now a permanent security group rule; standalone mode binds port 80 itself only during the brief validation, doesn't need anything else running there).
- **Permissions gotcha**: Let's Encrypt's private key is root-only readable by default, but Asterisk runs as its own `asterisk` user (see section 5). Fixed with a renewal deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/asterisk-cert-copy.sh`) that copies the cert/key to `/etc/asterisk/keys/` with correct ownership and restarts Asterisk — runs automatically on every renewal, not just this first time. Certs auto-renew via certbot's own systemd timer; expires 2026-12-23, will auto-renew before then.
- Test page (`test.html`) updated to use `wss://dialforge.ddnsfree.com:8089/ws` and `sip:...@dialforge.ddnsfree.com` instead of the raw IP — **required**, not cosmetic: the certificate is only valid for the hostname, so connecting via the IP now fails TLS validation. TURN server entries in `iceServers` were left as the raw IP (fine — that connection isn't TLS-validated in our current plain config).
- Test page URL is now: `https://dialforge.ddnsfree.com:8089/static/test.html` — no more browser security warning.

---

## Cost status

Nothing here should be generating charges yet, assuming your AWS account still has active free-tier coverage:
- The EC2 instance is a free-tier-eligible size.
- The Elastic IP is free *as long as it stays attached to a running instance* — if you ever stop the instance without releasing the IP, it starts costing money. Don't leave it allocated-but-unattached.
- No other paid AWS services have been touched (no RDS, no S3, no data transfer beyond normal usage).

**What to actually do**: check **AWS Console → Billing → Free Tier** yourself periodically — that page shows your account's real, current entitlement (I can't see your billing). I'll flag it here in this doc immediately if any step we take is going to cost money, before we take it — nothing so far has needed that.

---

## Security posture — done vs. still to do

**Done:**
- Root account: MFA enabled, no API keys, not used day-to-day (correct)
- IAM user used for AWS Console access instead of root
- SSH: key-only login (no password auth possible on this AMI by default), inbound restricted to your IP

**Still to do, before this box ever handles real calls/customers (will flag again when we get there):**
- `ufw` (or security-group-level) firewall review once Asterisk's actual ports are finalized
- `fail2ban` for SSH — public-facing SSH gets scanned/attacked constantly, even with a key-only login it's worth having
- Asterisk itself is a very common bot-scanning target once port 5060 is open to "Anywhere" (needed for the SIP trunk) — will need `fail2ban` rules for Asterisk's SIP registration attempts too, and strong secrets on every PJSIP endpoint (no default/weak passwords)
- Keep the box patched (`apt update && apt upgrade`) on a regular cadence, not just once at setup

---

## Phase 1 — ARI "Stasis hello world" (COMPLETE ✅ 2026-09-24)

Goal: stop routing calls through static dialplan `Dial()` commands, and instead hand control to our own code reacting to Asterisk's REST/WebSocket interface (ARI). This is the pattern everything later (real call logging, AI bot handoff) is built on.

### 1. Node.js
Installed via NodeSource (official repo, not the old Ubuntu-packaged version):
```
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```
Got Node.js 24 LTS.

### 2. ARI credentials
`ari.conf` already had `enabled = yes` from the Asterisk install, but no user configured. Added:
```
[dialforge]
type=user
read_only=no
password=<see backend/.env's ARI_PASS - rotated 2026-10-05, see Phase 14>
```

### 3. Dependency choice — worth remembering
Started with the community `ari-client` npm package, but `npm audit` flagged **2 critical vulnerabilities** — it depends on `request` (deprecated by its own maintainers years ago) and old `swagger-client`/`form-data` versions. Rather than build on that, wrote a **~60-line hand-rolled ARI client** using just Node's built-in `fetch` (for REST calls) and the `ws` package (for the event WebSocket) — zero vulnerabilities, one dependency, and it's more educational anyway since it shows exactly what ARI is doing (plain HTTP POSTs + a JSON event stream) instead of hiding it behind a library.

**Lesson for future dependency choices**: always run `npm audit` right after installing anything, especially for niche/small-community packages — don't assume a package being "the standard one for X" means it's still maintained or safe.

Code lives at `~/dialforge-ari/index.js` on the server (mirrored locally at `C:\Users\User01\DialForge\ari-hello-world\`). Logic: on `StasisStart`, answer the channel; if no one's waiting, wait; if someone is, create a mixing bridge and add both channels to it. Handles `StasisEnd` to clear the waiting slot if the first caller hangs up before a second arrives.

### 4. Dialplan hook
Added one extension that hands control to our app instead of dialing directly:
```
exten => 9000,1,NoOp(Entering ARI Stasis app)
 same => n,Stasis(dialforge-app)
 same => n,Hangup()
```
(The existing `1001`/`1002` direct-dial extensions were left untouched, so both the old dialplan-only path and the new ARI-controlled path exist side by side for comparison.)

### 5. Test result
Two WebRTC test extensions both dialing `9000` got bridged together **by our own Node.js code**, with working bidirectional audio (same WebRTC/TURN infra as Phase 0, just a different control path). Confirmed via the running app's log:
```
[StasisStart] 1001 → waiting for a second caller...
[StasisStart] 1002 arrives → [Bridged] 1001 <-> 1002
[StasisEnd] 1001 → call ended cleanly
```

**Current state / still to do**: the Node app is running manually (`nohup node index.js`, not a systemd service) — fine for active development, but will need a proper service (like we did for Asterisk) before it needs to run unattended/survive reboots. Not urgent yet.

---

## Phase 3 — Backend + Postgres + real click-to-call (in progress, core flow COMPLETE ✅ 2026-09-24)

### 1. PostgreSQL
```
sudo apt-get install -y postgresql postgresql-contrib
```
Got Postgres 16. Created a **dedicated app user/database**, not using the default `postgres` superuser — same principle as running Asterisk as its own non-root user:
```sql
CREATE USER dialforge WITH PASSWORD '<picked at the time - DB later moved to MySQL anyway, see section 7, and the password was rotated regardless, see Phase 14>';
CREATE DATABASE dialforge_dev OWNER dialforge;
```

### 2. Schema (`~/dialforge-backend/schema.sql`, mirrored locally at `C:\Users\User01\DialForge\backend\schema.sql`)
Deliberately minimal for this phase — only what click-to-call actually needs right now (`tenants`, `extensions`, `leads`, `calls`, `call_events`). Left out campaign/bot tables until Phases 4-5 actually need them — building unused tables now would just be guessing at a shape we don't know yet.

`call_events` is an append-only audit trail (event_type + JSONB payload) — this is the thing that would've made the tecdata click2call investigation days ago much faster (that system's call history was fragmented across `click2call`/`cdr`/`autodialer_outbound` tables with no single timeline).

`tenant_id` is on every table already, hardcoded to tenant `1` for now — the enforcement/multi-tenant-awareness comes later, but the column shape is right from day one.

### 3. Backend (`~/dialforge-backend/`, Node.js, plain JS — same reasoning as Phase 1)
- `db.js` — Postgres connection pool
- `ari.js` — same hand-rolled ARI client pattern as Phase 1, factored into reusable functions (`originate`, `answer`, `createBridge`, `addChannelToBridge`, `connectEvents`)
- `server.js` — Express API:
  - `GET /health` — DB connectivity check
  - `GET /leads`, `POST /leads`
  - `GET /calls`
  - `POST /calls/click2call { fromExtension, toNumber, leadId? }` — the real click-to-call flow
- Dependencies: `express`, `pg`, `ws` — **0 vulnerabilities** (checked via `npm audit` immediately after install, per the lesson from Phase 1)

### 4. How click-to-call actually works now
1. `POST /calls/click2call` inserts a `calls` row, then originates an ARI channel to the agent's own extension (`PJSIP/{fromExtension}`) tagged with `appArgs=click2call,{callId},agent`.
2. When that channel enters our Stasis app (agent picked up), we answer it, then originate a **second** channel to the destination, tagged `click2call,{callId},dest`.
3. When the destination channel enters Stasis (destination picked up), we create a bridge and add both channels to it.
4. Every step writes a `call_events` row — `originated → agent_answered → dest_answered → bridged → ended` — a complete, queryable timeline for every call, automatically.
5. **Important limitation, by design for now**: since there's no SIP trunk yet, `toNumber` is dialed as `PJSIP/{toNumber}` — meaning right now it only works if the "destination" is itself one of our registered test extensions (we tested `1001` calling `1002` this way). Once the real SIP trunk arrives (Phase 2), this becomes something like `PJSIP/{toNumber}@trunk-name` instead — noted directly in the code as a comment so it's not forgotten.

### 5. Real bug found and fixed: codec mismatch breaking the bridge
First test: the call bridged successfully but audio didn't work and the call dropped almost immediately (~140ms after bridging). Asterisk's log showed the actual cause clearly:
```
WARNING: Unable to find a codec translation path: (opus) -> (ulaw)
WARNING: Unable to find a codec translation path: (ulaw) -> (opus)
```
The two bridged legs had negotiated **different codecs** (one opus, one ulaw), and stock open-source Asterisk doesn't ship a free opus↔ulaw transcoder (historically a paid/commercial module) — so no usable audio could cross the bridge at all.

**Fix**: since both test extensions are pure WebRTC (no PSTN involved yet), restricted both to `allow=opus` only in `pjsip.conf` (removed `ulaw` from the allowed list) — no reason to allow a codec that can cause a mismatch when there's no PSTN leg needing it yet.

**Note for Phase 2 (when the real trunk arrives)**: PSTN trunks typically only support ulaw/alaw, not opus, so this exact transcoding problem will resurface for real outbound calls. The fix then will likely be having the *browser* negotiate ulaw directly for PSTN-bound calls (browsers support PCMU/ulaw natively) rather than trying to transcode opus↔ulaw in Asterisk — picking a common codec instead of translating between mismatched ones. Flagging this now so it's not a surprise later.

Retested after the fix: call stayed up 11.5 real seconds, working audio confirmed both directions, clean hangup logged.

### 6. Frontend (done)
Plain HTML + vanilla JS again (same reasoning as backend/Phase 1 — no React/build tooling yet). Served directly by the Express backend (`app.use(express.static('public'))`, file at `~/dialforge-backend/public/index.html`). Shows: add-lead form, leads table with a per-row Call button (posts to `/calls/click2call`), and a recent-calls table. URL: `http://3.7.241.104:3000/` (plain HTTP — fine for an internal dev tool for now, flagged as a to-do below).

### 7. Database engine switched: Postgres → MySQL
User is far more comfortable with MySQL/phpMyAdmin from prior experience — a completely valid reason to switch, familiarity accelerates everyone's ability to manage this independently. Postgres was stopped and disabled (`systemctl stop/disable postgresql`), not deleted, in case it's ever needed again.

- Installed `mysql-server` (8.0.46), created a dedicated `dialforge`@`localhost` user + `dialforge_dev` database (never using MySQL root for the app — same non-root principle as everywhere else in this project).
- Schema ported to MySQL syntax (`AUTO_INCREMENT` instead of `SERIAL`, `DATETIME` instead of `TIMESTAMPTZ`, explicit `FOREIGN KEY` clauses, `JSON` instead of `JSONB`) — kept at `backend/schema-mysql.sql`; the original Postgres version stays at `backend/schema.sql` for reference only, not in use.
- Backend rewritten: `pg` → `mysql2` driver. Real differences worth remembering if this comes up again: MySQL uses `?` placeholders (not Postgres's `$1,$2`), there's no `INSERT ... RETURNING *` (insert then look up by `result.insertId` instead), and query results come back as `[rows, fields]` tuples rather than `{rows: [...]}`.

### 8. phpMyAdmin + Apache + PHP
Installed `apache2`, `php` 8.3.6 with `php-mysqli` and friends, then phpMyAdmin **5.2.3 downloaded directly** (not the `.deb` package — its `dbconfig-common` interactive setup is notoriously fragile to automate headlessly over SSH). Configured with cookie-based auth (`auth_type = 'cookie'`) — you log in with real MySQL credentials at the page itself, nothing hardcoded in a config file.

**Real conflict found and fixed**: enabling Apache's `mod_ssl` (`a2enmod ssl`) automatically activates a `Listen 443` directive already present (commented via `<IfModule>`) in `ports.conf` — which collided with coturn's TURNS listener already legitimately on port 443. Apache crash-looped (`Address already in use`) until that `Listen 443` block was removed from `ports.conf`. **Lesson**: enabling any Apache module is worth double-checking for side effects like this, not just assuming it only does the one thing you wanted.

**Security decision**: phpMyAdmin is HTTPS-only, not plain HTTP — added a dedicated Apache vhost on port **8443** (443 itself being unavailable, taken by coturn) using the same Let's Encrypt cert as everything else, and the port-80 vhost force-redirects `/phpmyadmin` to it. Consistent with not leaving DB credentials traveling in plaintext anywhere in this project.

- URL: `https://dialforge.ddnsfree.com:8443/phpmyadmin/`
- Security group: 8443 open (chose "Anywhere" since it's login-protected anyway, but "My IP" is also a fine choice here)

**Second conflict, fixed**: Apache now permanently owns port 80, but certbot's renewal was configured for `--standalone` mode, which needs port 80 *free* to briefly bind during renewal — a real, if delayed-onset, breakage waiting to happen (would have silently failed the *next* renewal, not this one). Fixed by switching the renewal method to `--webroot` (edited `/etc/letsencrypt/renewal/dialforge.ddnsfree.com.conf`: `authenticator = standalone` → `webroot`, added a `[[webroot_map]]` pointing at `/var/www/html`). Verified with `certbot renew --dry-run` → **"Congratulations, all simulated renewals succeeded."**

### 9. Real incident: server became fully unresponsive (resolved)
Mid-way through this work, the server stopped responding to SSH entirely — even a trivial command timed out with zero response. Root cause: this was still the original free-tier micro instance (~911MB RAM), and running Asterisk + 2 coturn instances + MySQL + Apache/PHP all together, **with zero swap configured**, left it right at the edge — the `npm install` for the MySQL driver was enough to tip it over into unrecoverable memory pressure.

**Fixes applied**:
1. **Immediate/free**: added a 2GB swap file (`/swapfile`, persisted via `/etc/fstab`) — cheap insurance against this specific failure mode recurring.
2. **Real fix**: resized the instance. `t3.medium` wasn't available for this account/AZ, so went with **`c7i-flex.large`** instead (2 vCPU, ~4GB RAM, non-burstable compute — arguably better than `t3.medium` for workloads like Asterisk/MySQL that want consistent CPU rather than burst credits). Resize is a stop → change instance type → start cycle in the AWS Console; Elastic IP stays associated throughout, no DNS changes needed.

**Second bug found during recovery**: after the resize/reboot, `asterisk.service` showed `active` in systemd but the CLI (`asterisk -rx`) couldn't connect to its control socket. Cause: `/var/run/asterisk/` lives on `tmpfs` (wiped every reboot), and an earlier *manual* `chown asterisk:asterisk` on that directory (done once, by hand, back in Phase 0) obviously didn't survive a reboot — it came back as `root:asterisk` with permissions that block the `asterisk` user from creating its socket file there. **Proper fix**: uncommented `RuntimeDirectory=asterisk` in `/etc/systemd/system/asterisk.service` — this tells systemd itself to (re)create that directory with the correct ownership *every single time the service starts*, not just once by hand. This is now permanent and reboot-safe.

**General lesson from this whole incident**: a manual one-time fix to something that lives in a location wiped on reboot (tmpfs directories, in-memory state, etc.) isn't actually fixed — it needs to be encoded somewhere that runs automatically every time (a systemd directive, an `/etc/fstab` entry, a boot script), or it will silently regress the next time the box restarts.

**Current instance status (as of this writing)**: `c7i-flex.large`, 3.7GB RAM (2.9GB available), 2 vCPU, 2GB swap. All services confirmed active and correctly surviving the reboot: Asterisk, coturn, coturn-443, MySQL, Apache.

---

## Phase 5 — AI bot integration, audio plumbing (COMPLETE ✅ 2026-09-25)

Goal for this milestone: prove Asterisk can stream a live call's audio into our own code, and that our code can play audio back into the call — all before touching any real AI provider or spending a cent on API usage.

### 1. New service: `bot-service` (separate from `dialforge-backend`)
Deliberately its own project (`~/dialforge-bot-service/`, mirrored locally at `C:\Users\User01\DialForge\bot-service\`), not folded into the backend — matches the original architecture plan (AI bot component scales/deploys independently, likely ends up as its own Python service eventually for the STT/LLM SDKs).

Needed its **own ARI app name** (`dialforge-bot-app`, distinct from the backend's `dialforge-app`) and its **own dialplan extension** (`9001`) — Asterisk only allows one live connection per ARI app name, so two independent services can't share one app.

### 2. The mechanism: ARI `externalMedia`
This is Asterisk's built-in way to stream a channel's raw audio to an external process: create a special `externalMedia` channel pointed at an address:port we control, then add it to the same bridge as the real caller. Our Node service just needs a UDP listener (`dgram`, built-in, no dependency) bound before the call starts (`connection_type=client` means Asterisk connects out to us, so we must already be listening).

**First test (receive-only)**: worked on the very first try — hundreds of RTP packets/sec logged flowing from a live call straight into our own code.

### 3. Two real bugs hit trying to prove the *return* path, and the actual root cause
**Attempt 1 — raw RTP echo**: hand-built RTP packets (12-byte header + mirrored payload) sent back over the same UDP socket. Verified via packet capture (`tcpdump`) that these packets were byte-for-byte correct and genuinely reached Asterisk's process — yet the caller heard nothing. This sent me down a long, ultimately wrong diagnostic path (`ss`, `tcpdump` on the wrong interface, hex-dumping RTP headers) before finding the real explanation below.

**Attempt 2 — ARI `play` instead of raw RTP** (the right call in general — this is what real TTS playback will actually use): first tried playing directly to the caller's channel, which silently did nothing since the channel was already inside an active bridge — fixed by playing to the **bridge** instead (`POST /bridges/{id}/play`, not `/channels/{id}/play`) once a channel is bridged.

**The real root cause, found via Asterisk's own log** (not something either of the above two fixes alone could solve):
```
WARNING: Unable to find a codec translation path: (gsm) -> (opus)
WARNING: file.c: Unable to open hello-world (format (opus)): Function not implemented
```
Our Asterisk build can **decode/pass-through opus but cannot *encode* it** (the free/bundled opus module isn't a full codec, just enough to relay already-opus-encoded browser audio). Since our test extensions were restricted to `allow=opus` only (the Phase 3 fix), Asterisk had no way to turn *any* server-side audio — a sound file, our echoed packets, future TTS output — into opus. This explains both failures above with one root cause, and also explains why the raw-RTP echo attempt failed silently rather than erroring: the receive side likely has similar validation quietly rejecting it.

**The fix**: reordered the codec list for `1001`/`1002` from `allow=opus` to **`allow=ulaw,opus`** (ulaw preferred). Browsers fully support ulaw natively, so this doesn't hurt normal browser-to-browser calling — and since ulaw/slin/gsm are all freely transcodable in stock Asterisk (only opus encoding was the gap), this immediately unblocked both the echo and the ARI-play mechanisms. Also switched the `externalMedia` channel's requested format from `opus` to `slin` (raw PCM) to match — which is what we'll actually want for feeding real STT later anyway.

**Bonus**: this same fix is needed for Phase 2 anyway — PSTN trunks only speak ulaw/alaw, never opus. One change now saves doing it twice later.

**Retested after the fix**: both the raw RTP echo *and* the ARI `bridges/{id}/play` sound playback worked correctly in the same call.

**Next steps for Phase 5** (not started yet): decode the incoming `slin` PCM for real STT, wire up the chosen combined realtime API (OpenAI Realtime or Gemini Live, per earlier decision), and replace the raw-echo code with real conversation logic — the `play`-to-bridge mechanism proven here is what will deliver the AI's spoken responses back to the caller.

---

## Frontend v2 — Agent panel redesign (COMPLETE ✅ 2026-09-25)

Goal: real login/role system (agent vs admin) plus a genuinely polished agent panel — inspired by a competitor's UI (screenshots the user provided, kept private, not named here) for the *feature/UX pattern* (status toggle with break reasons, Login/Talk/Break/Handle/ACW time tiles, a live call-log side panel), but with our own distinct visual identity — never copying their logo, colors, or exact layout. These are standard contact-center UX patterns, not anyone's proprietary invention.

### 1. Real authentication
- New `users` table: username, bcrypt password hash, role (`admin`/`agent`), linked `extension_id` (agents only).
- `bcryptjs` + `express-session` (in-memory session store — fine for single-instance dev, would need a real store like Redis before horizontal scaling).
- Seeded 1 admin + 2 agent accounts (`seed-users.js`, one-time script) linked to the existing `1001`/`1002` test extensions.
- Route protection: `requireAuth`, `requireRole('admin')` middleware. Critically, an **agent's `fromExtension` on click-to-call is always taken from their own session, never trusted from the client** — prevents one agent from placing calls as another extension.
- Old unauthenticated `index.html` now just redirects to `/login.html`.

### 2. Real agent status tracking (not just a cosmetic UI toggle)
New `agent_status_log` table (user_id, status: available/break/acw, reason, started_at, ended_at). This is what actually drives the dashboard tiles:
- **Login Time**: since first status row logged today
- **Talk Time**: real, computed from `calls` table (`SUM(answer_time → end_time)` for today)
- **Break Time** / **ACW Time**: summed from `agent_status_log` for today
- **Handle Time**: Talk + ACW

**Automatic ACW**: when a call's `StasisEnd` fires (in the same ARI handler from Phase 3), the agent is automatically moved into `acw` status — matches real contact-center behavior (agent wraps up notes, then manually clicks back to Available). No extra dialplan/ARI work needed, just hooked into the existing event handler.

**Bug found and fixed**: `mysql2` returns `SUM()`/`COALESCE()` aggregate results as **strings**, not numbers. First version of `/agent/stats` silently produced `handleSeconds: "00"` (string concatenation of `"0"+"0"`, not numeric addition `0+0`). Fixed by explicitly `Number(...)`-converting every aggregate before doing arithmetic on it. **Lesson for future MySQL work**: never assume a query result is already a JS number — check, especially anything from `SUM`/`COUNT`/`AVG`.

### 3. Visual design pass
First version was functionally correct but visually plain (flat colors, no icons, no depth) — user feedback was direct: "not that much good to see." Redid it with: Inter font (Google Fonts), inline SVG icons on every stat tile and button (no icon library dependency), a dark gradient top bar, card elevation via subtle box-shadows, a pulsing animated dot for "Available" status, gradient buttons, and hover/transition micro-interactions throughout. Landed well on the second pass.

**Still to do**: Admin panel needs the same visual treatment (currently still the plain first-pass style from Phase 3/frontend-v1).

---

## Frontend v2 — Admin panel redesign + real-time monitoring (COMPLETE ✅ 2026-09-25)

Goal: bring the admin panel up to the same visual standard as the redesigned agent panel, and add the "Live Agents" real-time monitoring view that was still missing — the admin-side equivalent of the reference product's supervisor dashboard, built with our own layout (left sidebar nav instead of their top-bar/table structure).

### 1. Two new backend endpoints
- `GET /admin/dashboard` (`requireRole('admin')`) — four numbers computed server-side: `totalAgents` (COUNT of role='agent' users), `availableNow` (COUNT of open `agent_status_log` rows with status='available'), `callsToday` (COUNT of `calls` with `DATE(start_time) = CURDATE()`), `avgHandleSeconds` (AVG of `TIMESTAMPDIFF(SECOND, answer_time, end_time)` for today's answered+ended calls). Applied the same `Number(...)` wrapping lesson from `/agent/stats` before rounding.
- `GET /admin/live-agents` (`requireRole('admin')`) — one query joining `users` + `extensions` + the agent's currently-open `agent_status_log` row (`ended_at IS NULL`), plus a correlated subquery pulling the destination number of any call still open (`end_time IS NULL`) on that agent's extension. Returns `status: null` for an agent with no open status row (i.e. not logged in right now) — the frontend renders that as "Offline".

Both verified via authenticated curl (cookie-jar login as `admin`) before touching the frontend — confirmed real data: 2 total agents, 2 calls logged today, correct per-agent offline state when neither test agent was actively logged in.

### 2. Admin panel rewrite (`backend/public/admin.html`)
Restructured from a single flat page into a **left sidebar + SPA-style section switcher** (four sections: Dashboard, Live Agents, Users, Call Log) — same Inter font / CSS custom properties / card-shadow / gradient visual language as the agent panel, but a distinct layout (sidebar nav, not a top bar + side panel) since the admin's job is different (navigating between management views, not working one live call queue).

- **Dashboard**: 4 stat tiles (Total Agents, Available Now, Calls Today, Avg Handle Time), polling `/admin/dashboard` every 10s.
- **Live Agents**: table with a color-coded status badge per agent (green=Available, amber=Break + reason, orange=ACW, gray=Offline), time-since-status-change, and active call destination number if currently on a call. Polls `/admin/live-agents` every 5s, **only while that section is visible** (interval is started/cleared on nav switch, not left running in the background across all sections — avoids unnecessary load).
- **Users**: existing create-user form + users table, restyled (role shown as a colored pill).
- **Call Log**: existing all-calls table, restyled.

No backend restart was needed to ship the new `admin.html` — it's a static file served via `express.static`, so pushing it over SSH and hard-refreshing the browser was sufficient. The backend restart was only needed once, earlier, to load the two new routes.

**Verified working end-to-end and confirmed by user** ("tested, its okay for now").

---

## Phase 2 — Real SIP trunk to Tata Communications via nxtra (COMPLETE ✅ 2026-09-30)

Goal: stop waiting on a direct telco relationship and instead connect through a reseller ("nxtra," who runs a local server already carrying a live Tata Communications SIP trunk called `tatasip`) — get a real PSTN call flowing through our own Asterisk box, in both directions.

### 1. Architecture decided
Rather than our AWS Asterisk talking to Tata directly (their SBC endpoint `10.79.215.70` is on a private/internal IP, only reachable from inside nxtra's own network), we only need to reach **nxtra's box** (`152.52.42.148`, public). nxtra relays calls onward through their already-working `tatasip` trunk. One hop for us, not two.

Direction of registration: **nxtra's Asterisk registers to us** (mirrors a pattern already proven working on another of their client boxes, which they showed us as a `chan_sip` reference config — `type=friend`, `host=dynamic`). We generated **fresh, dedicated credentials** for this box rather than reusing the reference ones (those were live on someone else's server — reusing them risked kicking that trunk offline, since registration-based trunks generally allow only one active registration per credential set).

### 2. AWS-side PJSIP config (converted from their chan_sip reference to native PJSIP)
- New `[transport-udp]` transport, `0.0.0.0:5060`, same `external_media_address`/`external_signaling_address`/`local_net` NAT mapping already used by the WebRTC `wss` transport (Phase 0).
- New endpoint `dialforge-nxtra1` — `auth`+`aor`+`endpoint` triplet (same reused-section-name pattern as `1001`/`1002`), codecs `ulaw,alaw` (no opus — this is a real PSTN-facing trunk), `direct_media=no`, `rtp_symmetric`/`force_rport` for NAT (the PJSIP equivalents of chan_sip's `canreinvite=no`/`nat=force_rport,comedia`), `from_domain=3.7.241.104` (added after catching our own private IP leaking into the SIP `From` header — see bug list below).
- New dialplan context `[aws-server]` — currently a minimal connectivity-test stub (answer, play `hello-world`, hangup) for **inbound** calls arriving via this trunk. Real ARI routing for inbound PSTN calls is still a to-do (tracked in STATUS.md).

### 3. Security group tightening
Added inbound UDP 5060 restricted to nxtra's IP (`152.52.42.148/32`) — deliberately not "Anywhere" like the earlier TCP-5060 placeholder rule, since this is now a real, credentialed, internet-facing trunk.

### 4. Four real bugs found and fixed, in order — a genuinely instructive debugging chain

1. **Nothing reaching us at all** — turned out the AWS security group's UDP 5060 rule either didn't exist yet or was scoped wrong. Diagnosed conclusively by turning on Asterisk's own `pjsip set logger on` and watching for a full 150+ seconds (longer than nxtra's stated 120s retry interval): literally zero packets arrived, while `ufw status` showed `inactive` (ruling out an OS-level firewall). Once the security group rule was actually added/corrected, OPTIONS keepalive traffic started arriving immediately — proof the fix was exactly that rule, nothing else.
2. **REGISTER reached us but got no response at all** (`sip show registry` on nxtra's side stuck on "Request Sent") — a stale registration attempt that needed a fresh trigger (`sip reload`, then eventually `module reload chan_sip.so`) rather than passively waiting; chan_sip doesn't always retry promptly once stuck.
3. **REGISTER authenticated successfully but still failed** — response was `404 Not Found`, with Asterisk logging `WARNING: AOR 'dialforge-nxtra1' not found for endpoint 'dialforge-nxtra1'`, despite the AOR clearly being present and correctly written in `pjsip.conf`. Confirmed via `pjsip show aors` — the object genuinely wasn't loaded into the running config at all (not a caching artifact — survived both `module reload res_pjsip_registrar.so`-equivalent cycling *and* a full `systemctl restart asterisk`). **Root cause, found by process of elimination**: object *ordering* within the file. The working `1001`/`1002` endpoints always define `type=endpoint` **first**, then `auth`, then `aor`. The trunk's stanza had been written `auth` → `aor` → `endpoint`. Reordering to match the proven pattern (endpoint first) fixed it immediately — confirmed via `pjsip show aors` listing it and `pjsip show endpoint` showing its `Aor:` line. **Lesson**: this Asterisk build's `pjsip.conf` parser is not as order-independent as documented/expected for same-named multi-type object stanzas — always mirror a known-working object's internal ordering when adding a new one, rather than assuming any order works.
4. **Outbound test call reached nxtra fine (`100 Trying`) but got `403 Forbidden`** — two things stacked here: (a) our outbound INVITE's `From` header was leaking our EC2 instance's *private* IP (`172.31.10.157`) instead of the public Elastic IP, because `external_signaling_address` rewrites `Contact`/`Via` but not the `From` URI domain — fixed by adding `from_domain=3.7.241.104` explicitly to the endpoint (good practice regardless, but not the actual cause of the 403). (b) The real cause: our outbound calls were going out **without any CallerID at all** (`"Anonymous" <sip:anonymous@anonymous.invalid>`), which Tata's SBC — like most Indian carrier trunks — flatly rejects as a compliance/anti-spoofing measure. Fixed by stamping a specific allocated DID (`8065098690`) via `Set(CALLERID(num)=...)` before the `Dial()`, both in our own outbound test context and (more importantly) in nxtra's `[aws-dialforge]` context that forwards our calls to `tatasip`, so the CLI is enforced consistently regardless of what arrives on the inbound leg. Added `${SIP_CAUSE(tatasip)}` logging to that context too, to get Tata's actual rejection reason directly in nxtra's log without needing separate packet captures — this would have shortened the diagnosis considerably had it been there from the start.

### 5. First real PSTN call — confirmed 2026-09-30
Outbound test call from our AWS box (`channel originate Local/9003220102@nxtra-outbound application Wait 15`, CLI `8065098690`) rang the destination mobile and was **answered** — SIP trace showed `100 Trying` → `183 Session Progress` → `200 OK`, clean call teardown after. Confirmed by the person who answered it. This is the whole point of Phase 2: a real call, over a real carrier trunk, through our own from-scratch Asterisk box.

**What's still open** (tracked in STATUS.md, not forgotten): wiring this trunk into actual application code (`click2call`'s dial string still targets test extensions only, not `PJSIP/{number}@dialforge-nxtra1`), routing real inbound calls into the ARI `dialforge-app` instead of the current answer-and-play-a-sound stub, and re-adding `qualify_frequency` to the trunk AOR for ongoing registration-health monitoring (dropped mid-troubleshooting while isolating the AOR-ordering bug, never re-added).

---

## Phase 6 — Embedded WebRTC softphone in the agent panel (COMPLETE ✅ 2026-09-30)

Goal: stop requiring a separate browser tab (the Phase 0 `test.html` page) just to register a SIP extension before click2call would work — bring that registration directly into the agent panel, matching how real contact-center software works (you pick your extension/campaign for the shift, right after logging in).

### 1. Click2call wired to the real trunk first
Before touching the frontend, `POST /calls/click2call`'s destination-leg logic was updated: `resolveDestination(toNumber)` checks the `extensions` table first — if `toNumber` matches one of our own test extensions, dial it directly (`PJSIP/{number}`); otherwise route through the live Phase 2 trunk (`PJSIP/{number}@dialforge-nxtra1`), stamping the authorized CLI (`8065098690`) since the trunk requires a real CallerID. Verified via the DB's `call_events` trail that internal-extension calls complete end-to-end (`originated → agent_answered → dest_answered → bridged → ended`).

### 2. "Connect Your Line" step added to the agent panel
New overlay shown immediately after login, before the dashboard: an extension number field (pre-filled from the agent's assigned extension, but editable — which extension you use is a per-shift device choice, not fixed to your login account) and a campaign dropdown (cosmetic placeholder for now — real campaign/dialer configuration is still a later phase, not built yet). A "Connect" button registers a JsSIP `UA` using the exact same working config from the Phase 0 test page (same ICE servers, same WSS endpoint) — reused deliberately rather than re-derived, since that config was already hard-won.

**New backend support needed**: agents don't know (and shouldn't need to know) the raw SIP password for whichever extension they pick. Added a `sip_password` column to the `extensions` table (migration `migration-extension-sip-password.sql`) and a scoped endpoint, `GET /agent/extension-credentials/:extension` (any logged-in user), that hands back the SIP password for a given extension name so the browser can register without the human ever seeing or typing it.

Incoming calls (i.e. click2call ringing this exact browser tab as the agent leg) auto-answer immediately via JsSIP's `newRTCSession` handler when `data.originator === 'remote'` — the agent already chose to place the call, so there's no reason to require a second manual accept click. Added a **Hang up** button in the top bar (only visible once a session exists) wired to `session.terminate()` — this was missing entirely before; there was previously no way to end a call from the UI at all.

### 3. Real bug found: HTTPS wasn't cosmetic, it was load-bearing
After deploying the above, testing showed calls only ever worked when registering via the old `test.html` page — the new in-panel "Connect Your Line" flow appeared to do nothing useful, with no visible error. **Root cause**: the agent/admin panels were served over plain HTTP (`http://3.7.241.104:3000/...`), and every modern browser blocks `getUserMedia` (microphone access, which JsSIP needs to register *and* to answer/place any call) on a page that isn't a secure context. `test.html` worked because Asterisk serves it over HTTPS (`https://dialforge.ddnsfree.com:8089/...`) — a completely different code path than what looked at first like a registration bug in the new UI.

**Fix**: gave the Node backend real HTTPS, using the same Let's Encrypt certificate everything else already uses.
- Copied `fullchain.pem`/`privkey.pem` to a location the `ubuntu` user (who the Node process runs as) can actually read — the live cert files are root-only by default, same permissions gotcha hit back in Phase 0 for Asterisk, solved the same proven way.
- Added a new certbot renewal deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/node-cert-copy.sh`, mirroring the existing Asterisk one) that re-copies the cert and restarts the Node backend on every future renewal — a manual one-time copy would have silently gone stale at the next 90-day renewal, same lesson as always: anything that needs redoing automatically has to be encoded somewhere that runs automatically, not done by hand once.
- `server.js` now uses Node's built-in `https` module wrapping the existing Express `app`, instead of plain `app.listen()`.
- Also flipped the session cookie to `secure: true`, since there's no longer a reason not to.

**Consequence worth remembering**: the agent/admin panel URLs changed from `http://3.7.241.104:3000/...` to `https://dialforge.ddnsfree.com:3000/...` — the raw IP no longer works cleanly since the certificate is only valid for the hostname (identical rule to the one learned for the WebRTC test page back in Phase 0, just hitting a second, independent part of the stack this time).

---

## Phase 7 — Node backend as a real systemd service (COMPLETE ✅ 2026-09-30)

Goal: stop hand-launching the backend with `nohup` after every reboot/crash — same reasoning as why Asterisk got this treatment back in Phase 0.

Unit at `/etc/systemd/system/dialforge-backend.service`:
```ini
[Unit]
Description=DialForge Node.js backend
After=network.target mysql.service asterisk.service
Wants=mysql.service asterisk.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/dialforge-backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/home/ubuntu/dialforge-backend/server.log
StandardError=append:/home/ubuntu/dialforge-backend/server.log

[Install]
WantedBy=multi-user.target
```
Runs as the existing unprivileged `ubuntu` user (no dedicated system user needed — it was already non-root, and port 3000 doesn't need any special bind capability like Asterisk's SIP ports do).

Enabled via `systemctl enable --now dialforge-backend`. **Verified both halves of the point of doing this**, not just that it started once:
- Boot persistence: `enabled` in `systemctl status`.
- Crash recovery: `kill -9` on the running node process → systemd relaunched it with a new PID within ~2 seconds, `/health` responded normally right after.

**Still open**: the bot service (`bot-service/`) hasn't gotten the same treatment yet — still manual `nohup`. Same fix, just not done yet.

---

## Phase 8 — Inbound call routing, campaigns/queues, and a real bug hunt (COMPLETE ✅ 2026-09-30)

Goal: get a real inbound PSTN call ringing into an agent's browser, wire click2call to the live trunk, and give agents a real queue-selection step before going Available (replacing the earlier cosmetic campaign dropdown).

### 1. click2call wired to the real trunk
`resolveDestination(toNumber)` checks the `extensions` table first — matches one of our own test extensions → dial directly; otherwise → route through the Phase 2 trunk (`PJSIP/{number}@dialforge-nxtra1`) with the authorized CLI stamped.

### 2. Inbound call routing built
New `[aws-server]` dialplan just does `Stasis(dialforge-app, inbound, ${CALLERID(num)})` - all real logic moved into our own ARI code, matching this project's whole approach (Asterisk stays thin, our code decides). On `StasisStart` with tag `inbound`: query for the longest-idle `available` agent, originate their extension, and reuse the *exact same* "agent leg answered" code path click2call already uses - the only branch is whether a destination channel already exists (inbound: caller's channel is already there, just answer+bridge it) or needs originating fresh (outbound click2call).

### 3. Real bug: hanging up one leg didn't hang up the other
ARI-controlled bridges don't auto-hangup the other party when one leg leaves - that's left entirely to application code, and ours never did it. Fixed by explicitly hanging up the other leg + destroying the bridge on `StasisEnd`. Added `ari.destroyBridge()` to the hand-rolled ARI client for this.

### 4. Real bug: a race condition from bug #3's own fix
Hanging up the other leg (step 3) triggers a *second* `StasisEnd` almost instantly for that leg. Since `activeCalls.delete(callId)` happened only *after* several `await`s (hangup, destroy bridge, two DB queries), both events could process the same call-end concurrently - observed as duplicate `agent_status_log` rows with identical timestamps, and once as the agent ending up with **no open status row at all** (silently breaking inbound routing, since the agent no longer looked "available" to anyone). Fixed by moving `activeCalls.delete(callId)` to fire synchronously, before any `await`, the moment a matching call is found - closes the race window completely.

### 5. Embedded WebRTC softphone + HTTPS (see also Phase 6 entry above)
Agent panel now registers its own JsSIP softphone in-page ("Connect Your Line"), added a real **incoming-call popup** (Accept/Reject) distinguishing a genuine unsolicited call from the agent's own click2call leg (tracked via a client-side `expectingOwnCallLeg` flag, since both arrive as an identical-looking incoming INVITE) - the earlier version auto-answered everything, which was fine for click2call but wrong for a real customer call.

### 6. Campaigns and queues - a real system, not a cosmetic dropdown
New `campaigns` and `queues` tables (`migration-campaigns-queues.sql`), `queue_id` added to `agent_status_log` so we know which queue an agent worked during any given Available stretch. Admin panel gained a full Campaigns section (create campaign → add queues under it). Agent panel: login no longer auto-sets Available (it used to - removed, since going Available now requires picking a queue first); clicking Available opens a queue-selection popup pulling the live list from the admin-managed queues, remembered for the rest of the session so later Break→Available cycles don't re-prompt.

Reviewed the reference screenshots specifically for their Queue Management screen (Configurations → Queues: Queue Name / Ringing Strategy / WaitTimeOut) and Active Agents live view (has a Queue column) - adopted **Ringing Strategy** (`ringall`/`random`/`leastrecent`/`fewestcalls`) and **Wait Timeout** as real fields on our `queues` table and Admin UI (`migration-queue-ring-strategy.sql`), and added a Queue column to our own Live Agents table. Deliberately did **not** copy their Campaign fields (Industry/Domain/Buffer Level/Dial Ratio) - those are predictive-dialer-specific settings with no corresponding logic in DialForge yet, and adding fields that do nothing isn't a real feature.

**Scoped out for now, flagged to revisit**: inbound routing still picks *any* available agent globally - it doesn't yet route a specific incoming DID to a specific queue/campaign (that needs a DID→campaign mapping we haven't designed), and ring-strategy/wait-timeout are stored but not yet wired into actual multi-agent ring behavior (today's routing only ever considers one agent at a time, not a true ring group).

### 6b. Restructured to match how the reference product actually models this, plus real Auto Answer wiring
After the initial build, the user shared more detailed reference screenshots (the reference product's actual "Update Campaign" and "Update Queue" modals, not just the list views seen before). These revealed the real relationship is the *opposite* of what was first built: **Queue is a standalone, reusable entity** (its own Ring Strategy/Wait Timeout/Announce/Retry/Timeout Restart config, managed independently), and a **Campaign references one queue** via a dropdown, plus has its own Outbound Caller ID and Auto Answer setting. The original build had queues nested *under* campaigns (`campaign_id` FK on `queues`) - backwards. Migrated (`migration-queue-campaign-restructure.sql`): dropped that FK, added `queue_id`/`outbound_caller_id`/`auto_answer` to `campaigns` instead, and `announce`/`retry`/`timeout_restart` to `queues`.

Deliberately did **not** copy the rest of the reference product's Campaign fields (Industry, Domain, Template, Did Rotate Strategy, Primary List, Process, Dial Status/Dispo Status, Script, On Demand Recording, Call Masking, DNC check, Auto Dispo, Timezone, Dial Prefix, Wrap Time) - all predictive-dialer/CRM/compliance features with zero corresponding logic in DialForge today. Adding them as inert dropdowns would look like progress without being real.

**Auto Answer actually wired in, not just stored**: added `campaign_id`/`auto_answer` columns to `calls` too. When routing an inbound call, the answering agent's *current queue* determines which campaign it belongs to (the campaign that references that queue) - this also resolves the campaign's `auto_answer` flag, stamped onto the call row. New endpoint `GET /agent/call-policy` lets the browser check this the moment a real inbound call starts ringing; the agent panel's `newRTCSession` handler now calls it before deciding whether to auto-answer silently or show the Accept/Reject popup (previously the popup showed unconditionally for any non-click2call ring). This is the first case where the queue-agent selected actually changes real call behavior, not just displays a name.

### 6c. Made queues real in Asterisk, not just a database label
User feedback, verbatim: "created queue should show in asterisk in queue show and in that login and selected queue member should be in that queue, i want the queue logic to be proper." Fair - up to this point "queue" was purely our own DB concept; Asterisk had no idea any of this existed.

**AMI (Asterisk Manager Interface) set up** - the standard way to manage queue membership programmatically (ARI has no equivalent for this; queues are an AMI/CLI-era Asterisk feature). `manager.conf`: `enabled=yes`, `bindaddr=127.0.0.1` (localhost-only, never exposed - same security posture as ARI's own credentials), new `dialforge` manager user. Added `ubuntu` to the `asterisk` group and made `/etc/asterisk/queues.conf` group-writable, so the Node backend can edit it directly without needing sudo/root (same non-root-but-capable pattern already used for the Let's Encrypt cert copy). Hand-rolled a minimal AMI client (`ami.js`) over Node's raw `net` module - same philosophy as `ari.js`: AMI is a simple line-based text protocol, not worth a dependency for.

**Queue creation now does two things**: inserts the DB row (unchanged) *and* appends a real `[asterisk_name]` stanza to `queues.conf` (strategy/timeout/retry/timeoutrestart/announce-frequency mapped from our stored fields) followed by an AMI `QueueReload` action - no Asterisk restart needed. `asterisk_name` is a slugified, config-safe version of the human-readable queue name (e.g. "Real Test Queue" → `real_test_queue`), stored alongside it so AMI actions and the config file always agree on the exact identifier.

**Real membership, driven entirely by the existing status-transition code path** (`setAgentStatus`) - no new UI needed, since this hooks into the same "Available/Break/ACW" flow that already existed:
- **Available** (with a queue picked) → AMI `QueueAdd` (idempotent - tolerates already being a member) then `QueuePause(false)`.
- **Break / ACW** → AMI `QueuePause(true)` on whichever queue they're nominally working (looked up via their most recent status row that had a `queue_id`, since break/acw don't carry one themselves).
- **Logout** → AMI `QueueRemove` - leaves the queue entirely, not just paused.

**Verified all three transitions directly against `asterisk -rx "queue show <name>"`**, not just trusting the AMI calls succeeded: Available → member appears, unpaused; Break → same member shows `(paused was N secs ago)`; Logout → `No Members`. All exactly as expected.

**Deliberately not done yet, flagged clearly**: inbound call *delivery* still uses our own simplified SQL "longest-idle available agent" query, not Asterisk's native `Queue()` dialplan app actually ringing the real members we're now tracking. Real membership was the correctly-scoped fix for what was asked ("queue show" + "member should be in that queue") without risking the already-tested click2call/hangup/ACW flow by swapping the call-delivery mechanism itself - that's a separate, bigger decision (whether to move to `Queue()` app natively, and how that interacts with our ARI-driven auto-answer/popup logic) worth its own explicit go-ahead before touching.

### 6d. Real bug found while testing the above: login extension vs. connected extension could silently diverge
User caught this immediately: connected the browser as extension `1002` (deliberately different from their login account `agent1001`'s assigned extension `1001`, exercising the "pick your device for this shift" design from Phase 6), and the new queue membership showed up for the wrong interface entirely - `PJSIP/1001`, not `1002`. The topbar's `ext 1001` label was also stale.

**Root cause**: every piece of downstream logic (queue sync, click2call's `fromExtension` enforcement, `/agent/stats`, live-agents display) reads `req.session.user.extensionName` - which was only ever set once, at login, from the account's assigned extension. The Connect screen lets an agent register with a *different* extension, but nothing updated the session to match, so everything downstream kept acting on the login-assigned one regardless of what was actually registered in the browser.

**Fix**: `GET /agent/extension-credentials/:extension` - the exact moment an agent commits to an extension by fetching its SIP password to register - now also updates `req.session.user.extensionName` (and `extensionId`) to that extension. Verified via curl: session's `extensionName` correctly flips from `1001` to `1002` after that call, and the subsequent queue-membership AMI call now targets `PJSIP/1002`, confirmed against `queue show` (also showing "Not in use" instead of "Unavailable" this time, correctly reflecting that 1002 - not 1001 - was the one actually registered). Also fixed the topbar label client-side to update immediately on successful registration instead of showing the stale login-time value.

### 6e. Real inbound call crashed on a stale "available" agent - fixed with a genuine reachability check
A real test call hit this exactly: our SQL picked extension `1001` as "available" (a leftover status row from earlier testing - nobody was actually registered there), and `ari.originate({endpoint: 'PJSIP/1001', ...})` failed hard: `Could not create dialog to invalid URI '1001'. Is endpoint registered and reachable?` - the caller got a dead ring, then a CANCEL. User's framing was exactly right: "need to route the call to the queue" - our own DB's "available" flag can go stale (a dropped browser tab doesn't tell anyone), while Asterisk's own device-state tracking always reflects reality.

**Fix, scoped deliberately**: rather than a full rewrite onto Asterisk's native `Queue()` dialplan app (which would mean giving up our own `calls`/`call_events` DB tracking and the just-built Auto Answer logic, unless also wiring AMI queue-event listening to bridge that gap - a bigger, separate decision), added a real reachability check using ARI itself: `GET /ari/endpoints/PJSIP/{name}` returns a `state` field ("online"/"offline") reflecting actual registration - added `ari.isEndpointOnline()` for this. The inbound-call handler now pulls *all* candidate available agents (longest-idle first, same as before) and iterates until it finds one that's genuinely online, instead of trusting the first DB row blindly. Verified directly: curled the ARI endpoint resource for both test extensions mid-session - `1001` correctly showed `"state":"offline"` (matching the crash), `1002` showed `"state":"online"` - confirming the fix will correctly skip the former and pick the latter.

**Still the bigger, undecided step**: moving inbound delivery to Asterisk's native `Queue()` app entirely (real hold music, real multi-agent ring-cascade using the ring-strategy we already store) - flagged again, not silently dropped, but deliberately not bundled into this fix given the trade-offs it carries.

### 6f. The bigger step, done: full native Queue() integration
User's call: "yes, build the full native queue integration." This is the real architectural shift - inbound calls now actually enter Asterisk's own `Queue()` app instead of us picking one agent and originating them directly.

**The key design realization that avoided a much bigger rewrite**: Auto Answer doesn't need to correlate to a specific call via AMI events at all - it's a property of the *campaign/queue*, resolved from whichever queue the agent asking is currently in (a lookup we already had, `findCurrentQueueAsteriskName`). So `/agent/call-policy` was simplified to resolve it that way instead of matching a specific `calls` row by `from_extension` - which removes a real race condition (the row might not have `from_extension` populated yet when the browser asks, since Asterisk's own queue engine - not us - decides who's ringing).

**Mechanics**:
- `[queue-dispatch]` dialplan context: `Queue(${QUEUENAME})`, nothing else.
- `ari.setChannelVar()` and `ari.continueInDialplan()` added - the latter is how a channel exits our Stasis app and hands control back to plain dialplan (`POST /channels/{id}/continue`).
- On inbound `StasisStart`: resolve the first active campaign that references an active queue (same "no DID-mapping yet" placeholder as before, now picking a *queue* instead of a single agent), insert a `calls` row with `from_extension` left `NULL` (nobody chosen yet - a schema change, `from_extension` is now nullable), set `QUEUENAME` and hand off via `continueInDialplan`.
- **`ami.js` extended to emit unsolicited events**, not just handle request/response actions (`ami.on('AgentConnect', handler)` etc.) - needed because once a call is handed to `Queue()`, Stasis stops receiving any further events for that channel; AMI events are the only way left to know what happened.
- A `Map<channelName, callId>` correlates AMI's channel-name-keyed events back to our own `calls.id`.
- `AgentConnect` → backfills `from_extension` + `answer_time` on the call row.
- `AgentComplete` → sets `end_time`/`disposition='ended'`, triggers the same auto-ACW transition click2call already has.
- `QueueCallerAbandon` → sets `disposition='abandoned'` if the caller hangs up before anyone answers.

**Verified with a genuinely useful self-test technique** (no need to wait on a real nxtra-triggered call each time): `channel originate Local/<DID>@aws-server application Wait 30` on the box itself exercises the exact same `[aws-server]` → Stasis → Queue() path a real inbound call takes. First run: confirmed `PJSIP/1002` really rang via native Queue() (`core show channels` showed `AppQueue`, `queue show` showed the caller waiting and the member "Ringing"), and the DB correctly recorded `queued → agent_answered (from_extension backfilled to 1002) → ended`, with `campaign_id`/`auto_answer` correctly stamped at insert time.

**One more real bug this surfaced, fixed immediately**: two pre-existing queues (created via curl testing *before* the AMI/queues.conf integration existed) had `asterisk_name = NULL` and were never actually written to `queues.conf` - they only ever existed as DB rows. Our inbound routing picked one of these first (lowest campaign id), and `AMI QueueAdd`/`Queue()` failed with "No such queue" against a name that was never real. Backfilled `asterisk_name` for the affected rows (slugified from their existing `name`) and retroactively appended their `queues.conf` stanzas from their already-stored settings - a one-time fix for pre-integration test data, not a recurring gap (every queue created *after* the integration went live writes its config correctly at creation time).

**Second real bug found via the same test, fixed immediately**: the ACW auto-transition (both the original click2call path and the new AMI `AgentComplete` handler) resolved "which agent just finished this call" via `users.extension_id` - the *login account's assigned* extension - and moved the wrong user into ACW when the actual connected agent was using a different extension (the same class of bug as 6d, resurfacing in a second code path). Added an `extension_name` column to `agent_status_log` (recording what was actually in use at the time of each status row, not the login-assigned one) and a `findAgentIdByExtension()` helper that resolves "who is on extension X *right now*" from that column instead of the static FK - used by both ACW-triggering code paths now.

### 6g. Third bug from the same test round: the status pill went stale after a server-initiated transition
User's report was precise: agent panel showed "Available," but `queue show` had the real member still `(paused)` with a caller stuck waiting in queue. Both sides were individually correct - the *backend* correctly auto-transitions an agent to ACW (and correctly pauses them in the real queue) the moment a call ends via the AMI `AgentComplete` handler - but that transition is entirely server-initiated, and nothing ever told the *browser* it happened. The status pill only ever updated when the agent manually clicked something, so it just kept showing whatever was last clicked, silently disagreeing with reality.

**Fix**: `/agent/stats` (already polled every 5s for the dashboard tiles) now also returns the agent's actual current status/reason/queue name, and the poll handler feeds it through the same `renderStatusPill()` function used for the agent's own manual clicks - one source of truth for what the pill should show, whether the change came from the human or from the server. Worst-case staleness is now bounded to one poll interval (~5s) instead of indefinite.

## Phase 9 — DID-to-campaign mapping (COMPLETE ✅ 2026-09-30)

Goal: close the gap flagged repeatedly through Phase 8 - inbound routing was picking "whichever active campaign happens to have the lowest id," completely ignoring which number was actually dialed. Fine with exactly one live campaign; would silently misroute the moment a second one existed.

**Real fix, not just a data model exercise**: the dialed DID was available in the dialplan the whole time (`${EXTEN}` in `[aws-server]`, since Tata delivers it as the Request-URI) but was never actually passed through to our own code - `Stasis(dialforge-app,inbound,${CALLERID(num)})` only ever forwarded the *caller's* number. Added it as a second arg: `Stasis(dialforge-app,inbound,${CALLERID(num)},${EXTEN})`.

New `dids` table (`number` → `campaign_id`, nullable so a DID can exist unassigned). Inbound routing now looks up the dialed number there *first*; only falls back to the old "first active campaign" placeholder if genuinely unmapped - and that fallback now logs a loud, actionable warning (`[DID routing] "X" has no campaign mapping - falling back to campaign N. Add it under Admin > Campaigns > DID Numbers.`) instead of silently misrouting, so a missing mapping is discoverable instead of a mystery.

Admin panel gained a "DID Numbers" card (number + campaign assignment, upsert - reassigning an existing DID's campaign is just POSTing it again). Backfilled our one real, currently-live DID (`8065098690`) to the campaign it was already routing to in practice ("Support Inbound").

**Verified both paths directly** with the same CLI self-test technique as Phase 8: dialing the mapped DID produced `"didMatched": true` in the `queued` call_event; dialing an unmapped number produced `"didMatched": false` *and* the expected warning in the log, confirming the fallback engages correctly rather than crashing or hanging the caller.

---

## Phase 10 — Outbound campaigns (COMPLETE ✅ 2026-09-30)

Goal: bring outbound dialing up to the same campaign-awareness as inbound - leads were a single flat global list with no connection to the campaign/queue infrastructure just built, and click2call always used one hardcoded global CLI regardless of which campaign an agent was actually working.

**Scoped deliberately** to what has real logic behind it - manual/preview dialing (agent looks at a lead, clicks Call, sets a real outcome after) rather than a predictive-dialer pacing engine, which is a much bigger, separate undertaking.

### 1. Leads are campaign-scoped now
`leads.campaign_id` added. New leads are stamped with whichever campaign the creating agent is currently working (same `findCurrentCampaign()` resolution already used for Auto Answer - one hop further than `findCurrentQueueAsteriskName()`). `GET /leads` for an agent now only returns their current campaign's leads; admin still sees everything.

### 2. Per-campaign outbound CLI actually wired in
`campaigns.outbound_caller_id` existed in the schema since Phase 8 but nothing ever read it - click2call always used the one global `TRUNK_CALLER_ID` constant. `resolveDestination()` now accepts an override, resolved from the calling agent's current campaign at the point of actually dialing out. Not live-fire verified with a distinguishing value (our one real campaign's CLI happens to equal the global default, so a real call wouldn't prove which path fired, and testing with a mismatched/unauthorized CLI against the real carrier trunk isn't worth the risk) - confirmed correct by direct code review instead, flagged here honestly rather than overclaiming.

### 3. Real disposition workflow, with actual DNC enforcement
Six outcomes: New, Interested, Not Interested, Callback, No Answer, Do Not Call (user's choice, standard set). `POST /leads/:id/disposition` updates the lead. Agent panel shows a real popup after an outbound call ends (hooked into the JsSIP session's own `ended` event, tracked via a client-side `activeLeadId` variable set right when the call was placed) - not just a cosmetic label.

**Do Not Call is enforced, not decorative**: `click2call` checks the lead's status before ever originating a call and refuses with a 403 if it's marked `do_not_call`. Verified directly: disposed a test lead as `do_not_call`, then attempted to call it - got `{"error":"this lead is marked Do Not Call"}` instead of a call. UI also disables the Call button and shows the status inline for such leads, so an agent isn't even tempted to try.

### 4. Admin-side visibility, built as the next vertical slice (not a speculative admin-first pass)
Deliberate methodology note, since the user asked directly whether "build admin comprehensively, then come back to agent" was the right approach: no - every admin feature in this project has only been real because agent-side usage existed first to report on. Building admin broadly ahead of actual agent behavior risks the same thing already avoided earlier (copying reference-product fields with no logic behind them) - screens that look complete but don't reflect anything real. The right move is one vertical slice at a time: this lead/campaign visibility piece *is* the correct next admin addition, specifically because leads and dispositions now genuinely exist from the Phase 10 work above.

Admin's `GET /leads` now joins campaign name directly (`LEFT JOIN campaigns` - `NULL` for the handful of pre-campaign-scoping legacy leads, which is the accurate representation, not a bug). New "Leads" card in the admin Campaigns section shows every lead with its campaign and disposition. Verified via curl: campaign-scoped leads correctly show their campaign name; legacy leads correctly show `null`.

---

## Phase 11 — Reports (COMPLETE ✅ 2026-10-01)

Context: the user shared a large, comprehensive spec for a full "Predictive Dialer Admin Panel" (React, Redis, RDS, barge/whisper/listen, full RBAC, system health monitoring, audit logs, the works) and explicitly asked to be told the real challenges/conflicts *before* anything got built. Answered honestly: that spec assumes a different stack than what exists (React vs our vanilla JS, RDS vs our local MySQL, Redis which doesn't exist in this project at all), and its very first line - "Predictive Dialer" - directly reverses the manual/preview-dialing scope decision made together in Phase 10. Flagged predictive dialing specifically as a multi-week undertaking with real regulatory stakes (abandon-rate compliance), not a UI line item. Recommended picking real pieces one at a time rather than treating the spec as a single build.

User then asked directly whether "build admin comprehensively first, then agent panel" was the right general approach. Answered no, for the same reason noted in Phase 10 Part 4: every admin feature so far has only been real because agent-side behavior existed first to report on. Reports was the piece picked from the spec - a clean fit, since it only reports on data that now genuinely exists (Phase 8-10's calls/leads/campaigns/agent-status work), not a speculative screen.

### Scoped to what's computable from real data
Four reports: Campaign, Agent, Call (filterable + CSV export), Hourly - matching the original spec's structure, but each number traced back to an actual column rather than invented. Notably did **not** attempt a Busy/Failed/No-Answer breakdown at the call level - that data genuinely doesn't exist yet (would need hangup-cause capture we haven't built), so "Answered" vs "Not Answered" vs "Abandoned" is the honest level of detail available today, not blurred into fake-precise categories.

### One more real bug-class caught before it happened: the Agent Report
Almost built the Agent Report the "obvious" wrong way - joining `calls.from_extension` to `users.extension_id` (the login-assigned extension). That's the *exact* bug fixed twice already this project (Phase 8 sections 6d/6f) - an agent's actual working extension can differ from their account's assigned one. Instead, the Agent Report joins `calls` to `agent_status_log` with a time-window condition (`ca.start_time` falls between that status row's `started_at`/`ended_at`), correctly attributing every call to whichever agent was *actually* on that extension at that moment - the proper fix, applied proactively this time instead of reactively.

### New tracking needed, added deliberately rather than faked
`leads.updated_by` didn't exist - there was no way to know which agent set a given disposition, so "Callbacks per agent" in the Agent Report would have been unanswerable. Added the column, wired it into `POST /leads/:id/disposition`, rather than omitting the metric or guessing at it.

### UI
New "Reports" admin section with four tabs (Campaign/Agent/Call/Hourly), date-range filters, a campaign/disposition filter on the Call report, and CSV export on every tab (shared `toCsv()` helper, `?format=csv` on each endpoint). Hourly report renders as a simple two-color (answered/missed) proportional bar per hour - plain CSS, no charting library, consistent with this project's standing preference for hand-rolled over added dependencies.

**Verified directly via curl** before any UI was built: all four endpoints return correctly-computed numbers against real data (e.g. Campaign report's answered+not_answered+abandoned summing to total_calls; Agent report's login/talk time in the right ballpark), and the CSV export format checked directly. Embedded admin.html JavaScript also syntax-checked with `node --check` before asking for visual confirmation, since screenshots aren't available in this environment.

### 7. Nxtra-side troubleshooting chain (their box, not ours - kept here for the full picture)
Getting one real inbound call through required, in order: (a) their AWS security-group-style IP allowlist fully open for our IP, (b) fixing a section-ordering bug in our own `pjsip.conf` that silently dropped the trunk's AOR object, (c) discovering their box runs a Vicidial-style inbound DID lookup (`AGI("lookup")` against a DID-configuration table) that had to be separately configured for our DID beyond just the dialplan, (d) a placement bug in their own dialplan (a new exact-match extension added to the wrong context - `[inbound]` instead of `[start]`, where the DID actually gets dialed after their `Goto()`), and (e) an auth bug where our own `dialforge-nxtra1` endpoint would authenticate their REGISTER fine but reject their INVITE with the identical credentials - fixed by adding a `type=identify` object matching their known static IP, which bypasses the fragile username/digest identification path entirely for a trusted, firewalled peer like theirs.

---

## Phase 12 — CSV Lead Import (COMPLETE ✅ 2026-10-01)

Another piece picked directly off the Predictive Dialer spec discussion (Phase 11 context) - low-conflict, no architecture mismatch, and it closes a real gap: until now every lead had to be added one at a time through the admin UI.

### Parsing done by hand, deliberately
Only one new dependency added: `multer` (`^2.4.0`, memory storage, 2MB limit) to receive the multipart upload itself. CSV *parsing* is a small hand-rolled `parseCsvLine()` rather than a second library, since correct quoted-field handling (embedded commas, escaped `""`) is about 20 lines - consistent with this project's standing preference for hand-rolled over added dependencies when the logic is simple enough to own outright.

Tested directly against a deliberately adversarial file before trusting it: a quoted field with an embedded comma (`"Smith, John"`), an escaped-quote name (`"Quoted ""Name"""`), an invalid phone (`abc123`), and a malformed single-column row. All four parsed/validated correctly, and the valid rows landed in MySQL with the exact expected text (`Smith, John`, `Quoted "Name"` - checked directly in the DB, not just trusted from the API response).

### Duplicate detection checks the database, not just the file
Two separate dedup passes: against phones already in that campaign's `leads` table, and against phones repeated within the same uploaded file. Verified by importing the same file twice - first pass: 3 imported, 2 invalid; second pass on the identical file: 0 imported, 3 duplicates, 2 invalid. Proves the dedup is checking real DB state, not just in-memory file content.

### Campaign-scoped, not global
Import requires a `campaignId` - leads land directly in the right campaign's pool, same as manually-added leads already do (Phase 10). No "import to no campaign" option, since unscoped leads aren't usable by any agent anyway.

### UI
"Import Leads" card plus the Leads table, originally added inside the Campaigns section, then pulled out into their own top-level **Leads** sidebar module right after - campaigns and leads are different concerns (one configures routing, the other is a day-to-day working list), and nesting leads inside Campaigns would only get more cramped as filtering/search is added later. Leads section has its own pagehead with a Refresh button (`showSection('leads', ...)` re-fetches the table on every visit, same pattern as Live Agents). Import button, campaign picker, and "Download Template" (`GET /admin/leads/csv-template` - a two-line example CSV with `name,phone` headers) all work exactly as before - only the DOM location moved, not the element IDs or logic, so `importLeadsCsv()`/`loadLeadsAdmin()`/the `#importCampaign` population in `loadCampaigns()` needed no changes. Backend endpoints verified directly via `curl` with real multipart uploads before any UI was written; both the original and the relocated UI were pushed and verified with an HTTP 200 check plus `node --check` on the extracted embedded script, same pattern as Phase 11.

### Queues split out the same way, same day
Followed immediately by the same request for Queues: "Create Queue" + the Queues table were likewise pulled out of Campaigns into their own top-level **Queues** module, placed before Campaigns in the sidebar since a queue has to exist before a campaign can reference one. Same approach as Leads - DOM location only, no ID/logic changes, so `createQueue()`/`loadQueues()` (which also populates the `#newCampaignQueue` dropdown over in Campaigns, unaffected by the move) needed no rework. `showSection()` now refreshes the Queues table on every visit, matching the Leads/Live Agents pattern. Campaigns section's pagehead copy updated since "Queues are reusable ring-groups..." no longer made sense once queues had their own page. Verified the same way: `node --check` on the extracted script, HTTP 200 on `admin.html`, and a direct grep for the new section/nav markers in the served page.

### DID Numbers split out the same way too
Same request a third time, same day: "Add DID" + the Numbers table pulled out of Campaigns into a new top-level **DID Numbers** module. By this point Campaigns is down to just Create Campaign + the Campaigns table - routing config (queues, DID mapping) and working-data screens (leads) have all separated out into their own modules, leaving Campaigns to just be what it says: campaign definitions. Identical mechanics each time: move the HTML, add a nav item + pagehead + refresh button, wire `showSection()` to reload that section's table on visit, verify `node --check` + HTTP 200 + a grep for the new markers before calling it done. `loadDids()`/`createDid()` untouched - still reads/writes the same `#newDidNumber`/`#newDidCampaign`/`#didsTable` IDs regardless of which section they live in.

---

## Phase 13 — Edit/Delete across Queues, Campaigns, DID Numbers, Leads (COMPLETE ✅ 2026-10-01)

Everything built since Phase 9 (Queues, Campaigns, DID Numbers, Leads) only ever had Create + List. The user asked for modify/delete across all four, and confirmed the delete-safety approach up front: block with a clear error naming what's in the way, rather than silently nulling out references.

### Leaned on real foreign keys instead of reinventing referential integrity
Checked the live schema first (`SHOW CREATE TABLE`) rather than assuming: `campaigns.queue_id → queues.id`, `dids.campaign_id → campaigns.id`, `leads.campaign_id → campaigns.id`, and `calls.lead_id`/`calls.campaign_id` are **real FK constraints**, already enforced at the DB level. Rather than relying on the raw FK error (which only names a constraint, not what's actually blocking the delete), each delete endpoint runs an explicit pre-check - e.g. deleting a queue queries `campaigns WHERE queue_id = ?` first and responds with "Cannot delete - still used by campaign(s): X" by name, not just a generic 409. Verified directly: deleting a queue in use by a campaign, a campaign with a mapped DID/leads/calls, and a lead with call history all correctly refused with specific messages naming what's attached; a campaign/queue/DID/lead with nothing attached deleted cleanly.

### Queue edit stays out of Asterisk's way on the one field that matters
Queue edit deliberately excludes the name - editing it would mean renaming `asterisk_name` everywhere it's already referenced (queues.conf's stanza header, any campaign pointing at it), not worth it for what's really just a ring-behavior change (strategy/timeout/announce/retry/timeout-restart). Edit rewrites the exact 6-line stanza in `/etc/asterisk/queues.conf` in place via a regex scoped to that one `[asterisk_name]` block (safe to build directly from the name since `slugify()` only ever emits `[a-z0-9_]`, never a regex metacharacter), then calls `ami.queueReload()` - same real-Asterisk-config philosophy as creating a queue in Phase 8. Delete does the same stanza removal. Verified end to end: edited an unused queue's ring strategy and confirmed the new values in both MySQL and the actual `queues.conf` stanza on the server; created and deleted a throwaway queue and confirmed its stanza was gone afterward (`grep -c` returned 0).

### Leads admin edit is distinct from the agent disposition endpoint
`PUT /admin/leads/:id` (name/phone/campaign/status, admin-only) is a new endpoint, deliberately separate from the existing `POST /leads/:id/disposition` (status-only, agent-facing, unenforced here) - conflating them would have let an admin edit accidentally touch the DNC-relevant disposition flow without its validation. Phone format re-validated on edit (`+?[0-9]{7,15}`) - verified a malformed phone was correctly refused with 400 before any UI was built.

### UI
Each table (Queues, Campaigns, DID Numbers, Leads) got an Actions column with Edit/Delete buttons. Edit reuses the existing Create form in place for Queues/Campaigns/DID Numbers (submit button relabels to "Save Changes", a Cancel button appears, `editing<X>Id` tracks state) rather than a separate modal/page - there was no reason to build a second form when the first one already has every field. Leads has no "create one lead" admin form to reuse (only CSV import), so it got a small dedicated Edit Lead card instead, hidden until Edit is clicked. Delete always confirms first (`confirm()`) and surfaces the backend's specific blocking message via `alert()` rather than a generic failure. All four backend endpoint sets verified directly via curl - including the three deliberately-blocked deletes and the full edit/delete success paths - before any of this UI was wired up, then `node --check` + HTTP 200 + a grep for the new action buttons confirmed after pushing.

---

## Phase 14 — Lead Lists (COMPLETE ✅ 2026-10-05)

"Need list module" turned out, after a clarifying question, to mean something more specific than another sidebar split: *"For lead upload, need to create list and upload leads on that"* - the user wanted the dialer-CRM-standard concept of a named **list** (a batch within a campaign, like "October cold list" or "Referrals"), with CSV import targeting a specific list instead of landing loose in the campaign's flat lead pool.

### Schema: a thin layer between campaigns and leads
New `lists` table (`campaign_id` FK, `name`) plus `leads.list_id` (nullable FK to `lists`). Deliberately did not touch the existing `leads.campaign_id` or any agent-facing dialing/queue logic - a list is purely an organizational grouping for admin-side import/tracking, not a new dialing unit. Kept scope tight per the project's standing principle of not building fields with no logic behind them: no agent-facing "dial from this list" feature was requested or built, so none was added.

### CSV import now targets a list, campaign derived from it
`POST /admin/leads/import` changed from requiring `campaignId` to requiring `listId` - the campaign is looked up from the list itself, so the UI only needs one dropdown instead of two. Duplicate-detection still checks the whole campaign (not just the one list), since the actual risk being guarded against - re-importing the same lead twice - doesn't go away just because the two imports used different list names within the same campaign.

### Edit/Delete, consistent with Phase 13
Lists got the same Create/Edit/Delete treatment as Queues/Campaigns/DID Numbers: delete is blocked with a specific count ("Cannot delete - N lead(s) still belong to this list") when leads still reference it, verified directly via curl (blocked while 2 leads were attached, succeeded cleanly once they were removed). The existing Edit Lead card gained a List dropdown alongside the Campaign one, with an `onchange` handler (`syncLeadCampaignFromList()`) that auto-fills the matching campaign when a list is picked, so the two fields can't silently drift apart from the UI.

### A brief SSH outage, caused by the environment, not the server
Mid-deployment, the admin.html push started timing out - `ssh ... Connection timed out` - while the app itself (port 3000) stayed reachable. Diagnosed directly (`curl ifconfig.me` from the same shell the SSH command runs in) rather than guessing: the Bash tool's egress IP didn't match the security group's "My IP" SSH rule at that moment, and had in fact changed again by the time the user checked their own. Flagged it rather than retrying blindly, and it resolved itself once the egress IP matched an allowed one again - worth remembering that this environment's outbound IP can shift session to session, so an `ifconfig.me` check is the fast way to confirm before assuming the server or security group is actually the problem.

### Verified end to end via curl before any UI work
Created a list, imported a CSV into it, confirmed the lead count and `list_name` showed up correctly on both the list and the lead, confirmed the blocked-delete message, then a full create → import → edit → delete cycle left the DB exactly as clean as it started. Only after all of that did the HTML/JS go out, checked the same way as every prior phase (`node --check` on the extracted script, HTTP 200, grep for the new element IDs in the served page).

---

## Phase 15 — GitHub + secrets rotation + fresh-server deploy guide (COMPLETE ✅ 2026-10-05)

The user wanted the project on GitHub so it could be pulled onto a new server, with an eye toward other developers eventually contributing. Before any of that, every hardcoded secret in the codebase had to actually become a secret, not a string sitting in committed source.

### Found four real hardcoded secrets, rotated all of them live
`backend/db.js` (MySQL password), `backend/ari.js` (ARI password), `backend/ami.js` (AMI password), `backend/server.js` (session secret) - plus the three demo account passwords in `backend/seed-users.js`. All four services' passwords were changed on the live server (MySQL `ALTER USER`, `ari.conf`/`manager.conf` edited + reloaded, `users` table password hashes updated directly) and the app rewritten to read every one of them from `process.env`, loaded via `dotenv` and a startup guard that refuses to boot with any required var missing - a fresh deploy that forgot `.env` fails loudly immediately, not with a confusing error the first time something tries to use `undefined` as a password. `backend/.env.example` (and matching ones for `bot-service`/`ari-hello-world`) document every variable without real values.

Verified each rotation actually took effect before moving on: health check, admin login with the new password, an AMI-backed queue edit (proves AMI auth), and the ARI websocket reconnect log line - all checked directly, not assumed.

### A real bug surfaced for free while reading the logs
While confirming the restart was clean, the server log showed a repeated unhandled rejection: deleting Queue 1 failed on `agent_status_log.queue_id`'s foreign key, a reference the Phase 13 delete-safety check never accounted for (it only checked `campaigns.queue_id`). Fixed the same way as every other delete-safety check this project uses - an explicit pre-check with a specific count in the error message - rather than leaving it to surface as a raw DB error. Verified directly: the same delete attempt that used to crash with an unhandled rejection now returns a clean `409` naming how many historical records are attached.

### Squashed 30 commits into one, by explicit choice
The credentials file (`Credentials-Dialforge/login creds.txt`) turned out to already be committed to git history from earlier in the project, despite a standing instruction to leave it uncommitted going forward - that instruction protected it from *new* commits, but didn't retroactively scrub what was already there. Asked directly how to handle this rather than assuming: the user chose to rotate secrets *and* squash history into a single clean commit, rather than keep 30 commits of now-dead-but-still-visible secrets around. Kept a `pre-squash-backup` branch locally (never pushed) as a safety net before rewriting. Before committing, scanned the entire staged diff for every old and new secret string directly (not just the files touched) - caught two more real exposures this way: the actual old demo-account passwords still sitting in `STATUS.md`'s "How to Access Everything" table, and a stale `DialForge_ARI_Pass!`/`DialForge_DB_Pass!` reference inside `RUNBOOK.md`'s own historical narrative (describing *how* a password was set, which doesn't need to show the literal value to stay useful). Redacted both before finalizing the commit.

Also deleted `backend/schema-mysql.sql`, a stale 66-line partial schema from early Phase 3 - fully superseded by a fresh, complete `mysqldump` (`backend/schema.sql`), which is now the single authoritative schema baseline, regenerated whenever the schema changes rather than hand-maintained.

Pushed to a new private GitHub repo (`ShankarBhai28/Dialforge`) - verified directly afterward by listing the pushed tree and grepping it for every rotated secret string, confirming none were present.

### `docs/DEPLOY.md` - from checklist to a fully standalone walkthrough
First pass covered the mechanics assuming familiarity with the project's own history (reasonable for "redeploy the thing you built"). Then the user asked to actually try this on a second, brand-new AWS server, entirely on their own, consulting only this one document - a materially different bar. Rewrote it as a complete, literal, copy-paste-ready walkthrough: every `pjsip.conf`/`extensions.conf`/`http.conf`/`rtp.conf`/`queues.conf`/`ari.conf`/`manager.conf` snippet, both systemd units, the coturn config, and the Let's Encrypt renewal hooks - pulled directly from the live server's actual current config (sanitized of real secrets, not retyped from memory), not just referenced from RUNBOOK's narrative.

Scoped deliberately with the user's input: a separate test server (the original stays untouched), skipping the real PSTN trunk entirely for this pass, since that depends on the trunk provider (nxtra) allowlisting a new IP - a conversation with them, not something any document can resolve. Everything else (Asterisk, WebRTC, TURN, the full app) is covered end-to-end; the trunk is Appendix B, to be added once the provider's side is sorted.

### One more inconsistency fixed along the way
While pulling the live server's actual renewal-hook scripts as source material for the new document, found that `node-cert-copy.sh` still used a manual `pkill`/`nohup` restart dance predating the `dialforge-backend` systemd service - a leftover from before that service existed, never updated afterward. Rewrote it to `systemctl restart dialforge-backend` instead, syntax-checked (`bash -n`) rather than triggering a real renewal to verify it, since testing a real cert renewal risks the live HTTPS cert for no reason.

---

## DialForge_Testing — solo rebuild from DEPLOY.md, Phase 0 (COMPLETE ✅ 2026-10-05)

A second, brand-new server built by the user **solo, following only `docs/DEPLOY.md`** - the real test of whether that document stands on its own. The original `dialforge-dev` server is untouched.

### Server
- **Provider**: AWS `ap-south-1` (Mumbai), Ubuntu 24.04.5 LTS, 3.7G RAM, 29G disk
- **Public IP**: `65.1.59.100` (private `172.31.15.186`, hostname `ip-172-31-15-186`)
- **Domain**: `dialforgetest.ddnsfree.com` (Dynu free DDNS), Let's Encrypt cert valid until 2027-01-03
- **Login**: `ssh -i DialForge_Testing.pem ubuntu@65.1.59.100` - same rule as before: the `.pem` is the only way in, keep a backup copy
- **Installed**: Asterisk 22.11.0, coturn, certbot (DEPLOY.md sections 0-6)

### Result
Extensions `1001` ↔ `1002` call each other over WebRTC (WSS signaling + DTLS-SRTP media) with two-way audio, using `phase0/test.html` served from Asterisk's own static file server at `https://dialforgetest.ddnsfree.com:8089/static/test.html`. Verified from the server side too: CDR shows `ANSWERED`, ICE completed on both legs, and Asterisk's strict-RTP switched to the browser's real public address on both legs.

### Four real problems hit, in order
1. **Asterisk's HTTP server was silently disabled.** `http.conf` ended up with two `[general]` sections - the stock one from `make samples` (with `bindaddr=127.0.0.1`, no `enabled=yes`) and DEPLOY.md's block pasted below it. Asterisk only reads the first, so `http show status` said `Server Disabled` and nothing listened on 8089. A useful tell: connecting to 8089 got *connection refused* (not a timeout) - meaning the security group let the packet through and the server itself rejected it, which pointed at Asterisk, not AWS. Fixed by merging into one section. *DEPLOY.md's wording ("confirm/add under `[general]`") caused this - now corrected.*
2. **`ERR_NAME_NOT_RESOLVED` in the browser** even though the hostname resolved fine via Google/Cloudflare DNS. A local/ISP DNS cache had remembered "doesn't exist" from before the DDNS record was created. Fix: flush DNS (`ipconfig /flushdns`, Chrome's host cache).
3. **Calls took 20-40s to go out, and the callee "rang but never answered".** SIP trace showed Asterisk ringing the callee browser (`180 Ringing`), then nothing until `Dial()`'s 20s timeout cancelled it. Cause: JsSIP holds the INVITE / 200 OK until the browser finishes gathering *every* ICE candidate, and on a Windows PC with extra adapters (a VirtualBox host-only adapter, `192.168.56.1`, was present) that takes longer than the ring timeout. Fixed in `test.html`: send the SDP as soon as a usable (`srflx`/`relay`) candidate exists, or after 3s - JsSIP's `icecandidate` event exposes a `ready()` callback for exactly this.
4. **Call connected, but no audio, and Asterisk logged "placed on hold".** The SIP trace showed both browsers' SDP with `c=IN IP4 0.0.0.0`, `m=audio 9`, and **zero** `a=candidate` lines - the browsers had no address to offer at all, and Asterisk treats `0.0.0.0` as hold. Cause: the test page's "Force TURN relay only" checkbox was ticked, so the browser may *only* use TURN relay candidates - and its TURN login was failing, so it ended up with nothing. Unticking it fixed the call immediately (host + srflx candidates appeared, ICE completed).

*Lesson worth keeping: when debugging WebRTC, read the SDP in the SIP trace (`pjsip set logger on`). The `c=` line and `a=candidate` lines tell you in seconds whether the browser is offering a usable address - that split "signaling problem" from "media problem" faster than anything in the browser UI.*

### Still open
- **TURN from a browser is not yet verified.** coturn itself is fine - tested on the server with `turnutils_uclient` using the credentials in `turnserver.conf`: allocation succeeded, 0% loss. So problem #4's TURN failure is almost certainly a mistyped TURN user/password on the page. Retest relay-only with the credentials copied exactly; if it still fails, `chrome://webrtc-internals` → `icecandidateerror` gives the code (`401` bad credentials, `701` unreachable). Matters for real users behind strict networks, not for this PC.
- Harmless log noise, cleanup later: `Error sending STUN request: Invalid argument` (Asterisk trying its IPv6 link-local candidate) and `Unable to find a codec translation path (ulaw/opus)` (both legs negotiate ulaw anyway).
- `pjsip.conf` `local_net=172.31.15.186` is a single host; the conventional value is the VPC range (`172.31.0.0/16`). Not causing problems for WSS, worth tidying.

### Security notes
- The GitHub repo `ShankarBhai28/Dialforge` is **publicly visible** (checked 2026-10-05: the repo page loads without login), despite Phase 15 describing it as private. Worth deciding deliberately: make it private in GitHub → Settings, or keep it public knowing everything in it is world-readable.
- `backend/public/agent.html` still has the **old server's** TURN password hardcoded. Confirmed the new server's coturn password is different, so this server isn't exposed by it - but don't carry `agent.html` over to this server as-is in section 7+; the TURN credentials should come from the backend/config, and it still points at the old hostname.
- `ufw` is inactive on this server - the AWS security group is the only firewall. Same posture as the original server; fine as long as the security group stays tight.

### Cost status
One EC2 instance plus its public IP, same as the original server - this is a **second** running instance, so if your free-tier hours are shared across both, running two instances 24/7 can exceed the 750 free hours/month. Check **AWS Console → Billing → Free Tier**, and stop whichever server you're not using.

### Next
DEPLOY.md section 7 (Node.js) onwards.

---

## Predictive Dialer D1 — Teams + team→campaign mapping (2026-10-08, dialforge-dev)

Plan for the whole predictive-dialer track: `docs/PREDICTIVE_DIALER_PLAN.md` (steps D1–D11). This is D1.

### What & why
Before this, every agent saw every active campaign's queue. Now: **agent → team(s) → campaigns**. An agent only sees (and can only go Available on) queues of campaigns mapped to one of their *active* teams. An agent in no team sees nothing. Later dialer steps rely on this to know which agents belong to which campaign.

### What changed
- **DB** (`backend/migration-teams.sql`): `teams`, `team_members` (team↔user), `team_campaigns` (team↔campaign). Link tables use `ON DELETE CASCADE`, so deleting a team/campaign/user only drops the mapping, never call/lead data.
- **Zero-change seed**: the migration creates "Default Team" containing all existing agents + all campaigns, so nobody lost access on deploy.
- **Backend** (`server.js`): `GET /queues` filtered by team for agents (admins unchanged); `POST /agent/status` returns 403 if an agent tries to go Available on a queue outside their teams (server-side enforcement, not just hidden in UI; Break/ACW never blocked); new `GET/POST/PUT/DELETE /admin/teams` — create/edit replace members+campaigns inside one transaction.
- **Admin UI**: new **Teams** sidebar module (name, status, agent + campaign checkboxes). Names are HTML-escaped.
- **Agent UI**: if the remembered queue gets unmapped mid-session, the agent is told and re-picks.

### Deploy (how it was done)
1. Backup: `~/backups/20261008-062946/` (DB dump + old `server.js` + `public/`).
2. `scp` migration, `server.js`, `admin.html`, `agent.html` to `~/dialforge-backend/`.
3. `sudo mysql dialforge_dev < migration-teams.sql` → `sudo systemctl restart dialforge-backend` (restart logs everyone out — sessions are in memory).

**Rollback**: copy `server.js` + `public/` back from the backup folder, restart, then `DROP TABLE team_campaigns, team_members, teams;`.

### Verified
- `/health` OK, ARI reconnected, Teams page served, `/admin/teams` → 401 without login.
- Ran the team-filter SQL directly: each of agent1001/1002/1003 resolves to the same 3 queues as before.
- **Not yet done (you, in the browser)**: create a second team with one agent + one campaign, untick that agent from Default Team, log in as that agent → only that campaign's queue should show.

### Noticed, not touched
`systemctl` warns the `dialforge-backend.service` unit file changed on disk without `daemon-reload`. Pre-existing; run `sudo systemctl daemon-reload` when convenient.

### Next
D2 — Custom Forms module.

---

## Predictive Dialer D2 — Custom Forms (2026-10-08, dialforge-dev)

### What & why
Admin builds a form (fields of type Text / Long text / Number / Email / Phone / Date / Dropdown / Radio / Checkbox, each optionally required). A campaign points at **one active form**. The agent working that campaign sees the form on their screen, fills it during the call, and saves it — one row per submission, linked to the lead and call being dialed.

### What changed
- **DB** (`backend/migration-forms.sql`): `forms`, `form_fields` (ordered, `field_key` unique per form, `options` JSON), `form_responses` (`data` JSON keyed by `field_key`, plus form/campaign/lead/call/user), `campaigns.form_id`.
  - Why JSON for answers: each campaign's form has different fields; one JSON column avoids a schema change per form. Why `field_key`: stable machine name — in D4 it becomes the Excel column header for lead upload.
- **Backend**: `GET/POST/PUT/DELETE /admin/forms`, `GET /admin/forms/:id/responses`, `GET /agent/form` (form of the agent's current campaign), `POST /agent/form-responses`.
  - All values re-validated server-side against the form (required, number/email/phone/date format, choice must be one of the options; unknown keys dropped).
  - Lead must belong to the agent's current campaign; call must be the agent's own.
  - Blocked with a clear message: deleting a form used by a campaign or with saved responses (deactivate instead), deactivating a form a campaign still uses, attaching an inactive form. Campaign/lead delete now also blocked by form responses.
- **Admin UI**: new **Forms** module (field builder with reorder, key auto-suggested from label, Responses viewer as a table). Campaigns page has a **Form** dropdown + column.
- **Agent UI**: form card appears when the current campaign has a form; clicking **Call** on a lead links the form to that lead + call; Save / Clear.

### Deploy
Backup `~/backups/20261008-065314/`, then same steps as D1 with `migration-forms.sql`.
**Rollback**: restore `server.js` + `public/` from backup, restart, then `ALTER TABLE campaigns DROP FOREIGN KEY campaigns_form_fk, DROP COLUMN form_id; DROP TABLE form_responses, form_fields, forms;`

### Verified
- Validation logic unit-tested offline (11 cases: bad/duplicate keys, missing options, required, number/email/choice checks, unknown keys dropped).
- After deploy: `/health` OK, tables + `campaigns.form_id` exist, new endpoints return 401 without login, new pages served.
- **To do in the browser**: create a form → attach it to a campaign → agent picks that campaign's queue → form appears → Call a lead → fill → Save → Admin Forms → Responses shows the row.

### Next
D3 — campaign dial settings (mode, ratio, hours, retries), per-campaign dispositions, callbacks, DNC list.

---

## Predictive Dialer D3 — Dial settings, dispositions, callbacks, DNC (2026-10-08, dialforge-dev)

### What & why
Everything the dialer engine (D5+) needs to *decide* — stored and editable now, and enforced on manual calls where it already makes sense.

### What changed
- **DB** (`backend/migration-dialer-settings.sql`):
  - `campaigns` + dial settings: `dial_mode` (manual/preview/progressive/predictive), `dial_ratio`, `max_dial_ratio`, `target_abandon_pct`, `ring_timeout_sec`, `max_attempts`, `max_channels`, `amd_enabled`, `preview_autodial_sec`, `wrapup_sec`, `call_window_start/end`, `timezone` (default Asia/Kolkata — the server runs in UTC, so calling hours are evaluated in the campaign's timezone).
  - `campaign_dispositions` per campaign: code, label, final / retry-after-minutes / callback / DNC. Every existing campaign seeded with the same 5 codes as before (interested, not_interested, callback, no_answer → retry 60 min, do_not_call), so reports and old leads keep working. New campaigns get these automatically.
  - `leads` + `attempts`, `last_attempt_at`, `next_call_at`, `is_final` (+ index for the D5 hopper query).
  - `dnc_numbers` (tenant-wide, normalised phone, unique) — seeded from the 2 leads already marked Do Not Call.
  - `callbacks` (lead, campaign, user or NULL = anyone, time, note, pending/done/cancelled).
- **Phone normalisation** (`normalizePhone`): digits only; `+91…`/`91…` (12 digits) and `0…` (11 digits) reduced to the 10-digit number, so every format matches in DNC.
- **Disposition save** now follows the campaign's config, in one transaction: sets status + `is_final`, sets `next_call_at` (retry or callback time), closes any earlier pending callback for that lead, creates a callback if needed, adds the number to DNC if the disposition is DNC. Agents can only disposition leads in their current campaign (previously any lead).
- **Click-to-call enforcement**: number on DNC list → refused; outside the campaign's calling hours → refused (only for real trunk calls, not internal extension tests); `attempts`/`last_attempt_at` counted per lead.
- **Admin UI**: Campaigns page has a **Dialer settings** block (fields shown per mode), a Mode column, and a **Dispositions** editor per campaign. New **Callbacks** (list, overdue highlighted, cancel) and **DNC List** (bulk add, search, remove) modules.
- **Agent UI**: disposition popup built from the campaign's dispositions; Callback opens a date/time picker (+ "only me" / note); **My Callbacks** card (own + "anyone" callbacks for the current campaign, due ones in red, Call button).

### ⚠️ Behaviour change to remember
Calling hours default to **09:00–21:00 Asia/Kolkata** for every campaign. Outside that window, manual trunk calls are refused with a clear message — widen the window on the campaign if testing late.

### Deploy
Backup `~/backups/20261008-065936/`, same steps as D1/D2 with `migration-dialer-settings.sql`.
**Rollback**: restore `server.js` + `public/` from backup and restart; then either restore the DB dump from the backup folder, or drop `callbacks`, `dnc_numbers`, `campaign_dispositions` and the new `campaigns`/`leads` columns.

### Verified
- Helpers unit-tested offline: phone normalisation (6 formats), settings ranges (mode, ratio, max<ratio, reversed window, bad timezone, non-integer attempts), disposition rules (final+retry, DNC-not-final, reserved "new"), IST window maths.
- After deploy: `/health` OK, 5 dispositions per campaign, 2 DNC numbers seeded, old DNC leads marked final, new endpoints 401 without login.
- **To do in the browser**: edit a campaign's dialer settings + dispositions; agent: call a lead → Callback → pick time → appears in My Callbacks + admin Callbacks; mark a lead Do Not Call → number appears in DNC List → calling it is refused.

### Next
D4 — Excel (.xlsx) lead upload with the campaign form's fields as columns, DNC scrub at import.

---

## Predictive Dialer D4 — Excel lead upload (2026-10-08, dialforge-dev)

### What & why
Leads can now be uploaded as **.xlsx** (CSV still works), and the upload carries the campaign form's fields too — e.g. `loan_amount`, `plan` — so the agent's form opens pre-filled with what's already known about the customer.

### What changed
- **DB** (`backend/migration-lead-custom-data.sql`): `leads.alt_phone`, `leads.priority` (higher = dialed first by the D5 hopper), `leads.custom_data` JSON.
- **New dependency**: `exceljs` 4.4.0. `npm audit` flagged its bundled `uuid` (moderate, in uuid v3/v5/v6 which exceljs doesn't use); fixed properly with an `overrides: { uuid: ^11.1.1 }` in `package.json` → **0 vulnerabilities**. `package-lock.json` now tracked locally (synced from the server).
- **Import** (`POST /admin/leads/import`):
  - Columns: `phone` (required), `name`, `alt_phone`, `priority`, + every `field_key` of the list's campaign form. Unknown columns → whole file rejected with the allowed list (catches typos before anything is saved).
  - Phones normalised (`+91`, `0`, spaces removed). Duplicates (vs campaign + within file) and **DNC numbers** skipped and counted.
  - Form-field values type-checked (number, date YYYY-MM-DD, email, phone, dropdown/radio choice, checkbox comma-list). Bad rows skipped with **row number + reason** (first 50 shown).
  - Excel quirks handled: numeric phones, real date cells, rich text, formulas (uses the result), blank rows, BOM in CSV.
  - Limits: 5 MB, 20,000 rows. Inserts are batched (500/statement) inside one transaction — all or nothing.
- **Template** (`GET /admin/leads/template?listId=&format=xlsx|csv`): columns built from that list's campaign form + an example row; xlsx adds an **Instructions** sheet (type + allowed values per column) and keeps phone columns as text (no `9.84E+09`). Old `/admin/leads/csv-template` redirects to it.
- **Admin UI**: Import accepts .xlsx/.csv, template buttons for the selected list, result shows DNC/duplicate/invalid counts + row errors.
- **Agent UI**: clicking Call on a lead pre-fills the form from its `custom_data` and shows the lead's name.

### Deploy
Backup `~/backups/20261008-070805/` (also has old `package.json`/lock). Copied files + `package.json`, `npm install --omit=dev` on the server, migration, restart.
**Rollback**: restore `server.js`, `public/`, `package.json`, `package-lock.json` from backup, `npm install --omit=dev`, restart; `ALTER TABLE leads DROP COLUMN alt_phone, DROP COLUMN priority, DROP COLUMN custom_data;`

### Verified
- Parser unit-tested offline with a messy .xlsx (numeric phone, Date cell, rich text, formula, blank row, invalid values), a CSV with BOM + quoted comma, and a corrupt file.
- On the server: `npm audit` 0 vulnerabilities, exceljs loads, new columns exist, `/health` OK, new endpoints 401 without login.
- **To do in the browser**: select a list whose campaign has a form → Download Template (.xlsx) → fill a few rows (include one DNC number, one duplicate, one bad value) → Import → check counts/row errors → agent calls an imported lead → form pre-filled.

### Next
D5 — dialer-engine service skeleton + hopper + Start/Pause/Stop per campaign.

---

## Predictive Dialer D5 — Dialer engine + hopper (2026-10-08, dialforge-dev)

### What & why
The first piece of real dialer machinery: a **separate background service** that keeps a buffer (the **hopper**) of the next leads to dial for each running campaign, plus **Start / Pause / Stop** per campaign. **No calls are placed yet** — the engine shows how many it *would* dial (dry-run). Preview (D6) and auto-dialing (D7–D8) plug into this loop.

### How it works
- **`dialer-engine.js`** runs as its own systemd unit **`dialforge-dialer`** (log: `~/dialforge-backend/dialer.log`). Separate from the web backend so a problem in one never takes down the other; they only talk through MySQL.
- **Single instance**: on start it takes a MySQL `GET_LOCK('dialforge_dialer_engine')`. A second copy exits immediately (tested). If the engine dies, MySQL releases the lock with its connection.
- **Every 5 s**, for each running/paused campaign:
  1. Count idle agents = open `agent_status_log` rows with status `available` in the campaign's queue.
  2. **Clean** the hopper: drop leads that became final, rescheduled, moved campaign, used up `max_attempts`, list deactivated, or number added to DNC; unlock rows locked > 10 min.
  3. **Fill** (only if running, mode ≠ manual, campaign active, has a queue, inside calling hours): target = max(20, idle agents × ratio × 10), capped at 500. Pick order: **due callbacks → list priority → lead priority → fewest attempts → oldest**. "Only me" callbacks are left for the agent unless the mode is Preview. DNC re-checked. `INSERT IGNORE` + `UNIQUE(lead_id)` = a lead can never be queued twice.
  4. Write `dialer_status` (hopper counts, idle agents, would-dial, a plain-English note such as "outside calling hours" or "no dialable leads").
  - Row `campaign_id = 0` is the engine heartbeat; the admin page shows the engine as DOWN if it hasn't ticked for 15 s.
- **Stop** empties the hopper; **Pause** keeps it but stops filling. Switching a campaign to Manual stops it automatically.

### What changed
- **DB** (`backend/migration-dialer-hopper.sql`): `campaigns.dialer_state` (+ changed_at/by), `lists.is_active` + `lists.priority`, `dial_hopper`, `dialer_status`.
- **Code**: new `dialer-engine.js`, `dialforge-dialer.service`, and `dialer-common.js` (phone normalisation + calling-hours logic moved here so the backend and the engine use the identical rules).
- **Backend**: `POST /admin/campaigns/:id/dialer` (start/pause/stop, with checks: not manual, campaign active, has queue), `GET /admin/dialer`, `GET /admin/campaigns/:id/hopper`; lists accept active + priority.
- **Admin UI**: new **Dialer** page (engine badge, per-campaign state, idle agents, hopper ready/locked, would-dial, engine note, Start/Pause/Stop, live hopper view; refreshes every 3 s). Lists have **Active for dialer** + **Priority**.

### Deploy
Backup `~/backups/20261008-071354/`. Copied files, migration, `sudo cp dialforge-dialer.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now dialforge-dialer`, restarted backend. (The `daemon-reload` also cleared the old "unit file changed on disk" warning.)
**Rollback**: `sudo systemctl disable --now dialforge-dialer`, restore `server.js` + `public/` from backup, restart backend; `DROP TABLE dialer_status, dial_hopper; ALTER TABLE lists DROP COLUMN is_active, DROP COLUMN priority; ALTER TABLE campaigns DROP COLUMN dialer_state, DROP COLUMN dialer_state_changed_at, DROP COLUMN dialer_state_changed_by;`

### Useful commands
- `systemctl status dialforge-dialer` · `tail -f ~/dialforge-backend/dialer.log`
- `sudo mysql dialforge_dev -e "SELECT * FROM dialer_status"`

### Verified
- Engine active, heartbeat updating every 5 s; second engine refused by the lock (exit 1).
- Hopper selection SQL runs on real data and uses `idx_leads_dialable`. Current leads correctly not eligible (3 have no campaign, 2 are DNC/final).
- **To do in the browser**: import a few leads into a list (D4) → set the campaign to Progressive (Campaigns → Edit) → Dialer → Start → hopper fills, note is empty, "would dial" = idle agents × ratio once an agent is Available in that queue → Pause/Stop behave as described.

### Next
D6 — Preview mode: the next hopper lead pops up on the agent's screen; agent clicks Dial (or auto-dial countdown).

---

## Predictive Dialer D6 — Preview mode (2026-10-08, dialforge-dev)

### What & why
First mode that places calls from the hopper — but **only when the agent clicks Dial** (or an optional countdown runs out). Safest auto mode: a human sees every lead before it's called, and it can never abandon a customer.

### How it works
- Campaign: Dial mode **Preview**, dialer **Started** on the Dialer page (engine fills the hopper as in D5).
- Agent goes Available in that campaign's queue → the page (every 5 s poll, only when the agent is free: Available, no call, no outcome popup) asks `POST /agent/preview/next`.
- Server **claims** one hopper row for that agent: `SELECT … FOR UPDATE SKIP LOCKED` → `status='locked', locked_by='user:<id>'`. SKIP LOCKED means two agents asking at the same instant get *different* leads — never the same one, and neither waits. "Only me" callbacks go only to their owner, and first.
- **Preview card** shows name, phone, alt phone, list, attempts, last outcome, callback note, and the lead's uploaded data (form labels). Buttons: **Dial** (normal click-to-call → all D3 checks apply: DNC, calling hours, attempts counted) and **Skip** (lead leaves the hopper, not offered again for 15 min).
- **Auto-dial countdown**: if the campaign's *Preview auto-dial (sec)* is set, Dial happens automatically after N seconds unless the agent clicks "stop" or Skip.
- Refreshing the page gives the **same** held lead back (no lead lost or double-claimed).
- Locks are **released back to the hopper** when the agent goes to Break/ACW, logs out, or switches to another campaign's queue (plus the engine's 10-min stale-lock expiry as a safety net).
- Click-to-call now always removes the lead from the hopper when dialed, and refuses with "another agent is previewing this lead" if someone else holds it — no double dial between preview and manual.

### What changed
- No DB change. `server.js`: `GET /agent/preview`, `POST /agent/preview/next`, `POST /agent/preview/skip`, lock release in `setAgentStatus` + logout, hopper guard in click2call. `agent.html`: Preview card, countdown, auto-claim; a failed click2call no longer leaves the page thinking a call is in progress.

### Deploy / rollback
Backup `~/backups/20261008-071846/` (code only). Rollback: restore `server.js` + `public/` from it, restart backend.

### Verified
- Backend healthy; new endpoints 401 without login; the claim query (`FOR UPDATE SKIP LOCKED`) parses and runs on MySQL 8 (inside a rolled-back transaction).
- End-to-end test: see `docs/PREDICTIVE_DIALER_TEST_CHECKLIST.md`.

### Next
D7 — Progressive mode: the engine originates calls itself (ARI), answered calls go to the campaign queue, every attempt logged in `dial_attempts` with its network result.

---

## Predictive Dialer D7 — Progressive mode (2026-10-08, dialforge-dev)

### What & why
The engine now **dials by itself**: for a running Progressive campaign it keeps `floor(idle agents × dial ratio)` calls going. Answered customers are handed to the campaign's queue; agents get a screen pop. Every attempt — reached or not — is logged in `dial_attempts`.

### Call flow
1. **Pacing tick (every 1 s)**: idle agents = Available in the queue **and not on a call** (open `calls` row on their extension). `to_dial = floor(idle × ratio) − in flight`, capped by campaign `max_channels`, the **trunk cap** (`DIALER_MAX_TRUNK_CHANNELS` in `.env`, default **4**) and 5 new calls per second.
2. **Claim**: best ready hopper row (`FOR UPDATE SKIP LOCKED`), removed from the hopper + `dial_attempts` row + `leads.attempts+1`, all in one transaction. Last-moment DNC check.
3. **Originate** via ARI app **`dialforge-dialer`** with channel id `dfd-<attemptId>`, campaign CLI, `ring_timeout_sec`. Our own extensions (e.g. a test lead "1002") are dialed directly; everything else via the trunk.
4. **Not answered** → ARI `ChannelDestroyed` with a hangup cause → result `busy` (17/21), `no_answer` (16/18/19), `invalid` (1/3/22/28 → lead made final), `congestion` (34/38/41/42/44/58) or `failed`. Lead rescheduled with the campaign's *No Answer* retry delay.
5. **Answered** → `calls` row created (with `channel_name`), attempt `answered`, then the channel continues in dialplan **`[dialer-answered]`** (`/etc/asterisk/extensions-dialer.conf`, included from `extensions.conf`): optional `AMD()`, then `Queue(<queue>,,,,<abandon_wait_sec>)`.
6. **Agent takes it** → backend's AMI `AgentConnect` finds the call by channel name (the engine is a separate process) → attempt `connected`, agent recorded. Agent's browser auto-answers (use Auto Answer on dialer campaigns), asks `GET /agent/active-call` and **pops the lead**: form pre-filled + linked, outcome popup when the call ends.
7. **No agent within `abandon_wait_sec`** → dialplan sends `UserEvent(DialForgeDialer … abandoned)`, plays a placeholder prompt (`tt-allbusy` — **record a proper message before live**), hangs up. Customer hangs up while waiting → `QueueCallerAbandon` → `customer_hangup`. Both count as abandoned; lead retried in 2 min.
8. **AMD says machine** → `machine`, retried like No Answer.
9. **Wrap-up**: after the agent saves the outcome in a progressive/predictive campaign, they go back to Available automatically after `wrapup_sec` (any manual status click cancels it).
10. **Sweeper (every 5 s)**: attempts stuck in dialing/answered whose channel Asterisk no longer has are closed — protects pacing from a missed event or an engine restart.

### Other changes
- **Queues: `ringinuse = no`** added to all 4 existing stanzas and to every queue created/edited from now on — `Queue()` must never ring an agent who is already on a call.
- `ari.js`: originate takes `timeout` + `channelId`; `getChannel()`; the event WebSocket **reconnects by itself** (previously a dropped connection silently stopped events until a restart — affects the backend too).
- `dialer-common.js`: `finishAttempt()` — one place that records a result (first writer wins) and reschedules the lead, used by both processes.
- Campaign setting **Max wait for agent (sec)** (`abandon_wait_sec`, default 5).
- Dialer page: ringing/waiting, on calls, and **today's numbers** per campaign (dialed / answered / to agent / not reached / machine / **abandoned with %**, red above 3%).

### Deploy
Backup `~/backups/20261008-073034/` (DB, code, **`extensions.conf` + `queues.conf`**). Migration `migration-dial-attempts.sql`; `extensions-dialer.conf` copied to `/etc/asterisk` + `#include` line appended to `extensions.conf` + `dialplan reload`; `ringinuse = no` added + `queue reload all`; both services restarted.
**Rollback**: stop campaigns; restore code + both `.conf` files from the backup, `dialplan reload`, `queue reload all`, restart both services; `DROP TABLE dial_attempts; ALTER TABLE calls DROP COLUMN channel_name, DROP COLUMN dial_attempt_id; ALTER TABLE campaigns DROP COLUMN abandon_wait_sec; ALTER TABLE dialer_status DROP COLUMN in_flight, DROP COLUMN active_calls;`

### Verified
- Pacing formula unit-tested (8 cases incl. trunk cap, campaign cap, per-tick cap, never negative); queue-stanza regex tested with and without `ringinuse`.
- `dialplan show dialer-answered` correct; `ari show apps` lists `dialforge-app` + `dialforge-dialer`; services healthy; all campaigns still Manual/Stopped, 0 attempts.
- **Not yet live-fire tested** — see checklist D7 (start with a test lead = your own extension, max channels 1).

### Before live
- Set `DIALER_MAX_TRUNK_CHANNELS` to the live trunk's real concurrent limit.
- Replace the `tt-allbusy` placeholder with a recorded abandon message.

### Next
D8 — Predictive: ratio computed from live answer rate, lowered automatically when abandon % exceeds the campaign target.

---

## Predictive Dialer D8 — Predictive mode (2026-10-08, dialforge-dev)

### What & why
Progressive dials a fixed ratio. **Predictive learns it**: if 40% of calls are answered, dialing 1 / 0.4 = 2.5 lines per free agent keeps agents talking instead of waiting through rings and no-answers. The risk is answered customers with no free agent (**abandons**), so the ratio tunes itself against the campaign's **Target abandon %**.

### The algorithm (engine, every 5 s; pacing still every 1 s)
- **Answer rate** = answered ÷ finished attempts over the last **15 min** (needs ≥ 20 attempts; until then it uses the campaign's **Starting ratio** = the Dial ratio field — "learning" note on the Dialer page).
- **Abandon %** = (abandoned + hung up waiting) ÷ answered over the last **30 min** (needs ≥ 10 answered).
- **Adjust** factor (0.3 – 1.0), re-tuned at most every 30 s: abandon % > target → −0.1; abandon % < half the target → +0.05. Stored in `dialer_status.ratio_adjust`, so an engine restart keeps what it learned.
- **Ratio** = (1 ÷ answer rate) × adjust, clamped to **1.0 … Max dial ratio**.
- **Safety brake**: abandon % above **2 × target** → ratio forced to 1.0 (plain progressive) until it recovers.
- Then the same pacing as D7: `floor(idle × ratio) − in flight`, capped by campaign channels, trunk cap and 5 new calls/s. Each attempt records `ratio_at_dial`.
- Pure function `computePredictive()` — unit-tested on its own (learning, normal, back-off, 30-s rule, brake, max cap, 0 answers, recovery).

### Known simplifications (fine for a pilot, improve later)
- Doesn't predict agents *about to* finish a call (only counts agents already free) — a full predictive dialer also uses average talk time. Effect: slightly less aggressive than possible, never more.
- Rates are per campaign, not per list/time-of-day.

### What changed
- DB (`migration-predictive.sql`): `dialer_status` + `current_ratio`, `answer_rate`, `abandon_pct`, `ratio_adjust`, `pacing_note`.
- `dialer-engine.js`: predictive state + maths; hopper fill and pacing use the learned ratio.
- Admin: Dialer page shows for predictive campaigns "now 2.1:1 · answer 45% · abandon 1.2% · adjust 0.9" (+ learning/brake notes); in Campaign settings the ratio field is labelled **Starting ratio (until learned)** in predictive mode.

### Deploy / rollback
Backup `~/backups/20261008-073418/`. Rollback: restore `server.js`, `dialer-engine.js`, `public/` from it, restart both services (the extra `dialer_status` columns can stay).

### Verified
- Predictive maths unit-tested (11 cases). Rates + sweeper SQL run cleanly on MySQL. Both services healthy, engine log clean, campaigns still Manual/Stopped.

### Next (needs you)
- D9 dashboard/reports: mostly covered by the Dialer page "Today" + `dial_attempts`; a downloadable attempts report can follow your feedback.
- D10 load test with SIPp against a fake trunk on **DialForge_Testing** (adds cost/time — decide first).
- D11 pilot on the **live dedicated trunk** with the "Before live" items from D7.

---

## First real-number test + fixes (2026-10-08, dialforge-dev, trunk `dialforge-nxtra1`)
5 dialer calls on real mobiles. Found:
- **agent04 saw no queue**: not in any team, and Predictive_Test wasn't mapped to a team (Default Team still pointed at deleted campaign 3). Fixed via Teams UI; deleting a campaign now also removes its team mappings, recycle rules, dispositions and dialer status.
- **Lead redialed immediately after "no answer"** (commit `d963b67`): the hopper refill re-queued a lead while its call was still ringing. Now a lead with a call in progress is never queued or dialed.
- **AMD false positives**: 2 of 3 answered humans hung up as "machine" (long "hello…" → LONGGREETING; 2.5 s silence → INITIALSILENCE). Recommendation: keep AMD **off** for Indian mobiles unless tuned.

## Predictive Dialer D9 — Recycling / redial (2026-10-08, dialforge-dev)
### What it does
- **Automatic (Campaigns → Recycle rules)**: per unsuccessful result — No answer, Busy, Answering machine, Network error (congestion/failed), Abandoned (incl. hung up waiting) — choose **Auto redial** on/off, **Redial after (min)** and **Max times**. Defaults: 60/3, 15/3, 120/2, 10/3, 2/3. Tries used up (or rule off) → lead set aside (`is_final=1`) until recycled by hand. Campaign **Max attempts** still caps the total. Lead status now shows what happened (`busy`, `machine`, `network_error`, `abandoned`, `no_answer`).
- **Manual (Leads → Lists → Recycle)**: per list, a table by status (leads / dialable now / waiting for retry / done); tick statuses → **Recycle** → those leads are dialable immediately (optionally attempts reset to 0). Never recycles Do Not Call, DNC-list numbers, or a lead on a call. Each recycle is logged (`recycle_log`) and shown as "Recent" in the card.
- Lists table has a **Dialable now** column; Dialer engine note hints "recycle a list" when it runs dry.
- Agent outcomes (agent picks "No Answer") still use the Dispositions retry time.

### What changed
- DB (`migration-recycle.sql`): `campaign_recycle_rules`, `recycle_log`, `leads.recycled_at`, index `dial_attempts(lead_id, started_at)`.
- `dialer-common.js`: `finishAttempt` applies the campaign's rule (`getRecycleRules`, defaults in `DEFAULT_RECYCLE_RULES`); tries counted since `recycled_at`.
- `server.js`: `GET/PUT /admin/campaigns/:id/recycle-rules`, `GET/POST /admin/lists/:id/recycle`, `dialable_count` on `/admin/lists`, campaign delete cleanup.
- `admin.html`: Recycle rules card, Recycle list card, Dialable column, list names HTML-escaped.

### Deploy / rollback
Backup `~/backups/pre-d9-20261008-094721/` (DB dump + the 4 files). Rollback: copy the 4 files back (`admin.html` → `public/`), restart `dialforge-backend` and `dialforge-dialer`; the new tables/column can stay.

### Verified
- 9 unit tests of the recycle logic (defaults, tries used up, rule off, overrides, result grouping); admin UI exercised in jsdom with no JS errors; summary SQL run on the real list; both services healthy.

## Agent in-call panel + transfer / conference (2026-10-08, dialforge-dev)
### What the agent sees
- Docked **in-call panel** on every answered call: name + real customer number, LIVE / ON HOLD / "Ringing customer" state, timer, tab title `● LIVE 02:15`, **Mute** (with warning), **Hold** (Asterisk plays MOH), **Keypad** (DTMF), **Transfer**, **Conference**, **Hang up**.
- **Transfer**: *Blind* (customer goes straight to the target, agent freed at once - goes to ACW + outcome popup) or *Warm* (customer on hold music while the agent talks to the target, then **Complete transfer**, **Merge (3-way)** or **Cancel**). **Conference**: target joins the live call; agent can **Drop** any party or **Leave conference**.
- Targets: **another agent** (logged-in list, busy ones disabled), **a queue** (blind = customer waits in that queue for real; warm/conference = a free agent from it), **any number** (via the trunk with the campaign's caller ID, or an internal extension).
- Receiving agent gets the lead's screen pop while being consulted ("Transfer offered by a colleague"); once completed the call is theirs (outcome popup, ACW, can transfer again).

### How it works
- `call-control.js` (new): calls run in ARI bridges of `dialforge-app`. Click-to-call already is; dialer/inbound calls (bridged by `Queue()`) are taken over on the first transfer/conference: **AMI Redirect** of both legs to `[df-control]` (`/etc/asterisk/extensions-control.conf`, `#include`d from extensions.conf) -> Stasis -> re-bridged (short audio gap). Warm hold = ARI holding bridge + MOH; ringback = `tone:ring;tonezone=in` played on the bridge; extra parties originated as `dfx-<callId>-<n>`.
- Rules: agent hangs up during warm transfer = completes it (or blind if still ringing); blind target doesn't answer -> customer back to the campaign's queue; customer hangs up -> everyone dropped, all agents on it to ACW; last party left alone -> ended.
- DB (`migration-call-control.sql`): `calls.agent_channel` (from AMI AgentConnect `DestChannel`), `calls.transfer_ext` (agent being consulted - screen pop + counted busy by the dialer). Inbound calls now store `channel_name`.
- API: `GET /agent/transfer-targets`, `GET /agent/call/control`, `POST /agent/call/{transfer,complete,merge,cancel,drop,leave}`, `GET /agent/call-state/:callId`; `/agent/active-call` now also returns transferred calls (`owner` flag).
- AMI AgentComplete / QueueCallerAbandon ignore calls taken over (breaking the Queue bridge isn't a call end).

### Limits
- State is in memory: a backend restart during a transfer/conference leaves the parties talking, but one side hanging up no longer drops the others (they hang up themselves).
- Agent Hold during a conference holds all other parties.

### Deploy / rollback
Backups `~/backups/pre-incall-20261008-100801/` and `~/backups/pre-xfer-20261008-103839/` (DB dump, code files, extensions.conf). Rollback: restore `server.js ari.js ami.js dialer-engine.js public/agent.html` (+ delete `call-control.js`), restore extensions.conf, `asterisk -rx "dialplan reload"`, restart both services. New columns can stay.

### Verified
- 11 offline flow tests of call-control with a fake ARI/AMI (warm+complete, consult hang-up, merge+leave, conference add/drop, blind to agent/number/queue, no-answer fallback, warm-to-queue agent pick, agent hang-up mid-consult, click-to-call, guards); agent panel exercised in jsdom; dialplan context loaded; services healthy. **Not yet tested with real calls.**

---

## How I'll keep this doc going

I'll update this file after each meaningful step (not after every single command) — so it stays a fast, high-signal reference of *what exists and why*, not a full transcript. If you ever want the full command-by-command detail for something, ask and I'll pull it from the session.

## App rebuild — Stage 0: developer foundation (2026-10-09)
Plan: `docs/APP_REBUILD_PLAN.md`. Branch `react-frontend`, cut from `predictive-dialer`. **Nothing deployed: this stage has no server changes.**
- Tooling: repo-level `package.json` (`npm run check` = ESLint + Prettier check + tests), `.editorconfig`, and `.gitattributes`, which stores all text as LF and ends the CRLF/LF mix from Windows editors.
- Backend and bot-service formatted with Prettier in their own commit. ASTs were compared before and after and are identical for every file, so there is no code change. That commit is listed in `.git-blame-ignore-revs`.
- Lint found 3 real issues, all fixed with no behaviour change: a literal BOM character in the CSV-import regex (now `﻿`), an unused constant in bot-service, and an unused test helper.
- Tests: `backend/tests/` with `node:test`. The offline checks used while building D9 and transfer became 20 permanent tests (11 call-control flows, 9 recycle rules). `--test-force-exit` is needed because call-control's blind-transfer fallback timer keeps the process alive.
- CI: `.github/workflows/ci.yml` runs lint, format, syntax and tests on every push and PR. It only starts once the branch is pushed to GitHub.
- Docs for developers: `README.md` (rewritten), `docs/ARCHITECTURE.md`, `docs/CONTRIBUTING.md`, `docs/adr/0001-0004`, PR template.
- Key safety note for developers: never run a local backend against the shared Asterisk. Both would register ARI app `dialforge-app` and take each other's calls.

## App rebuild — Stage 1: backend restructure + live-update channel (2026-10-09, deployed)
- `server.js` (2,989 lines) is now a 50-line entry point. The code lives in `backend/src/`: `app.js` (createApp), 20 route modules, 9 service modules, `telephony/events.js`, `realtime/hub.js`, `middleware/auth.js`, `config.js`, `state.js`. The map is in ARCHITECTURE §6.
- **How it was split safely.** A script moved each top-level statement verbatim with its comments, and generated the require/export lines. The only text change was `app.get(` → `router.get(`. Checks:
  - AST comparison: 150/150 statements identical. The two exceptions are the deliberate live-update hooks; with those lines removed they match too.
  - Lint `no-undef` and `no-unused-vars` prove every name resolves.
  - The route list is identical: 85 old, 85 new.
  - On the server, the old and new apps ran side by side with each real user against the live DB, read-only. Every GET route was compared: **120/120 identical responses**. `/agent/extension-credentials` was skipped on purpose because it returns a SIP password.
- Small deliberate changes:
  - `ami.js` no longer connects when it is `require`d; `server.js` calls `ami.connect()` at startup instead. Same timing in production; tests can now load the app without an Asterisk.
  - `express.static` uses an absolute path to `public/`, so it no longer depends on the working directory.
  - New WebSocket `/ws` (ARCHITECTURE §8) pushes `agent.status` and `call.event`. Nothing uses it yet; it's for the React app.
- Also deployed: the Stage 0 Prettier formatting of `ari.js`, `call-control.js`, `dialer-common.js`, `dialer-engine.js` and `seed-users.js` (AST-identical). That is why `dialforge-dialer` was restarted too.
- New tests (30 total):
  - `routes.test.js`: only 4 routes are public, every `/admin` route refuses agents, no route hides another.
  - `realtime.test.js`: `/ws` needs a login, and an agent only receives their own messages.
  - `forms.test.js`: form definition and answer validation.
- Deploy:
  - Backup `~/backups/pre-stage1-20261009-131010/`: all backend files plus a DB dump. The mysqldump "PROCESS privilege… tablespaces" warning is harmless, and the dump completed.
  - 0 active calls at the time. Both services restarted, ARI apps reconnected, AMI logged in.
  - `/health` ok. Pages 200. Protected routes 401 without login. `/ws` 401 without login.
- **Rollback:** `cd ~/dialforge-backend && tar xzf ~/backups/pre-stage1-20261009-131010/backend-files.tgz && sudo systemctl restart dialforge-backend dialforge-dialer`. The old `server.js` doesn't use `src/`, so leaving `src/` in place is harmless.

## App rebuild — Stage 2: React app shell at /app (2026-10-09, deployed)
- New `web/`: React 19, TypeScript 5.9, Vite 8, Tailwind 4, shadcn-style components, React Router 7, TanStack Query 5, Vitest. Guide for developers: `docs/FRONTEND.md`.
  - TypeScript 7 and React Router 8 were skipped deliberately: typescript-eslint doesn't support TS 7 yet, and RR 7 is the well-known API.
- In the app:
  - Login (same session cookie as the classic pages).
  - Role-based routes: admins get `/app/admin/...`, agents get a page that sends them to the classic agent screen until Stage 4.
  - Admin layout with the collapsible sidebar groups; it becomes a drawer on phones.
  - A 401 anywhere returns to login. Mutation errors show as toasts.
  - Live updates over `/ws`, with automatic reconnect.
- First real screen: **Dashboard**. Stat tiles plus a Live agents table that refreshes the moment an agent changes status (`agent.status` over `/ws`), with a 15 s fallback poll. Every other menu entry shows "moving here soon" with a button to that section of the classic admin.
- Classic admin: `/admin.html#<section>` now opens that section, for those buttons. Only lowercase section names are accepted; anything else stays on the Dashboard. Checked in jsdom.
- Backend:
  - `src/webApp.js` serves `backend/web-dist` at `/app`. Hashed assets are cached for 1 year; `index.html` is `no-cache`; unknown `/app/...` URLs get `index.html`. If the app isn't built, it returns a clear 503.
  - The build output is git-ignored. Deploying means `npm run build:web` locally, then copying `backend/web-dist`.
- Checks:
  - 34 backend tests (4 new in `webapp.test.js`) and 9 React tests: login, wrong password, admin lands on the dashboard, agents can't open admin screens, sidebar groups, classic links, logout.
  - CI now also installs `web/`, type-checks, runs its tests and builds it.
- Deploy:
  - Backup `~/backups/pre-stage2-20261009-143635/`. 0 active calls; only `dialforge-backend` was restarted.
  - Results: `/app/`, `/app/admin/users` and `/app/login` → 200. The asset → 200 with `immutable`. Classic pages → 200. `/admin/campaigns` without login → 401.
- Rollback: restore `backend-files.tgz` from that backup and restart `dialforge-backend`.

## App rebuild — Stage 3: every admin screen in the React app (2026-10-09, deployed)
- Rebuilt:
  - Live Agents, Dialer, Call Log;
  - Campaigns (settings by dial mode, dispositions, recycle rules) and Queues;
  - Leads & Lists (lists, leads, xlsx/csv import, recycle) and Forms (builder, responses);
  - Callbacks, DNC, Users, Teams, Reports.
  DID Numbers was built first as the reference pattern. Every admin menu entry at `/app` now opens a rebuilt screen; the classic `/admin.html` still works.
- How: shared components first (table, dialog, tabs, form controls, ConfirmDialog…). Then four parallel helpers, each in its own feature folder with its own tests. Their code was reviewed, wired into the routes, and the full checks run here.
- Small improvements over classic:
  - Lead edit offers the campaign's own dispositions (classic hard-coded 6 codes, which the server rejected for custom ones).
  - Filters on callbacks and leads.
  - Debounced DNC search.
  - Starting a dialer asks for confirmation, because it places real calls.
- Backend hardening found on the way:
  - `GET /admin/extensions` sent every extension's `sip_password` to the browser; it now selects only `id, name, label, created_at`.
  - Queue create/edit wrote any submitted value into `queues.conf`, so a newline could inject config. They now go through `parseQueueSettings` (strategy whitelist, yes/no flags, integer ranges), with tests.
- Remaining gaps: `docs/APP_REBUILD_PLAN.md` → "Follow-ups found while rebuilding".
- Tests: 37 backend, 97 web. One heavy form test needed `testTimeout: 20000` under full parallel runs.
- Deploy: the first run of `scripts/deploy-dev.sh`.
  - Checks ran, then backup `~/backups/pre-deploy-20261009-152927/`.
  - Only `dialforge-backend` restarted; dialer code was unchanged, so the dialer was left running.
  - `/health` ok, `/app/` 200, admin APIs 401 without login.

## App rebuild — Stage 4: agent screen in the React app (2026-10-09, deployed, awaiting real-call test)
- `/app/agent`: connect line (auto-reconnect after refresh) → status menu, tiles, leads/callbacks, workspace (lead details + campaign form pre-filled from lead data), dialpad + call history, in-call panel (mute / hold / keypad / transfer / conference / consult controls), incoming-call popup with ringtone and title flash, queue picker, outcome dialog with callback scheduling.
- Design: a **softphone** module (JsSIP wrapped, testable through a UA factory) plus one **call controller** porting the classic page's workflow. See FRONTEND.md "Agent screen".
- Found while porting:
  - The classic page put `pcConfig` in the JsSIP **UA** config, which JsSIP ignores, so its softphone never used STUN/TURN; it answered with `iceServers: []`. The new one passes ICE servers to each `answer()`.
  - The TURN username and password were hardcoded in `agent.html`, so they are in git. The new screen gets them from `.env` through `GET /agent/webrtc-config`. Added `SIP_DOMAIN`, `WEBRTC_WS_URL`, `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME` and `TURN_PASSWORD` to the server `.env`; backup at `~/backups/pre-webrtc-env-20261009-102616/env.bak`. Rotation is a follow-up.
  - `/agent/extension-credentials` gave any agent any extension's SIP password. It now returns 409 when another agent holds that extension in an open session **and** it is registered in Asterisk, so a stale session doesn't lock it.
- A bug caught by the new UI test before release: "remember the extension" ran in the connect screen, which unmounts on registration, so it never ran. It was moved to the parent.
- Tests: 40 backend, 119 web (softphone 5, controller 12 call-flow cases, agent screen 5).
- Deploy:
  - `scripts/deploy-dev.sh`, backup `~/backups/pre-deploy-20261009-155623/`. The backend was restarted; the dialer was untouched.
  - Server checks: `webrtc-config` resolves correctly (TURN credential masked), the new routes return 401 without login, `/app/agent` → 200.
- **Not yet done:** real calls. The classic `/agent.html` remains what agents use until the checklist section "New agent screen" passes.

## Classic pages removed + softphone connect fix (2026-10-09)
The user tested manual dialling on the new agent screen and reported a delay, with calls sometimes not connecting. They also asked to remove the classic HTML pages.
- **Evidence:**
  - calls 40–42 on the new screen were `originated` but never `agent_answered`;
  - Asterisk's `full` log for call 42: `PJSIP/1001 is ringing`, then nothing for 20 s;
  - call 39, on the classic page, answered within 1 s.
- **Cause:** the new softphone gives the browser STUN/TURN servers (the classic one never did). JsSIP sends the 200 OK only after ICE gathering *finishes*, which takes seconds, or until a route the network blocks times out. Asterisk's originate times out after 30 s.
- **Checks:** TURN itself works. `turnutils_uclient` allocated on UDP 3478, and TLS on 443 has a valid certificate.
- **Fixes:**
  - **Softphone:** answers as soon as a TURN relay candidate is gathered, or `ICE_WAIT_MS` (1 s) after the first candidate, using JsSIP's `icecandidate` `ready()`.
  - **Server (`events.js`):** handles `ChannelDestroyed` for click-to-call legs that never entered Stasis. Before, those calls stayed open forever.
    - The agent's own line not answering → the call is closed as `agent_unanswered`, the cause is logged, and there is no ACW.
    - A customer leg that fails before answer → `busy` / `no_answer` / `rejected` / `invalid_number` / `congestion` / `failed` from the Q.850 cause. The agent's leg is hung up at once instead of being left on a silent line.
  - `/agent/call-state` now returns `disposition`.
  - **Agent screen:** says why a call didn't connect ("Your line didn't answer…", "The customer is busy.", …) and resets, instead of showing "Call started" forever.
- **Classic pages removed:** `backend/public/` (`admin.html`, `agent.html`, `login.html`, `index.html`) and every "Classic" link and placeholder in the app. `/`, `/index.html`, `/login.html`, `/admin.html` and `/agent.html` now 302 to the matching `/app` screen. The old pages are in git history and in the deploy backup.
- Tests: 44 backend (3 click-to-call teardown, 1 redirects), 123 web (2 ICE timing, 2 call-failure messages).

## TURN secured with expiring per-login credentials (2026-10-09)
- **Why:** the old fixed TURN user and password were in the classic `agent.html`, and therefore in git.
- **Change:**
  - Both coturn instances (`/etc/turnserver.conf` on 3478, `/etc/turnserver-443.conf` on TLS 443) lost their `user=` line. They now have `use-auth-secret` + `static-auth-secret=<random 32 bytes>`.
  - The same secret is `TURN_SECRET` in `.env`; `TURN_USERNAME` / `TURN_PASSWORD` were removed.
  - `/agent/webrtc-config` returns username `<expiry>:agent<id>` with password `base64(HMAC-SHA1(secret, username))`. This is coturn's "TURN REST API"; nothing is stored. TTL is `TURN_TTL_SEC`, default 12 h.
- **Verified on the server with `turnutils_uclient`:**
  - a fresh credential allocates and relays on UDP 3478 and on TLS 443;
  - the old fixed password and an expired credential are refused ("Cannot complete Allocation").
- **Backup:** `~/backups/pre-turn-secret-20261009-151619/` (both coturn configs + `.env`).
- **Rollback:** copy the two configs back to `/etc/`, restore `env.bak` to `~/dialforge-backend/.env`, then `sudo systemctl restart coturn coturn-443 dialforge-backend`.
- **Rotating the secret later:** run `openssl rand -hex 32` and put the new value in both coturn configs and `.env` (`TURN_SECRET`). Restart coturn, coturn-443 and dialforge-backend. Agents get new credentials on their next connect.

## User management: edit, password reset, deactivate (2026-10-09)
- **DB:** `migration-user-status.sql` adds `users.status` (`active` | `inactive`). It was applied on dev; backup of the `users` table at `~/backups/pre-user-status-20261009-152330/`.
- **API:**
  - `PUT /admin/users/:id` changes role, extension or status.
  - `POST /admin/users/:id/password` sets a new password.
  - Create now checks the username format, an 8+ character password, and that the extension exists.
  - Rules (`services/users.js`, tested): you can't remove your own admin access, and there is always at least one active admin.
- **Deactivate, not delete:** calls, status history, form answers and callbacks reference users. A deactivated agent is taken out of their queues like a logout, and login answers "this account is disabled".
- **Sessions end on change:** a role or status change, or a password reset, records a revocation time (`services/sessions.js`). The auth middleware drops any session that logged in before it, and that user's `/ws` connection is closed. This is in memory, which is fine: a backend restart drops every session anyway (MemoryStore).
- **Users screen:** a Status column, plus Edit, Password and Deactivate/Activate per user (no self-deactivate). Teams marks inactive agents.

## Server-side search + paging; lazy-loaded screens (2026-10-09)
- **Why:** admin lists only ever showed the newest 200 leads, 100 calls, 500 DNC numbers or 300 callbacks; anything older couldn't be found.
- **API:** one shape for all four lists, `{ rows, total, page, pageSize }` with `?page=&pageSize=` (default 50, max 200), from `services/paging.js`. In LIKE searches `%` and `_` are taken literally.
  - `GET /admin/leads?q=&campaignId=(id|none)&listId=&status=`. Also returns `statuses` for the filter. The agent's `GET /leads` is unchanged.
  - `GET /admin/calls?q=&direction=&disposition=(…|none)&extension=&from=&to=`. The agent's `GET /calls` is unchanged.
  - `GET /admin/dnc?q=`: `total` = matching the search, `all` = the whole list.
  - `GET /admin/callbacks?status=(pending|overdue|done|cancelled)&campaignId=&q=`. **This changed from a plain array.**
- **Verified before deploy:** 19 queries against the dev DB, read-only, in a localhost-only process. All returned 200 with consistent totals, and page 1 + page 2 at size 2 equal page 1 at size 4.
- **Screens:**
  - Leads, Call Log, DNC and Callbacks filter and page on the server, using the shared `Pager`, debounced search and `keepPreviousData`.
  - Any filter change returns to page 1; deleting the last row on a page steps back one page.
  - Call Log gained number, direction, outcome and date filters.
- **Lazy loading:** every screen is its own chunk (`page()` in `app/routes.tsx`). The first load went from 615 kB to 370 kB (116 kB gzipped). The softphone (JsSIP, 304 kB) loads only for agents.
- Tests: 52 backend, 133 web.

## Backend validation follow-ups + team extensions (2026-10-10)
- **Team extensions (security):** before this, any logged-in agent could fetch the SIP password of any free extension.
  - `migration-team-extensions.sql` adds `team_extensions` (team ↔ extension, cascades on delete).
  - Rule (`services/extensionGuard.js`, tested): if any of an agent's *active* teams ticks extensions, the agent may use only those plus their own assigned extension. If none does, any free extension is allowed, as before. Admins aren't limited.
  - `GET /agent/extensions` returns `{ allowed: [...] | null }`; `/agent/extension-credentials/:ext` answers 403 for an extension outside the list. The Connect screen shows a dropdown when the list exists.
  - Nothing changes on deploy: no team has extensions ticked until an admin does it in Teams.
- **Validation:**
  - Teams: unknown agent / campaign / extension ids → 400 naming them (was a generic 500). Only agents can be members. Links are inserted in one statement per table.
  - Lists: unknown campaign → 400 (was a raw foreign-key 500).
  - Leads edit: the list must belong to the chosen campaign; alt phone and priority are editable (left out = unchanged). The dialog drops the list when the campaign changes.
  - Campaigns: create takes `status` (active / paused); edit with no status keeps the current one (it used to reset to active).
- **Checked on the dev DB first (read-only):** no admins in teams, all campaigns active, no lead whose list is in another campaign, so nothing existing breaks the new rules.
- Tests: 57 backend, 134 web.

## Live Dialer screen (2026-10-10)
- **Before:** every open Dialer screen asked `GET /admin/dialer` every 3 s (3 queries each), whether anything changed or not, and start / pause / stop showed up only at the next ask.
- **Now:** `src/realtime/dialerFeed.js` in the backend reads the same overview every 2 s, only while an admin is connected on `/ws`, and publishes `dialer.status` when something other than the tick times changed. Start / pause / stop publish at once. The screen applies the push directly; its own refresh is now a 15 s safety net (also for an open hopper).
- **Engine unchanged:** `dialer-engine.js` still only writes the DB, so the deploy didn't restart `dialforge-dialer`.
- The overview query moved to `services/dialer.js` (shared by the route and the feed).
- Tests: 61 backend (feed: change detection, no-admin = no read, forced publish not lost while a read runs), 135 web (a pushed update shows without another request).

## Lead edit: campaign form fields (2026-10-10)
- **Before:** a lead's form values (`custom_data`) could only be set by import.
- **API:** `PUT /admin/leads/:id` takes `customData` ({ field_key: value }). Left out = unchanged. Values are checked against the form of the campaign the lead ends up in, with the same rules as import (`applyCustomEdits` in `services/leadImport.js`, tested). An empty value removes a field. An unknown key → 400. Saved keys that aren't on the form are kept, so moving a lead to another campaign never drops data silently. Required fields aren't enforced, as in import; the agent fills them in on the call.
- **Screen:** the Edit lead dialog shows a "Form: <name>" section with the campaign form's fields, plus a read-only line for saved values not on the form. The inputs are now one shared component (`features/forms/FieldInput.tsx`) used by both this dialog and the agent's call form.
- No DB change. Tests: 64 backend, 136 web.
- **This closes the follow-up list** from the rebuild (`docs/APP_REBUILD_PLAN.md`).

## Agent screen fixes from testing (2026-10-10)
Reported by the user after trying the agent panel:
- **Status menu unreadable:** the Available / Break menu sits inside the dark top bar and inherited its white text, so items were white on white. The menu now sets its own text colour (`text-card-foreground`).
- **Outcome after every call:** the outcome dialog only opened for calls with a lead (lead list, dialer, known inbound). Now every *answered* call of ours gets it; rejected / missed calls and a colleague's transfer offer still don't.
  - New `POST /agent/calls/:callId/disposition` (only the agent who had the call): if the call has a lead, the outcome goes on it. Otherwise the number becomes a lead in the call's campaign (or the existing lead with that number there is used), the call is linked to it (`calls.lead_id`), and the outcome is saved the same way as `/leads/:id/disposition` (shared `saveDisposition`). A bad status is refused before anything is created.
  - `/agent/active-call` now also returns calls without a lead (LEFT JOIN; phone falls back to the call's number), so an unknown inbound caller gets the call id from screen pop. If screen pop finds nothing, the screen matches the number in the agent's call history.
  - The dialog shows a retry instead of an empty list if the outcomes can't load (it can't be closed without an outcome).
- **Redial from call history:** each row in Call history has a green phone button that dials that number (`to_number` is the customer for inbound and outbound).
- Tests: 64 backend, 142 web.

## Agent extension fixed to the one assigned in Users (2026-10-10)
- **Asked by the user:** agents shouldn't choose or edit their extension; they should only see it.
- **Now:** `GET /agent/extension-credentials` (no parameter) returns the credentials of the extension assigned to the logged-in user in Users, read from the DB (not the session), so an admin change applies on the next connect. No extension assigned → 400 "ask your admin". The "in use by …" check stays, for two agents who share an extension. The old `/agent/extension-credentials/:extension` and `/agent/extensions` are gone.
- **Screen:** Connect your line shows "Your extension 1003" as text and a Connect button; a refresh still reconnects by itself. The top bar keeps showing "ext 1003". To change an agent's extension: Admin → Users → Edit.
- **Team extension lists removed:** with a fixed extension they have no purpose. They were added earlier the same day and never used (`team_extensions` had 0 rows). `migration-drop-team-extensions.sql` drops the table (backup first); the create migration was deleted, so fresh installs never have it. Teams went back to agents + campaigns.
- **Note:** on dev, agent04 and agent1003 share extension 1003, and agent02 and agent1002 share 1002. Only one of each pair can be connected at a time.
- Tests: 62 backend, 139 web.

## Admin roles: Super Admin, TL, supervisor (2026-10-10)
- **Asked by the user:** admin logins for Team Leaders / supervisors with only the rights the Super Admin gives them, and (user's choice) per role: own team only, or all teams.
- **Design:** `docs/adr/0005-admin-roles-and-team-scope.md`. Account types: Super Admin (`users.role = 'admin'`, everything), staff (`'staff'` + `users.role_id`), agent. A role sets None / View / Manage for each of the 14 admin screens, and its scope (all teams / own teams).
- **DB:** `migration-roles.sql` adds `roles` and `users.role_id` (applied on dev after a full backup; nothing changes on deploy, as no roles exist yet).
- **Server:** every admin route now uses `requirePermission(screen, level)`. Team scope is applied in the SQL of dashboard, live agents, dialer (overview, actions, hopper), call log, campaigns, lists, leads (incl. import, template), recycle, callbacks, reports, form responses, users and teams. Out-of-scope rows answer 404. Team-scoped roles can't create or delete campaigns, manage users or change teams. Only a Super Admin manages roles and admin-side accounts. Agent routes refuse staff logins. `/auth/me` returns `roleName`, `scope` and `permissions`. `/ws` messages are filtered per staff connection.
- **Screens:** new **Roles** screen (Super Admin only) with a None / View / Manage grid. Users has an **Account type** (Agent / Admin with a role / Super Admin) and a Role column. Teams has a **Team leaders & supervisors** list (that's how a TL gets "their" team). The menu shows only the role's screens, change buttons are hidden for View, and a typed-in screen outside the role says so. The header shows the role (e.g. "Team Leader · own teams").
- Tests: 71 backend (incl. `access.test.js`: real routes against a fake DB, as staff and team-scoped roles), 151 web.

## Admin roles: per-action rights instead of "Manage" (2026-10-10)
- **Reported by the user:** gave a role Campaigns "Manage", but the test login couldn't create campaigns; wanted None / View / Create / Edit / Delete-style options instead of Manage.
- **Cause (data on dev, read-only):** the role "Tesssss" was saved as *Their own teams* (the dialog's default then), and its login Test_TL was in no team. An own-teams role isn't allowed to create campaigns or manage users, and with no team it sees no data, so every button was hidden, without saying why.
- **Fixes:**
  - Rights are now **actions per screen**: View, Create, Edit, Delete + Dialer Start/Pause/Stop, Leads Import / Recycle, Callbacks Cancel, Users Reset password, Reports Export CSV. Every admin route checks its own action (e.g. `DELETE /admin/campaigns/:id` needs Campaigns Delete). CSV export now needs Reports Export.
  - Stored as `{ screen: [actions] }`. Older rows (`'view'`/`'manage'`) are read as View / every action, so no DB change was needed.
  - New roles default to **All teams**. Actions an own-teams role can't have are locked in the grid with the reason, and the server refuses to save them (no silent dropping).
  - An own-teams login in no team sees a note: "You're not in any team yet".
  - Role changes reach open screens within ~30 s (`/auth/me` re-checked every 60 s, stale after 30 s), without logging out.
- **Roles screen:** a tick grid (screens down; View / Create / Edit / Delete across; screen-specific actions in "More"), plus "View everything" and "Clear".
- Tests: 71 backend, 154 web.

## Audit log, logins in MySQL, force logout, auto cleanup, DB check (2026-10-11)
- **Asked by the user:** be able to verify everything from the DB; fix stuck live agents.
- **DB audit first (read-only, 32 checks):** 30 OK. Open items: two extensions shared by two agents each (fix in Users); lead 15 status `abandoned` (system result, expected). agent1002's ACW row from 30 Sep (id 81) was found closed before the change.
- **`migration-audit-sessions.sql`** (applied on dev after a full backup): `audit_log` and `sessions`.
- **Audit log** (`src/services/audit.js`): `auditMiddleware` records every POST / PUT / DELETE under `/admin` after it finishes - user, action name (`campaigns.edit`, `users.password`, `leads.import`, `campaigns.dialer`...), record + id, HTTP status (refused ones too, with the reason), request body, and the row before / after. Passwords and SIP passwords are never stored. Plus `auth.login` / `auth.login_failed` / `auth.login_refused` / `auth.logout`, `leads.outcome` for every agent outcome, `agent.auto_logout`. New **Audit Log** screen (right: Audit Log → View, all-teams roles only).
- **Logins in MySQL** (`src/services/sessionStore.js`, ~60 lines, no new package): a deploy or restart no longer logs everyone out. Ending a user's sessions also deletes their rows. (The deploy that introduced it logged everyone out once.)
- **Force logout** on Live Agents (`POST /admin/live-agents/:id/logout`, right: Live Agents → Force logout): closes the status, removes them from the Asterisk queue, frees a preview lead, ends their login. Refused during a call.
- **Automatic cleanup** (`startStaleAgentCleanup`): every minute; Available / Break / ACW with the line unregistered for `STALE_AGENT_MINUTES` (10) → offline. Skipped during a call and when ARI doesn't answer (new `ari.endpointState`: online / offline / unknown).
- **`npm run db:check`** (`src/tools/db-check.js`): the 33 read-only checks, OK / CHECK per item.
- Tests: 77 backend (`audit.test.js`: audit rows incl. refused + hidden passwords, force logout incl. during a call, stale sweep incl. ARI hiccup and coming back, session store), 158 web.
