# Disaster recovery - when the PC or a server is lost

Three procedures: **A** your PC is gone, **B** a server is gone (or you are
moving to a new one), **C** what must be kept safe outside your PC so A and B
are possible. Read C first, today.

> Status: A is routine. B uses `install/install.sh` + `install/restore.sh`;
> the restore step was rehearsed on dev's data, the full B has **not yet been
> run end to end on a fresh server** - do that once on a test EC2 (docs/INSTALL.md).

---

## C. Keep these safe outside this PC (do it now)

| What | Why | Where to keep it |
|---|---|---|
| Server keys (`.pem`): `dialforge-key.pem`, `DialForge_Testing.pem`, one per client | the only way into each server - AWS can't give them back | password manager (as a secure file) or an encrypted USB stick, plus one more copy |
| AWS account login (with 2-factor) | launch servers, security groups, S3 backups, IAM roles | password manager; recovery codes on paper |
| GitHub login (with 2-factor) | the code: `github.com/ShankarBhai28/Dialforge` | password manager; recovery codes |
| DNS / DDNS logins (e.g. Dynu) | point hostnames at a new server | password manager |
| SIP trunk provider: contact, account, the trunk details | a new server's IP must be allowed by them | password manager / email |
| S3 bucket name per server (dev: `dialforgedev`) | where the nightly backups are | this file + password manager |

Everything else (code, database, recordings, server settings) is on GitHub or in S3.

---

## A. New PC (about 30 minutes)

1. Install **Git for Windows** (gives Git Bash) and **Node.js 24** (nodejs.org).
2. Clone and check:
   ```
   git clone https://github.com/ShankarBhai28/Dialforge.git DialForge
   cd DialForge
   npm ci && npm ci --prefix backend && npm ci --prefix web
   npm run check            # lint, types, all tests - should pass
   ```
3. Put the `.pem` keys back (e.g. `Documents\`), then in Git Bash: `chmod 600 ~/Documents/*.pem`.
4. Check you can reach dev: `ssh -i ~/Documents/dialforge-key.pem ubuntu@3.7.241.104 'uptime'`.
   It times out? Your IP changed - AWS -> EC2 -> Security groups -> SSH rule -> "My IP".
5. Work as before: branches, `npm run check`,
   `DEPLOY_KEY=~/Documents/dialforge-key.pem bash scripts/deploy-dev.sh`. Details: docs/CONTRIBUTING.md.

Unpushed work on the old PC is lost - push branches often (they don't have to go to `main`).

---

## B. A server is lost - rebuild it from the backup (about 1-1.5 hours)

What the nightly backup has (02:30 India time, kept 14 days on the server and
in S3 `s3://<bucket>/dialforge/<old-server-hostname>/`):
`db-<time>.sql.gz` (everything in the database: users + passwords, leads,
calls, campaigns, settings), `config-<time>.tgz` (Asterisk config incl. the
trunk, ODBC, TURN, the app's `.env`) and `recordings/`. So at most one day of
activity can be lost.

1. **New server**: docs/INSTALL.md section 1 - EC2 Ubuntu 24.04, Elastic IP,
   security group. If it should keep the same hostname, move the DNS record to
   the new Elastic IP now (the certificate needs it).
2. **Let it read the backups**: AWS -> IAM -> Roles -> the backup role
   (dev: `DialForgeS3BackupRole`) -> EC2 -> the new server -> Actions ->
   Security -> **Modify IAM role** -> choose it.
3. **Install** (from your PC, then on the server):
   ```
   bash scripts/make-release.sh
   scp -i key.pem dist/viztex-*.tgz ubuntu@<new-ip>:~
   ssh -i key.pem ubuntu@<new-ip>
   tar xzf viztex-*.tgz
   sudo bash viztex/install/install.sh --domain <hostname> --admin tempadmin --email <you>
   ```
   (`tempadmin` is only for the empty system - the restore brings back the real users.)
4. **Restore**:
   ```
   sudo bash viztex/install/restore.sh --s3 <bucket> --list          # which server folders exist
   sudo bash viztex/install/restore.sh --s3 <bucket> --from-host <old-hostname>
   ```
   It shows what it found, asks you to type RESTORE, backs up the new server's
   (empty) data, loads the database, applies newer migrations, takes over the
   old settings (alerts, S3 bucket, time zone, trunk caller ID / channels - not
   passwords: the new server has its own), downloads the recordings, starts the
   app and checks it. Dialers come back stopped. A specific backup: `--at 20261014-210001`.
   Without S3: copy the files over and use `--db db-...sql.gz --config config-...tgz --recordings <dir>`.
5. **Trunk**: give the provider the new IP; then `sudo bash viztex/install/add-trunk.sh ...`
   (the restore prints where the old trunk settings are, for reference).
6. **Backups again**: the restored `.env` has `BACKUP_S3_BUCKET` - check
   `sudo systemctl start dialforge-backup.service` then the Dashboard's System
   health says the backup was copied off-server. The new server writes to its own
   folder (its hostname) in the bucket.
7. **Check**: log in as a real admin (old password), an agent logs in and calls,
   Reports show the old data, a recording plays, Live Agents / Dialer work.
8. **Tell people**: agents Ctrl+F5 (or the new address), supervisors start the dialer again.

### Smaller problems (no rebuild)
| Problem | Fix |
|---|---|
| A bad change / deleted data (server is fine) | restore one night's database: `gunzip -c ~/backups/nightly/db-<time>.sql.gz \| mysql -u dialforge -p <db>` (stop backend + dialer first); or Leads -> Deleted lists -> Restore for a deleted list |
| A deploy broke the app | the deploy prints a rollback line (`tar xzf .../backend-files.tgz && sudo systemctl restart ...`) |
| Stuck agents / calls / dialer rows | `npm run db:check -- --fix` (backs up first) - backend/ops/README.md |
| Disk full | Dashboard -> System health; recordings older than `RECORDING_RETENTION_DAYS` go nightly; move them to S3 / shorten the keep |
