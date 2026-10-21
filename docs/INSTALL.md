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
   | 3000 | TCP | anywhere (or the client's offices) | the app |
   | 8089 | TCP | same as 3000 | agents' browser phones (WebSocket) |
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
5. An external uptime check on `https://<domain>:3000/health`.

## 5. Updates later

From your PC: `DEPLOY_HOST=ubuntu@<client-ip> DEPLOY_KEY=client.pem bash scripts/deploy-dev.sh`
(backup, migrations, restart, health check, rollback hint - same as dev).
Dialplan file changes (`backend/asterisk/*.conf`) are copied by hand:
`sudo install -o root -g asterisk -m 640 <file> /etc/asterisk/ && sudo asterisk -rx 'dialplan reload'`.

## Notes
- The app runs as the `ubuntu` user (as on dev). On AWS that user has password-free sudo,
  which the nightly backup uses to copy `/etc/asterisk`.
- Internal names stay `dialforge` (folder, services, Asterisk app names) on every server,
  so the same scripts and docs work everywhere.
