# Operations: backups, alerts, uptime

## Nightly backup (`backup.sh` + `dialforge-backup.timer`)
Every night at 02:30 India time: the whole database (compressed) and `/etc/asterisk` + `/etc/odbc.ini` into `~/backups/nightly/`, kept 14 days (`BACKUP_KEEP_DAYS`). With `BACKUP_S3_BUCKET` set, both are also copied to S3 (encrypted), plus call recordings. The result is in `~/backups/nightly/last.json`; the Dashboard's **System health** shows it, and a failure sends an alert.

Install once per server (after a deploy has put `ops/` in place):
```
sudo cp ~/dialforge-backend/ops/dialforge-backup.service ~/dialforge-backend/ops/dialforge-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dialforge-backup.timer
systemctl list-timers dialforge-backup.timer     # next run
sudo systemctl start dialforge-backup.service    # run one now
journalctl -u dialforge-backup.service -n 20     # its output
```
Restore the database: `gunzip -c ~/backups/nightly/db-<time>.sql.gz | mysql -u dialforge -p dialforge_dev` (stop `dialforge-backend` and `dialforge-dialer` first).

### Off-server copy (S3) - do this before going live
A backup on the same disk doesn't survive losing the server.
1. AWS console -> S3 -> Create bucket (e.g. `dialforge-backups-<company>`), same region as the server, **Block all public access** on, default encryption on. Optionally a lifecycle rule: delete after 90 days.
2. IAM -> Roles -> Create role for **EC2** with a policy allowing `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on that bucket only.
3. EC2 -> the server -> Actions -> Security -> **Modify IAM role** -> pick it.
4. On the server: `sudo snap install aws-cli --classic`, then in `~/dialforge-backend/.env`: `BACKUP_S3_BUCKET=<bucket name>`. Run the backup once by hand and check System health says "copied off-server".

## Alerts (`ALERT_WEBHOOK_URL`)
The backend checks the system every minute (`src/services/health.js`): database, Asterisk (ARI), Asterisk control (AMI), SIP trunk, dialer engine, services (asterisk, dialer, coturn), disk, memory, last backup. When a check turns bad or recovers it posts `{"text": "..."}` to `ALERT_WEBHOOK_URL` and writes an audit log row (`system.health`). Works with Slack / Google Chat / Microsoft Teams incoming webhooks and Discord (`.../slack` URL). Set it in `.env`, restart `dialforge-backend`.

## Uptime from outside
The checks above run inside the backend, so they can't report the backend or the whole server being down. Add a free external monitor (e.g. UptimeRobot, Better Stack) on `https://<domain>:3000/health` every 1-5 minutes, alerting to the same people.

## Call recording
Calls are recorded when the customer is connected to an agent (click-to-call: when the customer answers; inbound / dialer: when an agent takes the call from the queue), on the customer's channel, so the recording follows the call through transfers and conferences. Per campaign: Campaigns -> Edit -> **Record calls** (on by default). Calls without a campaign: `RECORD_CALLS_WITHOUT_CAMPAIGN` (default on). Playback / download: Call Log -> **Play** (right "Call Log -> Play recordings"); every playback is in the audit log.

Files: `/var/spool/asterisk/monitor/dialforge/YYYY/MM/DD/call-<id>-<time>.mp3` (~0.2 MB a minute). Kept `RECORDING_RETENTION_DAYS` (default 90) on the server, removed by the nightly backup (after the S3 sync, if S3 is set).

Install once per server:
```
sudo apt-get install -y ffmpeg
sudo install -o root -g root -m 755 ~/dialforge-backend/ops/recording-done.sh /usr/local/bin/dialforge-recording-done
sudo install -d -o asterisk -g asterisk -m 2775 /var/spool/asterisk/monitor/dialforge
```
The app's AMI login needs the `call` write right (MixMonitor) - already in DEPLOY.md §11. Sizing: 50 agents x ~5 h of talk a day ~ 3.6 GB a day -> about 330 GB for 90 days; plan the disk (or S3 + a shorter local keep).

Recording notice: in India and most places callers should be told calls may be recorded - add a short announcement at the start of inbound calls (a later dialplan change) and mention it in outbound scripts.
