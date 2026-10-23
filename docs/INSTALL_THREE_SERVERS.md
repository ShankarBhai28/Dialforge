# VIZTEX on three servers - step by step (one bigger customer)

One customer's VIZTEX split over **three servers** - database, telephony and
app - with **what each step does, why, and how to check it**. Written from the
rehearsal of 22 Oct 2026 (RUNBOOK: "Phase 1 step 6"). For a small customer use
the one-server guide instead: [INSTALL_STEP_BY_STEP.md](INSTALL_STEP_BY_STEP.md).
Short reference: [INSTALL.md](INSTALL.md) → "One customer on three servers".

**When:** a customer of roughly 30-150 agents; below that one server is cheaper and simpler.
**Time:** about 2-3 hours (30 min of it is Asterisk compiling on the telephony server).
**Cost:** three servers instead of one; a 2-3 hour practice session with three small
instances is roughly ₹50-80 - check the AWS pricing page. Delete practice servers
at the end (step 14).

```
                    Internet
   agents' browsers │                      │ SIP trunk (provider)
        https 443   │       wss 8089, audio│ 5060 (provider IP only)
                    ▼                      ▼
   ┌───────────────────────┐    ┌──────────────────────────────┐
   │ APP     crm.client.com│───►│ TELEPHONY     sip.client.com │
   │ VIZTEX app + dialer   │ARI │ Asterisk, TURN, recordings   │
   │                       │AMI │                              │
   └──────────┬────────────┘    └───────────────┬──────────────┘
              │      private network only        │ (ODBC, read-only)
              ▼                                  ▼
   ┌─────────────────────────────────────────────────────────┐
   │ DB   MySQL: this customer's data. No web page, no public │
   │      port - only the app and telephony servers reach it. │
   └─────────────────────────────────────────────────────────┘
```

Order matters: **DB first** (it makes the shared passwords), then
**telephony**, then **app** (it creates the tables), then one re-check on the telephony server.

---

## 0. Before you start

- [ ] AWS console, region **Asia Pacific (Mumbai) ap-south-1**.
- [ ] Two DNS names you control. For a customer: their own domain (e.g. `crm.client.com`
      and `sip.client.com`). Practice only: free DDNS names - **never for a customer**:
      Google flagged a free `duckdns.org` name with a login page as phishing.
- [ ] Your PC: the repo on `main`, nothing uncommitted, Git Bash.
- [ ] Fill this in as you go (you need it in later steps):

| | DB | Telephony | App |
|---|---|---|---|
| Private IP (172.31.…) | | | |
| Public / Elastic IP | (public, for SSH) | | |
| DNS name | - | `sip.…` | `crm.…` |

## 1. Three security groups (empty first)

EC2 → **Security Groups** → **Create security group**, three times, default VPC,
**no rules yet**: `<name>-app-sg`, `<name>-tel-sg`, `<name>-db-sg`.

