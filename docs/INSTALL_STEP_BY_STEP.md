# VIZTEX on a new server - step by step (practice install)

A fresh, standalone VIZTEX (one server: database, Asterisk, app) on a new
AWS instance, done by you, with **what each step does, why, and how to check
it**. Follow it top to bottom; tick each step. Short reference versions:
[INSTALL.md](INSTALL.md) (installer) and [CLIENT_PLAYBOOK.md](CLIENT_PLAYBOOK.md)
(a real client).

**Time:** about 2-3 hours the first time (45 min of it is waiting for Asterisk to compile).
**Cost:** the instance costs roughly ₹7-10 per hour while it runs, plus a small
charge for the Elastic IP and disk. Check the AWS pricing page for the exact
amounts. Delete everything at the end (step 12) unless you keep it.

```
What you are building - everything on ONE server:

  Agents' browsers ──https:3000──► VIZTEX app (screens, API)  ─┐
         │                         Dialer engine                │ MySQL (data)
         └──wss:8089 + audio────► Asterisk (calls, queues) ─────┘
                                  coturn (TURN: audio through office NAT)
  SIP trunk (provider) ──5060───► Asterisk
```

---

## 0. Before you start

- [ ] AWS console login, region **Asia Pacific (Mumbai) ap-south-1**.
- [ ] Your free DDNS account (the one that gave you `dialforge.ddnsfree.com`)
      - you'll point a name like `dialforgetest.ddnsfree.com` at the new server.
- [ ] On your PC: the repo `C:\Users\User01\DialForge`, **Git Bash**, on branch `main` with nothing uncommitted.
- [ ] Your office/home public IP (Google "what is my ip") - for the SSH rule.

