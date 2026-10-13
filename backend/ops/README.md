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
