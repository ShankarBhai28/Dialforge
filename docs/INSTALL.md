# Installing VIZTEX for a new client

The whole client procedure (what to collect, AWS, setup, go-live, many servers) is [CLIENT_PLAYBOOK.md](CLIENT_PLAYBOOK.md); this page is the installer. First time? [INSTALL_STEP_BY_STEP.md](INSTALL_STEP_BY_STEP.md) walks through it with what each step does and how to check it.

One server per client: its own database, Asterisk and app. The installer does
everything `DEPLOY.md` describes by hand; DEPLOY.md stays as the explanation
of each piece.

## 1. The server (AWS, about 15 minutes of clicking)

1. **EC2 -> Launch instance**: Ubuntu Server **24.04**, at least **t3.medium**
   (2 vCPU, 4 GB) for up to ~20 agents; bigger for more (size it with a load
   test). Disk: 30 GB + about 3.6 GB a day of recordings per 50 agents (or S3).
   Key pair: create one per client and keep it safe - it is the only way in.
2. **Elastic IP**: allocate and associate it (the address must never change).
3. **Security group** (inbound):

   | Port | Protocol | From | For |
   |---|---|---|---|
   | 22 | TCP | your office IP only | SSH |
   | 80 | TCP | anywhere | certificate (Let's Encrypt) |
   | 443 | TCP | anywhere (or the client's offices) | the app (`https://<domain>`, no port in the address) |
   | 3000 | TCP | same as 443 | old `:3000` links - redirected to 443 |
   | 8089 | TCP | same as 443 | agents' browser phones (WebSocket) |
   | 3478 | TCP + UDP | anywhere | TURN |
   | 10000-20000 | UDP | anywhere | call audio |
   | 49152-49300 | UDP | anywhere | TURN relay |
   | 5060 | UDP | the SIP provider's IP only | trunk (after add-trunk) |

   Never open 3306 (MySQL) or 5038 (AMI).
4. **DNS**: a name for the client (e.g. `client.yourdomain.com` or a free DDNS
   name) pointing at the Elastic IP. Check: `nslookup client.yourdomain.com`.

## 2. Build the package (your PC, repo root, Git Bash)

```
bash scripts/make-release.sh        # checks, builds the web app -> dist/viztex-<date>-<commit>.tgz
```

## 3. Install (about 30-45 minutes, mostly compiling Asterisk)

```
scp -i client.pem dist/viztex-*.tgz ubuntu@<elastic-ip>:~
ssh -i client.pem ubuntu@<elastic-ip>
tar xzf viztex-*.tgz
sudo bash viztex/install/install.sh --domain client.yourdomain.com --admin boss --email you@yourcompany.com
```

Options: `--timezone Asia/Kolkata` (reports' "today"), `--name VIZTEX` (name
in alerts), `--self-signed` (test without DNS / certificate - `--domain` may
then be the IP), `--firewall` (also open the ports in ufw - for non-AWS
servers). `sudo bash viztex/install/install.sh --help` lists everything.

At the end it prints **the URL, the Super Admin login and its one-time
password** and runs these checks: Asterisk up, HTTPS/WebSocket on 8089,
Asterisk reading MySQL (ODBC), AMD / MixMonitor / realtime modules, TURN,
MySQL, app /health, app connected to Asterisk, dialer engine, nightly backup
timer, certificate. A failure names the step; the full log is
`/var/log/viztex-install.log`.

**Safe to run again** (after fixing DNS, a port, ...): finished steps are
skipped, generated secrets are kept (`/etc/viztex/secrets.env`, root only),
and every config file it replaces is kept as `<file>.viztex-orig`.

What it sets up:
- MySQL database `viztex`, users `dialforge` (app) and `asterisk_rt` (read-only, 4 views).
- Asterisk 22 from source (ODBC realtime, AMD, MixMonitor), its own user, systemd unit;
  `pjsip.conf` (WSS + UDP transports, NAT for the Elastic IP), dialplan (`[internal]`,
  `[from-trunk]`, `[queue-dispatch]` + the dialer / call-control / monitoring files),
  ARI and AMI users with generated passwords.
- coturn with a generated shared secret (`TURN_SECRET`).
- Let's Encrypt certificate + renewal hook (`/usr/local/bin/viztex-cert-copy`).
- The app in `~/dialforge-backend` with `.env` (all secrets generated), migrations,
  the first Super Admin; services `dialforge-backend`, `dialforge-dialer`,
  nightly `dialforge-backup.timer`, recording conversion, log rotation.

## 4. Set up the client (in the app)

1. Log in as the Super Admin, change the password.
2. **Licence** first: `sudo bash viztex/install/set-licence.sh --customer "<name>" --seats 10 --channels 15 --expires 2026-12-31`
   (details: CLIENT_PLAYBOOK section 6).
   Seats = agents logged in at once (enforced at login). **Extensions**: only you add them, on the server
   (the app has no Add button, and the API refuses it):
   `cd ~/dialforge-backend && npm run ext:add -- --from 1001 --count 10`
   (`--list` shows what exists). **Users** -> agents (each with an
   extension), staff with roles. **Teams**, **Queues**, **Campaigns**, lists.
3. **The SIP trunk** - when the provider has given its details:
   ```
   sudo bash ~/viztex/install/add-trunk.sh --host <provider-ip> --caller-id <did> --channels <limit>
   # username/password trunks: add --username U --password 'P' --register
   ```
   Then give the provider the Elastic IP, open UDP 5060 to their IP, and map
   DIDs to queues (DID Numbers; campaigns that have the queue take its calls).
4. Alerts (Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, test with `npm run alert:test`) and off-server backups (`BACKUP_S3_BUCKET`) in
   `~/dialforge-backend/.env` (see `backend/ops/README.md`), then
   `sudo systemctl restart dialforge-backend`.
5. An external uptime check on `https://<domain>/health` (steps: `backend/ops/README.md`).

## 5. Updates later

From your PC: `DEPLOY_HOST=ubuntu@<client-ip> DEPLOY_KEY=client.pem bash scripts/deploy-dev.sh`
(backup, migrations, restart, health check, rollback hint - same as dev).
Dialplan file changes (`backend/asterisk/*.conf`) and the recording script are updated by the deploy when they
changed (`ops/update-telephony.sh`, old files kept in the deploy's backup folder; calls are not affected).

## Notes
- The app runs as the `ubuntu` user (as on dev). On AWS that user has password-free sudo,
  which the nightly backup uses to copy `/etc/asterisk`.
- Internal names stay `dialforge` (folder, services, Asterisk app names) on every server,
  so the same scripts and docs work everywhere.

## One customer on three servers (Phase 1)

For a bigger customer (~30-150 agents): database, telephony and app each on their own server, in one VPC.
**Not rehearsed yet** (Phase 1 step 6) - try it on temporary servers before a customer.

| Server | Size (~100 agents, estimate) | Name in DNS | Open to the internet |
|---|---|---|---|
| DB | 2 vCPU / 8 GB | none needed | nothing (SSH from your IP) |
| Telephony | 4 vCPU / 8 GB | `sip.client.com` | TCP 8089, 80, 3478; UDP 3478, 10000-20000, 49152-49300; UDP 5060 from the provider only |
| App | 2 vCPU / 4 GB | `crm.client.com` | TCP 443, 3000, 80 |

Private network rules (security groups): DB TCP 3306 only from the app and telephony servers; telephony TCP 8088 (ARI) and 5038 (AMI) only from the app server.

In this order (the same package unpacked on each server; `<...>` = private IPs):
```
# 1. DB server - makes the shared secrets
sudo bash viztex/install/install.sh --role db --app-ip <app> --telephony-ip <tel>
sudo cat /etc/viztex/secrets.env        # copy to the other two as ~/secrets.env (over SSH, never chat/email)

# 2. Telephony server
sudo bash viztex/install/install.sh --role telephony --domain sip.client.com --email you@x.com \
  --db-ip <db> --app-ip <app> --secrets ~/secrets.env

# 3. App server
sudo bash viztex/install/install.sh --role app --domain crm.client.com --admin boss --email you@x.com \
  --db-ip <db> --telephony-ip <tel> --telephony-domain sip.client.com --secrets ~/secrets.env

# 4. Telephony server again: its database check passes now that the app made the tables
sudo bash viztex/install/install.sh --role telephony --domain sip.client.com --email you@x.com \
  --db-ip <db> --app-ip <app> --secrets ~/secrets.env --checks-only
rm ~/secrets.env                          # on the telephony and app servers
```
Licence, extensions (`set-licence.sh`, `npm run ext:add`) and the trunk: licence and extensions on the app server, `add-trunk.sh` on the telephony server. Recordings: set `BACKUP_S3_BUCKET` on the app server and give the telephony and app servers an IAM role for the bucket - the app plays recordings from S3. 

**Alerts and backups of the other servers:** the telephony and DB servers check their own services, disk and memory every minute (`viztex-server-health.timer`) and alert the same Telegram bot - put the app's `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` into `/etc/viztex/server.env` on each (test: `sudo bash /opt/viztex/ops/server-health.sh --verbose`). The telephony server backs up its Asterisk/TURN config and syncs recordings every night (set `BACKUP_S3_BUCKET` there too); the app server's backup dumps the database over the network.

**Updates:** `DEPLOY_HOST=ubuntu@<app> DEPLOY_TELEPHONY_HOST=ubuntu@<telephony> DEPLOY_KEY=<key> bash scripts/deploy-dev.sh` - checks for calls on the telephony server, deploys the app, then updates the telephony server's dialplan files, recording script and ops scripts (only what changed, old files kept).