> **Why a domain name?** Browsers only allow the microphone and the agents'
> phone connection (WebSocket over TLS) on **https** with a valid certificate.
> The certificate (free, Let's Encrypt) needs a DNS name pointing at the server.

---

## 1. Create the server (AWS EC2)

EC2 → **Launch instance**:

| Setting | Value | Why |
|---|---|---|
| Name | `viztex-practice` | so you can find it (and delete it later) |
| AMI | **Ubuntu Server 24.04 LTS** (64-bit x86) | the installer is written for it |
| Instance type | **c7i-flex.large** (2 vCPU, 4 GB) | enough for ~20 agents; *not* t2/t3 - they slow down when CPU credits run out, which breaks call audio |
| Key pair | **Create new** → `viztex-practice` → `.pem` → save to `Documents` | the only way into the server; keep it safe |
| Network | default VPC, **auto-assign public IP: enable** | |
| Security group | create new: `viztex-practice-sg` (rules in step 2) | |
| Storage | **30 GB gp3** | system + Asterisk build + recordings |

- [ ] Launched, state **Running**.

## 2. Open the right ports (security group)

EC2 → Security groups → `viztex-practice-sg` → **Edit inbound rules**:

| Type | Port | Source | Used for |
|---|---|---|---|
| SSH | 22 | **My IP** | you, to log in (never "anywhere") |
| Custom TCP | 80 | 0.0.0.0/0 | Let's Encrypt checks the domain on port 80 (certificate + renewals) |
| Custom TCP | 3000 | 0.0.0.0/0 | the VIZTEX app (admin + agent screens) |
| Custom TCP | 8089 | 0.0.0.0/0 | agents' browser phones (WebSocket to Asterisk) |
| Custom TCP | 3478 | 0.0.0.0/0 | TURN (audio for agents behind NAT/firewalls) |
| Custom UDP | 3478 | 0.0.0.0/0 | TURN |
| Custom UDP | 10000-20000 | 0.0.0.0/0 | call audio (RTP) |
| Custom UDP | 49152-49300 | 0.0.0.0/0 | TURN relay audio |

**Never open 3306 (MySQL) or 5038 (Asterisk AMI)** - they stay inside the server.
UDP 5060 (SIP trunk) is opened later, only to the provider's IP (step 10).

- [ ] Rules saved.

## 3. A fixed address (Elastic IP)

EC2 → **Elastic IPs** → Allocate → select it → **Associate** → instance `viztex-practice`.

Why: the normal public IP changes when the instance stops/starts. Asterisk
tells callers and browsers this address, and DNS points at it - it must never change.

- [ ] Note the Elastic IP: `____________`

## 4. Point the domain at it (DNS)

In your DDNS account: set `dialforgetest.ddnsfree.com` (or a new name) → the Elastic IP.

Check from your PC (Git Bash or CMD) - wait until it shows the Elastic IP (can take a few minutes):
```
nslookup dialforgetest.ddnsfree.com
```
- [ ] `nslookup` shows the Elastic IP.

## 5. Build the package (your PC)

Git Bash, in the repo:
```
cd /c/Users/User01/DialForge
git checkout main && git pull
bash scripts/make-release.sh
```
What it does: runs all checks (lint + tests, ~10 min), builds the web app,
and packs what a server needs - backend code, built screens, database
migrations, Asterisk dialplan files, installer scripts - into
`dist/viztex-<date>-<commit>.tgz`. Never your `.env`, secrets or logs.

- [ ] Ends with `package: dist/viztex-....tgz`.

## 6. Copy it to the server and log in

```
cd /c/Users/User01/DialForge
scp -i ~/Documents/viztex-practice.pem dist/viztex-*.tgz ubuntu@<ELASTIC-IP>:~
ssh -i ~/Documents/viztex-practice.pem ubuntu@<ELASTIC-IP>
```
First time it asks "Are you sure you want to continue connecting?" → `yes`.

On the server:
```
tar xzf viztex-*.tgz        # unpacks to ~/viztex
ls viztex                   # app  install  VERSION
lsb_release -d              # Ubuntu 24.04...
```
- [ ] You are logged in and see `app install VERSION`.

## 7. Run the installer (inside tmux)

The install takes 30-45 minutes. If your SSH connection drops, a normal
command would stop half-way - **tmux** keeps it running on the server.

```
tmux new -s install
sudo bash viztex/install/install.sh --domain dialforgetest.ddnsfree.com --admin boss --email <your email>
```
- Disconnected? Log in again and `tmux attach -t install`.
- Want to watch the detail? Second SSH window: `sudo tail -f /var/log/viztex-install.log`

### What the 9 stages do (read while it runs)

| Stage | What it does | Why | Check it yourself afterwards |
|---|---|---|---|
| **Preflight** | Checks Ubuntu 24, RAM, disk; finds the public + private IP; checks DNS points here; creates the secrets file `/etc/viztex/secrets.env` (random passwords for DB, ARI, AMI, sessions, TURN) | every server gets its own passwords; nothing is copied from dev | `sudo ls -l /etc/viztex/` (secrets.env, root only) |
| **1 Packages** | `apt` upgrade + build tools, MySQL, coturn, certbot, ffmpeg, ODBC driver; Node.js 24 | everything the other steps need | `node -v`, `mysql --version` |
| **2 Asterisk** | Downloads Asterisk 22, compiles it with ODBC realtime, AMD (answering-machine detection) and MixMonitor (recording) | Ubuntu's own Asterisk package is old and lacks what VIZTEX uses | `sudo asterisk -V` |
| **3 Database** | Creates database `viztex`, user `dialforge` (the app, full rights) and `asterisk_rt` (Asterisk, **read-only**) | Asterisk reads extensions/queues from MySQL but can never change data | `sudo mysql -e "show databases"` |
| **4 App** | Copies the app to `~/dialforge-backend`, writes `.env` (settings + generated secrets), installs Node packages, **runs the database migrations** (creates every table), gives `asterisk_rt` read access to 4 views, creates your Super Admin | the app is now ready, with an empty database | `cd ~/dialforge-backend && ls`, `npm run db:check` |
| **5 Asterisk config** | Writes `pjsip.conf` (WSS for browsers + UDP for the trunk, **NAT: tells the world the public IP**), `extensions.conf` (dialplan: `[internal]`, `[from-trunk]` → the app, `[queue-dispatch]`), `rtp.conf` (audio ports 10000-20000), `http.conf` (WSS on 8089), `ari.conf` + `manager.conf` (how the app controls Asterisk, AMI only on 127.0.0.1), ODBC + realtime (`res_odbc`, `extconfig`, `sorcery`), a systemd service | this is the wiring between Asterisk, MySQL and the app | `sudo ls /etc/asterisk/*.viztex-orig` (the originals it replaced are kept) |
| **6 TURN** | coturn on 3478 with a shared secret the app also knows | agents behind office firewalls still get audio | `systemctl status coturn` |
| **7 Certificate** | Let's Encrypt certificate for your domain (port 80), copied for Asterisk (8089) and the app (3000); renews itself | https + wss are required by browsers | `sudo certbot certificates` |
| **8 Services** | systemd services: `asterisk`, `dialforge-backend` (app), `dialforge-dialer` (dialer engine), nightly backup timer, recording conversion, log rotation; starts them | they start on boot and restart if they crash | `systemctl status dialforge-backend` |
| **9 Checks** | Tests each piece (next table) | proves it all works together | - |

### The result

The end prints the URL, `Super Admin: boss` and a **one-time password** -
copy it now, it is shown only once. Then the checks:

| Check | Means |
|---|---|
| Asterisk running | the phone system is up |
| Asterisk HTTPS / WebSocket on 8089 | agents' browser phones can connect |
| Asterisk reads MySQL (ODBC) | extensions/queues you create in the app reach Asterisk |
| AMD, MixMonitor, realtime modules | dialer AMD, recording and realtime config loaded |
| TURN server | NAT audio relay up |
| MySQL | database up |
| backend /health | the app runs and reaches the database |
| Backend connected to Asterisk (ARI) | the app can place and control calls |
| Dialer engine running | predictive/progressive dialing ready |
| Nightly backup scheduled | backups every night |
| Certificate valid | https works for your domain |

- [ ] **All checks OK.** (A FAIL names the step - see "If something fails" below. Fix, then run the same install command again: finished steps are skipped, secrets kept.)
- [ ] Super Admin password copied.

Leave tmux with `exit` when done.

## 8. First login

Browser: `https://dialforgetest.ddnsfree.com:3000` → log in as `boss` with the one-time password → **change the password**.

- [ ] Logged in, password changed.

## 9. Set up a small center

On the server (SSH):
```
# Licence: who, how many agents at once, how many lines, until when
sudo bash ~/viztex/install/set-licence.sh --customer "Practice" --seats 5 --channels 4 --expires 2026-12-31

# Agent extensions (seats) - only the provider adds these
cd ~/dialforge-backend && npm run ext:add -- --from 1001 --count 5
```
Then in the app, in this order (each needs the one before):
1. **Forms** → a form (e.g. Name, Last name, Amount).
2. **Queues** → a queue (e.g. `practice_q`).
3. **Campaigns** → a campaign: Main queue `practice_q`, the form, Dial mode **Manual** (or Inbound).
4. **Users** → 2 agents (`agent1001` → extension 1001, `agent1002` → 1002).
5. **Teams** → a team with both agents, campaign mapped.

- [ ] Licence set, 5 extensions, form, queue, campaign, 2 agents, team.

## 10. Test calls

**Without a trunk (always possible):** two browsers (or one normal + one
private window), log in as `agent1001` and `agent1002`, Connect, go Available.

On the server, both phones should be registered:
```
sudo asterisk -rx "pjsip show contacts"     # 1001 and 1002: Avail
```
- [ ] agent1001 dials **1002** on the dialpad → it rings → answer → talk both ways (audio both directions).

**With a trunk:** a provider allows only the IPs it knows. The nxtra test
trunk only knows the dev server's IP, so it will NOT work here unless the
provider adds this server's Elastic IP. With a trunk that allows this IP:
```
sudo bash ~/viztex/install/add-trunk.sh --host <provider-ip> --caller-id <your DID> --channels 4
```
then open **UDP 5060 to the provider's IP only** in the security group, map
the DID to the queue (**DID Numbers**), and test an outbound call and a call
to the DID.

## 10b. Alerts to your phone (Telegram)

The server checks itself every minute (database, Asterisk, trunk, dialer,
disk, certificate, licence, backups, ...) and messages you when something
breaks, reminds you every 2 hours while it stays broken, and sends an
"all OK" summary every morning. Full steps: `backend/ops/README.md` → Alerts.

1. Telegram → **@BotFather** → `/newbot` → copy the token.
2. Open your bot → **Start**.
3. `nano ~/dialforge-backend/.env` → `TELEGRAM_BOT_TOKEN=<token>`
4. `cd ~/dialforge-backend && npm run alert:test -- --find-chat` → copy the `TELEGRAM_CHAT_ID=...` line into `.env`.
5. `npm run alert:test` → a test message on your phone.
6. `sudo systemctl restart dialforge-backend`

- [ ] Test alert received on your phone.

## 11. Look around (learn the server)

| Command | Shows |
|---|---|
| `systemctl status asterisk dialforge-backend dialforge-dialer` | the 3 main services |
| `tail -f ~/dialforge-backend/server.log` | what the app does (calls, errors) |
| `sudo asterisk -rvvv` | Asterisk console live (exit: `exit`) |
| `sudo asterisk -rx "pjsip show endpoints"` | extensions + trunk |
| `sudo asterisk -rx "queue show"` | queues and who is in them |
| `sudo asterisk -rx "core show channels"` | calls happening now |
| `sudo sngrep` (install: `sudo apt install sngrep`) | SIP messages of each call, as a diagram |
| `cd ~/dialforge-backend && npm run db:check` | database health checks |
| `ls /var/spool/asterisk/monitor/dialforge/` | recordings |
| `systemctl list-timers dialforge-backup.timer` | next backup |

## 12. When you're done: delete (stops the cost)

1. EC2 → instance → **Terminate**.
2. Elastic IPs → **Release** (an unused Elastic IP is still charged).
3. Optional: delete the security group and the key pair.
4. Point the DDNS name somewhere else or leave it.

- [ ] Terminated + Elastic IP released (or kept on purpose).

---

## If something fails

| Symptom / failed check | Usual cause | Fix |
|---|---|---|
| "resolves to ..., not this server" | DNS not pointing at the Elastic IP yet | step 4, wait, `nslookup` again |
| Certificate step fails | port 80 closed, or DNS wrong | step 2 rule for 80; step 4 |
| Asterisk compile fails | ran out of memory/disk (t3.micro, 8 GB disk) | bigger instance / 30 GB disk, run again |
| "Asterisk reads MySQL (ODBC)" FAIL | ODBC/realtime config | `sudo asterisk -rx "odbc show"`; send me the log lines |
| App page doesn't open | port 3000 closed or app down | security group; `systemctl status dialforge-backend`; `tail ~/dialforge-backend/server.log` |
| Agent phone won't connect | 8089 closed, or certificate | security group; open `https://<domain>:8089/ws` in the browser once |
| Call connects but no audio / one-way audio | UDP 10000-20000 or TURN ports closed | step 2 UDP rules |
| SSH "Permission denied (publickey)" | wrong key / user | `-i ...viztex-practice.pem`, user `ubuntu` |

Full install log: `/var/log/viztex-install.log` (the last lines say which step failed).
