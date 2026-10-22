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
   health says the backup was copied off-server. The new server's nightly backup writes
   to its own folder (its hostname) in the bucket; recordings keep going to the old
   folder (`RECORDINGS_HOST`, set by the restore), so old and new recordings all play.
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

## D. Three servers (one customer split: db, telephony, app) - one server is lost

What each server's nightly backup holds (S3 folder = that server's short hostname):
the **app** server's folder has the database dump (`db-*.sql.gz`, dumped over the network)
and its config (`.env`, licence in `etc/viztex`, the shared `secrets.env`); the
**telephony** server's folder has its config (`etc/asterisk` incl. the trunk) and
`recordings/`; the DB server has no backup of its own (its data is in the app server's dump).
The shared passwords (`/etc/viztex/secrets.env`) exist on all three servers.

Install commands and ports: docs/INSTALL_THREE_SERVERS.md. Same package version on all three.

| Lost | Data lost? | Do this |
|---|---|---|
| **App server** | none - the data is on the DB server | 1. New server, same private network; give it the old private IP if you can, else update the DB user and ARI/AMI rules (or reinstall those two with `--app-ip`). 2. Copy `/etc/viztex/secrets.env` from the DB or telephony server (step 8 of the guide). 3. `install.sh --role app ...` 4. `sudo bash viztex/install/restore.sh --s3 <bucket> --from-host <old-app-host> --settings-only` - settings (alerts, Telegram, S3, trunk caller ID, `RECORDINGS_HOST`) and the licence. **Never without `--settings-only` here**: a database restore would roll the DB back to last night. 5. DNS `crm.…` → the new Elastic IP. |
| **Telephony server** | none - recordings are in S3, the dialplan comes with the package | 1. New server; give it the old private IP if you can (else reinstall the app with `--telephony-ip` and the DB with `--telephony-ip`). 2. Copy `secrets.env` from the DB server. 3. `install.sh --role telephony ...`, then `--checks-only`. 4. `add-trunk.sh` again (old trunk settings: the telephony folder's `config-*.tgz` in S3, `etc/asterisk/pjsip.conf`). 5. DNS `sip.…` → the new Elastic IP. Agents: Ctrl+F5. Recordings keep playing (the app keeps `RECORDINGS_HOST`). |
| **DB server** | up to one day (since the last nightly dump) | 1. New server; give it the old private IP if you can (else reinstall app and telephony with the new `--db-ip`). 2. Copy `secrets.env` from the app server (`sudo cat /etc/viztex/secrets.env` → `~/secrets.env`), then `install.sh --role db --app-ip ... --telephony-ip ... --secrets ~/secrets.env` - same passwords, so the others need no change. 3. On the **app** server: `sudo bash viztex/install/restore.sh --s3 <bucket> --from-host <app-host>` (the app server's own folder holds the dump; full restore). 4. Telephony server: `install.sh --role telephony ... --checks-only` (Asterisk reconnects). |
| **All three** | up to one day | Install db → telephony → app as in the guide, then the full restore on the app server from the OLD app server's folder; then `add-trunk.sh` on the telephony server. |

The restore on split servers works on the DB server over the network as the app's own user (it may drop and
re-create its database; its grants stay), loads the dump without the views' old creator, and grants Asterisk's
read-only user on the telephony server's IP. Recordings are not copied - they stay in S3 and play from there.
