#!/bin/bash
# DialForge nightly backup (run by dialforge-backup.timer, or by hand).
#
# Makes, in ~/backups/nightly/:
#   db-<time>.sql.gz      the whole database (consistent snapshot, compressed)
#   config-<time>.tgz     /etc/asterisk, /etc/odbc.ini, /etc/turnserver.conf,
#                         /etc/viztex and the app's .env (contains SIP / AMI /
#                         ODBC / app passwords - keep it as private as the server)
# then, if BACKUP_S3_BUCKET is set in .env, copies both to
#   s3://<bucket>/dialforge/<hostname>/  (server-side encrypted)
# and syncs call recordings to s3://<bucket>/dialforge/<hostname>/recordings/.
# Local copies older than BACKUP_KEEP_DAYS (default 14) are removed, and
# call recordings older than RECORDING_RETENTION_DAYS (default 90) are
# deleted from this server (after the S3 sync, so S3 keeps them).
# The result is written to ~/backups/nightly/last.json, which the app's
# System health panel shows; a failure also sends an alert (ALERT_WEBHOOK_URL).
#
# Restore the database:  gunzip -c db-<time>.sql.gz | mysql -u dialforge -p dialforge_dev
set -uo pipefail

APP=${APP_DIR:-$HOME/dialforge-backend}
DEST=${BACKUP_DIR:-$HOME/backups/nightly}
cd "$APP" || exit 1
set -a; . ./.env >/dev/null 2>&1; set +a
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
DB=${DB_NAME:-dialforge_dev}
TS=$(date -u +%Y%m%d-%H%M%S)
HOST=$(hostname -s)
mkdir -p "$DEST"
started=$(date -u +%FT%TZ)
errors=()

# 1. database
dbfile="$DEST/db-$TS.sql.gz"
# DB_HOST: the database server when the servers are split (localhost otherwise).
if MYSQL_PWD="$DB_PASSWORD" mysqldump --single-transaction --routines --no-tablespaces -h"${DB_HOST:-localhost}" -u"${DB_USER:-dialforge}" "$DB" | gzip -9 > "$dbfile" \
   && gzip -t "$dbfile" && [ "$(stat -c %s "$dbfile")" -gt 1000 ]; then
  chmod 600 "$dbfile"
  echo "database: $dbfile ($(du -h "$dbfile" | cut -f1))"
else
  errors+=("database dump failed")
  rm -f "$dbfile"
fi

# 2. Asterisk / ODBC / TURN config and the app's .env (install/restore.sh reads them)
cfgfile="$DEST/config-$TS.tgz"
# Only what this server has (an app server of split servers has no Asterisk).
cfgparts=("${APP#/}/.env")
for p in etc/asterisk etc/odbc.ini etc/turnserver.conf etc/viztex; do [ -e "/$p" ] && cfgparts+=("$p"); done
if sudo -n tar czf "$cfgfile" -C / "${cfgparts[@]}" 2>/dev/null && sudo -n chown "$(id -u):$(id -g)" "$cfgfile"; then
  chmod 600 "$cfgfile"
  echo "config: $cfgfile ($(du -h "$cfgfile" | cut -f1))"
else
  errors+=("config backup failed")
fi

# 3. off-server copy (only when a bucket is configured)
offsite="off"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  AWS=$(command -v aws || echo /snap/bin/aws)
  prefix="s3://$BACKUP_S3_BUCKET/dialforge/$HOST"
  ok=1
  for f in "$dbfile" "$cfgfile"; do
    [ -f "$f" ] || continue
    "$AWS" s3 cp --only-show-errors --sse AES256 "$f" "$prefix/$(basename "$f")" || ok=0
  done
  if [ -d /var/spool/asterisk/monitor/dialforge ]; then
    if [ -d /var/spool/asterisk/monitor/dialforge ]; then
      "$AWS" s3 sync --only-show-errors --sse AES256 /var/spool/asterisk/monitor/dialforge "$prefix/recordings" || ok=0
    fi
  fi
  if [ $ok = 1 ]; then offsite="ok"; echo "copied to $prefix"; else offsite="failed"; errors+=("upload to S3 failed"); fi
fi

# 4. keep the last KEEP_DAYS days locally; recordings for RECORDING_RETENTION_DAYS
find "$DEST" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'config-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
REC_DIR=/var/spool/asterisk/monitor/dialforge
REC_DAYS=${RECORDING_RETENTION_DAYS:-90}
if [ -d "$REC_DIR" ]; then
  old=$(sudo -n find "$REC_DIR" -type f \( -name '*.mp3' -o -name '*.wav' \) -mtime +"$REC_DAYS" -print -delete | wc -l)
  sudo -n find "$REC_DIR" -mindepth 1 -type d -empty -delete
  echo "recordings: $old older than $REC_DAYS days removed, $(sudo -n du -sh "$REC_DIR" | cut -f1) kept"
fi

# 5. result for the app + alert on failure
status=$([ ${#errors[@]} -eq 0 ] && echo ok || echo failed)
msg=$(IFS='; '; echo "${errors[*]:-}")
dbsize=$( [ -f "$dbfile" ] && stat -c %s "$dbfile" || echo 0 )
printf '{"at":"%s","started":"%s","status":"%s","offsite":"%s","dbBytes":%s,"errors":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$started" "$status" "$offsite" "$dbsize" "$msg" > "$DEST/last.json"
if [ "$status" != ok ]; then
  echo "BACKUP FAILED: $msg" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -s -m 10 -H 'content-type: application/json' \
      -d "{\"text\":\"${APP_DISPLAY_NAME:-VIZTEX} ($HOST): nightly backup FAILED - $msg\"}" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  exit 1
fi
echo "backup ok"