Why empty first: the rules point at each other ("only from the app server's
group"), so all three must exist before any rule can name them.

## 2. The rules

Select a group → **Inbound rules** → **Edit inbound rules** → **Add rule**. For
"from another group", type `sg-` in Source and pick it by name.

**app-sg** - what people open:
| Type | Port | Source | For |
|---|---|---|---|
| SSH | 22 | My IP | you |
| HTTP | 80 | Anywhere-IPv4 | certificate (Let's Encrypt) |
| HTTPS | 443 | Anywhere-IPv4 | the app |
| Custom TCP | 3000 | Anywhere-IPv4 | old `:3000` links (redirected) |

**tel-sg** - phones and call audio:
| Type | Port | Source | For |
|---|---|---|---|
| SSH | 22 | My IP | you |
| HTTP | 80 | Anywhere-IPv4 | certificate |
| Custom TCP | 8089 | Anywhere-IPv4 | agents' browser phones |
| Custom TCP + Custom UDP | 3478 | Anywhere-IPv4 | TURN |
| Custom UDP | 10000-20000 | Anywhere-IPv4 | call audio |
| Custom UDP | 49152-49300 | Anywhere-IPv4 | TURN relay audio |
| Custom TCP | 8088 | **app-sg** | the app controls calls (ARI) |
| Custom TCP | 5038 | **app-sg** | the app controls queues (AMI) |
| Custom UDP | 5060 | the provider's IP | SIP trunk (later, step 11) |

**db-sg** - nothing public:
| Type | Port | Source | For |
|---|---|---|---|
| SSH | 22 | My IP | you |
| MySQL/Aurora | 3306 | **app-sg** | the app's data |
| MySQL/Aurora | 3306 | **tel-sg** | Asterisk reads extensions and queues |

- [ ] Three groups with their rules. **Never** open 3306, 8088 or 5038 to "Anywhere".

## 3. One key pair

EC2 → **Key Pairs** → **Create key pair** → `.pem` → save in `Documents`. The three
servers share it; for a customer, one key per customer.

## 4. Three servers

EC2 → **Launch instance**, three times:

| Setting | DB | Telephony | App |
|---|---|---|---|
| AMI | Ubuntu Server 24.04 LTS (x86) | same | same |
| Type (practice) | c7i-flex.large | c7i-flex.large | c7i-flex.large |
| Type (~100 agents, estimate) | 2 vCPU / 8 GB | 4 vCPU / 8 GB | 2 vCPU / 4 GB |
| Network | default VPC, **the same subnet for all three**, auto-assign public IP: Enable | same | same |
| Security group | db-sg | tel-sg | app-sg |
| Disk | 20-30 GB | 30 GB + recordings | 30 GB |

Size the telephony server with a load test before a real customer (recording and
call count drive its CPU).

- [ ] Write each server's **Private IPv4 address** in the table in step 0.

## 5. Fixed addresses and names

- **Elastic IPs**: allocate two, associate with **telephony** and **app**. The DB server needs
  none (its normal public IP is only for your SSH).
- **DNS**: `sip.…` → telephony's Elastic IP, `crm.…` → app's Elastic IP.

Check from your PC until both show the right address:
```
nslookup sip.client.com
nslookup crm.client.com
```
- [ ] Both names resolve to the right Elastic IP.

## 6. Build the package and copy it to all three (your PC)

```
cd /c/Users/User01/DialForge
git checkout main && git pull
bash scripts/make-release.sh          # prints the package name, e.g. dist/viztex-20261023-1d59009.tgz
PKG=dist/viztex-20261023-1d59009.tgz   # <- the name it printed (dist/ keeps older ones too)
for s in "<db-key>.pem <db-public-ip>" "<tel-key>.pem <tel-elastic-ip>" "<app-key>.pem <app-elastic-ip>"; do
  set -- $s
  scp -i ~/Documents/$1 $PKG ubuntu@$2:~ &&
  ssh -i ~/Documents/$1 ubuntu@$2 "rm -rf viztex && tar xzf $(basename $PKG) && cat viztex/VERSION"
done
```
One key for all three? Put the same `.pem` name in all three pairs.
**The same package on all three** - mixing versions between servers is not supported.

> **Git Bash or CMD?** All commands from your PC in this guide are for **Git Bash**: paths with
> forward slashes, `~/Documents/<key>.pem`. A Windows path like `C:\Users\...\x.pem` in Git Bash
> loses its backslashes ("Identity file C:UsersUser01... not accessible"). In CMD, use
> `C:\Users\<you>\Documents\<key>.pem` instead.

- [ ] All three print the same VERSION.

## 7. Install the DB server (~5 min)

```
ssh -i ~/Documents/<db-key>.pem ubuntu@<db-public-ip>
sudo bash viztex/install/install.sh --role db --app-ip <app-private> --telephony-ip <tel-private>
```
What it does: MySQL only; listens on its private IP; database `viztex`; user
`dialforge` allowed **only from the app's IP**, read-only `asterisk_rt` **only from the
telephony IP**; creates `/etc/viztex/secrets.env` (all shared passwords); its own
health check every minute.

Expected checks: `MySQL`, **`MySQL listens on <db-private> for the app and telephony servers`**,
`Server health check every minute`, `MySQL, ARI and AMI not open on every address` - all OK.

Check from the other two that the database is reachable (each prints `reachable`):
```
ssh -i ~/Documents/<app-key>.pem ubuntu@<app-elastic-ip> "timeout 3 bash -c 'echo > /dev/tcp/<db-private>/3306' && echo reachable"
ssh -i ~/Documents/<tel-key>.pem ubuntu@<tel-elastic-ip> "timeout 3 bash -c 'echo > /dev/tcp/<db-private>/3306' && echo reachable"
```
- [ ] All checks OK, and `reachable` twice.

## 8. Copy the shared passwords to the other two

From **your PC** (Git Bash; each server's own key), one **whole** line each - never run the
part before `|` alone, it would print the passwords on screen.
The file goes from the DB server straight to the other server through your SSH connection:
```
ssh -i ~/Documents/<db-key>.pem ubuntu@<db-public-ip> "sudo cat /etc/viztex/secrets.env" | ssh -i ~/Documents/<tel-key>.pem ubuntu@<tel-elastic-ip> "umask 077; cat > ~/secrets.env"
ssh -i ~/Documents/<db-key>.pem ubuntu@<db-public-ip> "sudo cat /etc/viztex/secrets.env" | ssh -i ~/Documents/<app-key>.pem ubuntu@<app-elastic-ip> "umask 077; cat > ~/secrets.env"
```
Check the copies are identical (same start of checksum on all three; nothing secret is shown):
```
ssh -i ~/Documents/<db-key>.pem ubuntu@<db-public-ip> "sudo sha256sum /etc/viztex/secrets.env | cut -c1-16"
ssh -i ~/Documents/<tel-key>.pem ubuntu@<tel-elastic-ip> "sha256sum ~/secrets.env | cut -c1-16"
ssh -i ~/Documents/<app-key>.pem ubuntu@<app-elastic-ip> "sha256sum ~/secrets.env | cut -c1-16"
```
- [ ] Three identical checksums. Never send this file by chat or email.

## 9. Install the telephony server (~30 min, inside tmux)

```
ssh -i ~/Documents/<tel-key>.pem ubuntu@<tel-elastic-ip>
tmux new -s install
sudo bash viztex/install/install.sh --role telephony --domain sip.client.com --email <you> \
  --db-ip <db-private> --app-ip <app-private> --secrets ~/secrets.env
```
What it does: Asterisk 22 compiled (the long part), coturn, ffmpeg, the certificate for
`sip.client.com`; Asterisk reads the database **over the network**; ARI (8088) and AMI
(5038) listen on the private IP for the app server only; the recording script; nightly
backup of its config + recordings; health check every minute.

Expected: all OK **except one, by design**:
```
FAIL  Asterisk reads MySQL (ODBC) - on split servers only after the app install: then --checks-only
```
(The tables don't exist until step 10. In `/var/log/asterisk/messages.log` you see
`Access denied ... errno=1044` - that proves Asterisk reached and logged in to the DB server.)

Disconnected? `tmux attach -t install`.
- [ ] Every check OK except the ODBC one.

## 10. Install the app server (~5-8 min)

```
ssh -i ~/Documents/<app-key>.pem ubuntu@<app-elastic-ip>
tmux new -s install
sudo bash viztex/install/install.sh --role app --domain crm.client.com --admin boss --email <you> \
  --db-ip <db-private> --telephony-ip <tel-private> --telephony-domain sip.client.com --secrets ~/secrets.env
```
What it does: Node.js, the app and the dialer; **creates every table on the DB server**,
then lets Asterisk's read-only user read its 4 views; the certificate for `crm.client.com`;
the app on 443 (old `:3000` links redirect); creates the Super Admin and prints a
**one-time password** - save it, never paste it anywhere.

Expected (all OK), among others:
`VIZTEX backend /health (database on <db-private> connected)`,
`Backend connected to Asterisk (ARI) on <tel-private>`,
`Old :3000 links redirect to https://crm.client.com`.

- [ ] All checks OK, password saved.

## 11. Re-check the telephony server, remove the copies

On the **telephony** server:
```
sudo bash viztex/install/install.sh --role telephony --domain sip.client.com --email <you> \
  --db-ip <db-private> --app-ip <app-private> --secrets ~/secrets.env --checks-only
rm ~/secrets.env
```
Now **every** line is OK, including the ODBC one (the check reads `/etc/viztex/secrets.env`, so
`rm` before or after it makes no difference). On the **app** server: `rm ~/secrets.env`.
(The installs keep their own copy in `/etc/viztex/secrets.env`, root only.)

- [ ] All checks OK on the telephony server; `~/secrets.env` gone from both.

## 12. Set up and test

On the **app** server (licence and extensions live in the app's database):
```
sudo bash viztex/install/set-licence.sh --customer "<name>" --seats 10 --channels 15 --expires <YYYY-MM-DD>
cd ~/dialforge-backend && npm run ext:add -- --from 1001 --count 10
```
On the **telephony** server, when the provider has given its details (the trunk is Asterisk's):
```
sudo bash viztex/install/add-trunk.sh --host <provider-ip> --caller-id <did> --channels <n>
```
It configures the trunk in Asterisk, then prints three lines (`TRUNK_ENDPOINT`, `TRUNK_CALLER_ID`,
`DIALER_MAX_TRUNK_CHANNELS`) to put in the **app** server's `~/dialforge-backend/.env`, followed by
`sudo systemctl restart dialforge-backend dialforge-dialer` there.

In the browser, `https://crm.client.com`: log in as `boss`, **change the password**, then
Forms → Queues → Campaigns → Users (agents with extensions) → Teams → DID Numbers.

**Test call:** two browsers, agent1001 and agent1002, Connect, start the shift, Available;
agent1001 dials 1002 → talk both ways.

Check on the **telephony** server that the phones are registered there (not on the app server):
```
sudo asterisk -rx "pjsip show contacts"     # 1001 and 1002: Avail
sudo asterisk -rx "queue show"              # agents in the campaign's queue while Available
```
- [ ] Two-way audio; contacts on the telephony server.

## 13. Alerts, recordings, updates

**Alerts** (same Telegram bot as your other servers - see ops/README.md → Alerts):
- app server: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `~/dialforge-backend/.env`, then
  `npm run alert:test` and `sudo systemctl restart dialforge-backend`;
- telephony and DB servers: the same two lines in `/etc/viztex/server.env`, then
  `sudo bash /opt/viztex/ops/server-health.sh --verbose` (checks services, disk, memory).

**Recordings and backups** go to S3: make a bucket, give the **telephony** and **app**
servers an IAM role for it (EC2 → instance → Actions → Security → Modify IAM role), then set
`BACKUP_S3_BUCKET=<bucket>` in the app's `.env` and in the telephony server's
`/etc/viztex/server.env`. Recordings are made and uploaded on the telephony server; the app
plays them from S3. The app server's nightly backup dumps the database over the network.

**Updates** later, from your PC - the app first, then the telephony server's dialplan /
recording script / ops scripts (only what changed); calls are checked on the telephony server:
```
DEPLOY_HOST=ubuntu@<app-elastic-ip> DEPLOY_TELEPHONY_HOST=ubuntu@<tel-elastic-ip> \
  DEPLOY_KEY=~/Documents/<app-key>.pem DEPLOY_TELEPHONY_KEY=~/Documents/<tel-key>.pem bash scripts/deploy-dev.sh
```
- [ ] A test alert received; (customer) S3 bucket and roles set.

## 14. Practice servers: delete

1. EC2 → the 3 instances → **Terminate**.
2. Elastic IPs → **Release** both (an unused Elastic IP is still charged).
3. Security groups → delete the 3 (after the instances are gone).
4. Key pairs → delete it; DNS / DDNS names → remove.

- [ ] Nothing left running.

---

## Looking at the data (without a public database page)

On the DB server: `sudo mysql viztex` then `SHOW TABLES;`, `SELECT ... ;`, `exit`.

phpMyAdmin in your browser, safely: install it on the DB server listening only on the
server itself, and reach it through SSH -
```
# DB server
echo "phpmyadmin phpmyadmin/reconfigure-webserver multiselect apache2" | sudo debconf-set-selections
echo "phpmyadmin phpmyadmin/dbconfig-install boolean false" | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y phpmyadmin
sudo sed -i 's/^Listen 80$/Listen 127.0.0.1:8080/' /etc/apache2/ports.conf
sudo sed -i 's/<VirtualHost \*:80>/<VirtualHost 127.0.0.1:8080>/' /etc/apache2/sites-enabled/000-default.conf
sudo systemctl restart apache2           # ss -lntp | grep apache  ->  127.0.0.1:8080 only
sudo mysql -e "CREATE USER 'viewer'@'localhost' IDENTIFIED BY '<your password>'; GRANT SELECT, SHOW VIEW ON viztex.* TO 'viewer'@'localhost';"
# your PC (keep it open), then the browser: http://localhost:8080/phpmyadmin  (user viewer)
ssh -i ~/Documents/<db-key>.pem -L 8080:127.0.0.1:8080 ubuntu@<db-public-ip>
```

## Which server has what

| Question | Where to look |
|---|---|
| Is the app up? | app: `systemctl status dialforge-backend dialforge-dialer`, `tail -f ~/dialforge-backend/server.log` |
| Are phones registered / calls up? | **telephony**: `sudo asterisk -rx "pjsip show contacts"`, `"core show channels"`, `sudo asterisk -rvvv` |
| SIP messages of a call | **telephony**: `sudo sngrep` (install: `sudo apt install sngrep`) |
| Data | **DB**: `sudo mysql viztex` |
| Recordings | **telephony**: `/var/spool/asterisk/monitor/dialforge/`; later S3 |
| Health of a server | app: Dashboard → System health; telephony / DB: `sudo bash /opt/viztex/ops/server-health.sh --verbose` |
| Install log | each server: `/var/log/viztex-install.log` |

## If something fails

| Symptom | Usual cause | Fix |
|---|---|---|
| DB check "MySQL listens on <ip>" FAIL, or `reachable` missing | a MySQL setting overrides the address, or db-sg lacks the 3306 rule from app-sg / tel-sg | `grep -rn bind-address /etc/mysql`; the security group rules (step 2) |
| App: "database ... connected" FAIL | DB unreachable or wrong `--db-ip` | step 7's `reachable` test from the app server; re-run step 10 with the right IP |
| App: "Backend connected to Asterisk (ARI)" FAIL | tel-sg lacks 8088 / 5038 from app-sg, or the telephony install didn't finish | from the app server: `curl -s -o /dev/null -w "%{http_code}" http://<tel-private>:8088/ari/asterisk/ping` → 401 is right |
| Telephony: ODBC still FAIL after step 11 | the app install hasn't finished, or asterisk_rt's grants are missing | finish step 10; on the telephony server `sudo asterisk -rx "pjsip show endpoints"` then re-check |
| `--secrets`: "file not found" / "no secrets.env yet" | step 8 not done on this server | step 8, then the same install command again |
| Phones don't connect | tel-sg lacks 8089, or the browser is on the app name | agents' phones connect to `sip.…:8089` - open `https://sip.client.com:8089/ws` once (shows a short error page = reachable) |
| One-way / no audio | tel-sg lacks UDP 10000-20000 / TURN ports | step 2, tel-sg |
| A step failed half-way | - | fix the cause, run the **same** install command again: finished steps are skipped, passwords kept |
