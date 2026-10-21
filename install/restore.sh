#!/bin/bash
# Puts a VIZTEX backup onto a server that install.sh has just set up -
# rebuilding after a server is lost, or moving to a new server.
#
# Restores: the database (all leads, calls, users and their passwords,
# campaigns, settings), the licence, the call recordings, and the app's non-secret
# settings from the old .env (alerts, S3 bucket, time zone, trunk caller ID
# and channels...). The new server keeps the passwords install.sh generated.
# NOT restored automatically: the SIP trunk - the provider must allow the new
# server's IP first; the old trunk config is saved for reference and the
# script prints the add-trunk.sh line.
#
# From S3 (the nightly backup's bucket; the server needs an IAM role that may
# read it - see docs/DISASTER_RECOVERY.md):
#   sudo bash viztex/install/restore.sh --s3 dialforgedev --from-host ip-172-31-10-157
# From files copied to the server:
#   sudo bash viztex/install/restore.sh --db db-<time>.sql.gz --config config-<time>.tgz [--recordings <dir or .tgz>]
#
# Options:
#   --s3 BUCKET          read the newest backup from s3://BUCKET/dialforge/<host>/
#   --from-host NAME     the OLD server's short hostname (the S3 folder name); list them with --list
#   --list               show the server folders in the bucket and exit
#   --at TIME            a specific backup (e.g. 20261014-210001) instead of the newest
#   --db FILE / --config FILE / --recordings PATH   local files instead of S3
#   --skip-recordings    don't bring the recordings (can be large)
#   --yes                don't ask before replacing this server's data
set -euo pipefail

S3="" FROM_HOST="" LIST=0 AT="" DB_FILE="" CFG_FILE="" REC="" SKIP_REC=0 YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --s3) S3="$2"; shift 2 ;;
    --from-host) FROM_HOST="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    --at) AT="$2"; shift 2 ;;
    --db) DB_FILE="$2"; shift 2 ;;
    --config) CFG_FILE="$2"; shift 2 ;;
    --recordings) REC="$2"; shift 2 ;;
    --skip-recordings) SKIP_REC=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo"
APP_USER="${SUDO_USER:-ubuntu}"
APP_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)/dialforge-backend"
ENV_FILE="$APP_DIR/.env"
REC_DIR=/var/spool/asterisk/monitor/dialforge
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found - run install.sh on this server first"
WORK=$(mktemp -d /root/viztex-restore.XXXX)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

AWS=""
if [ -n "$S3" ]; then
  AWS=$(command -v aws || true)
  if [ -z "$AWS" ]; then
    info "installing the AWS CLI..."
    snap install aws-cli --classic >/dev/null || die "install aws-cli"
    AWS=/snap/bin/aws
  fi
  "$AWS" s3 ls "s3://$S3/dialforge/" >/dev/null 2>&1 ||
    die "can't read s3://$S3 - give this server an IAM role that may read the bucket (docs/DISASTER_RECOVERY.md)"
  if [ "$LIST" = 1 ] || [ -z "$FROM_HOST" ]; then
    echo "Server folders in s3://$S3/dialforge/ (use one with --from-host):"
    "$AWS" s3 ls "s3://$S3/dialforge/" | awk '$1 == "PRE" {print "  " $2}' | tr -d /
    [ "$LIST" = 1 ] && exit 0
    die "--from-host is required"
  fi
  PREFIX="s3://$S3/dialforge/$FROM_HOST"
  pick() { # newest (or --at) file starting with $1
    "$AWS" s3 ls "$PREFIX/" | awk '{print $4}' | grep "^$1-${AT:-}" | sort | tail -1
  }
  DBK=$(pick db) CFK=$(pick config)
  [ -n "$DBK" ] || die "no database backup in $PREFIX/"
  say "Downloading $DBK${CFK:+ and $CFK}"
  "$AWS" s3 cp --only-show-errors "$PREFIX/$DBK" "$WORK/$DBK"
  DB_FILE="$WORK/$DBK"
  if [ -n "$CFK" ]; then "$AWS" s3 cp --only-show-errors "$PREFIX/$CFK" "$WORK/$CFK"; CFG_FILE="$WORK/$CFK"; fi
fi
[ -n "$DB_FILE" ] || die "say where the backup is: --s3 BUCKET --from-host NAME, or --db FILE (see --help)"
[ -f "$DB_FILE" ] || die "$DB_FILE not found"
gzip -t "$DB_FILE" 2>/dev/null || [[ "$DB_FILE" != *.gz ]] || die "$DB_FILE is damaged (gzip test failed)"

set -a; . "$ENV_FILE"; set +a
DB_NAME="${DB_NAME:-viztex}"
say "Restore into this server ($(hostname -s)), database $DB_NAME"
info "database backup: $(basename "$DB_FILE")"
info "config backup:   ${CFG_FILE:+$(basename "$CFG_FILE")}${CFG_FILE:-none}"
info "This REPLACES this server's data (leads, calls, users...)."
if [ "$YES" != 1 ]; then
  read -r -p "   Type RESTORE to continue: " ok
  [ "$ok" = RESTORE ] || die "cancelled - nothing changed"
fi

say "1/5 Stop the app, back up what's here now"
systemctl daemon-reload # installing the AWS CLI (snap) can leave systemd asking for one
systemctl stop dialforge-backend dialforge-dialer
mkdir -p /root/viztex-backups && chmod 700 /root/viztex-backups
NOW=$(date +%Y%m%d-%H%M%S)
mysqldump --single-transaction --no-tablespaces "$DB_NAME" | gzip > "/root/viztex-backups/before-restore-$NOW.sql.gz"
cp -p "$ENV_FILE" "/root/viztex-backups/before-restore-$NOW.env"
info "this server's data before: /root/viztex-backups/before-restore-$NOW.sql.gz"

say "2/5 Database"
mysql -e "DROP DATABASE \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO 'dialforge'@'localhost';"
# Views in the dump name their creator; on this server that's the same 'dialforge' user.
if [[ "$DB_FILE" == *.gz ]]; then gunzip -c "$DB_FILE"; else cat "$DB_FILE"; fi |
  sed -E 's/DEFINER=`[^`]+`@`[^`]+`/DEFINER=`dialforge`@`localhost`/g' | mysql "$DB_NAME" || die "loading the database"
cd "$APP_DIR"
sudo -u "$APP_USER" npm run -s db:migrate || die "migrations after restore"
mysql <<SQL
GRANT SELECT ON \`$DB_NAME\`.ps_endpoints TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ps_auths TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ps_aors TO 'asterisk_rt'@'localhost';
GRANT SELECT ON \`$DB_NAME\`.ast_queues TO 'asterisk_rt'@'localhost';
SQL
# Sessions and live state of the old server mean nothing here.
mysql "$DB_NAME" -e "DELETE FROM sessions; DELETE FROM live_agents; UPDATE agent_status_log SET ended_at = NOW() WHERE ended_at IS NULL;
  UPDATE calls SET end_time = COALESCE(end_time, start_time) WHERE end_time IS NULL;
  UPDATE campaigns SET dialer_state = 'stopped';"
info "users, leads, calls, campaigns restored (everyone logs in with their old password); dialers stopped"

say "3/5 Settings from the old server"
OLD_TRUNK=""
if [ -n "$CFG_FILE" ]; then
  mkdir -p "$WORK/cfg" && tar xzf "$CFG_FILE" -C "$WORK/cfg"
  OLD_ENV=$(find "$WORK/cfg" -path '*dialforge-backend/.env' | head -1)
  if [ -n "$OLD_ENV" ]; then
    # Not the passwords (this server made its own) - the choices someone made.
    for k in ALERT_WEBHOOK_URL BACKUP_S3_BUCKET BACKUP_KEEP_DAYS REPORT_TIMEZONE APP_DISPLAY_NAME TRUNK_CALLER_ID \
      DIALER_MAX_TRUNK_CHANNELS RECORDING_RETENTION_DAYS RECORD_CALLS_WITHOUT_CAMPAIGN STALE_AGENT_MINUTES; do
      v=$(grep -m1 "^$k=" "$OLD_ENV" | cut -d= -f2- || true)
      [ -n "$v" ] || continue
      if grep -q "^$k=" "$ENV_FILE"; then sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"; else echo "$k=$v" >> "$ENV_FILE"; fi
      info "$k taken over"
    done
  fi
  if [ -f "$WORK/cfg/etc/viztex/licence.json" ]; then
    mkdir -p /etc/viztex && chmod 755 /etc/viztex # the app reads it
    install -o root -g root -m 644 "$WORK/cfg/etc/viztex/licence.json" /etc/viztex/licence.json
    info "licence (seats, lines, end date) taken over"
  fi
  if [ -f "$WORK/cfg/etc/asterisk/pjsip.conf" ]; then
    OLD_TRUNK=/root/viztex-backups/old-pjsip-$NOW.conf
    install -m 600 "$WORK/cfg/etc/asterisk/pjsip.conf" "$OLD_TRUNK"
    info "old pjsip.conf (trunk details) kept: $OLD_TRUNK"
  fi
fi

say "4/5 Recordings"
if [ "$SKIP_REC" = 1 ]; then
  info "skipped (--skip-recordings)"
elif [ -n "$S3" ]; then
  "$AWS" s3 sync --only-show-errors "$PREFIX/recordings" "$REC_DIR" && info "synced from $PREFIX/recordings"
elif [ -n "$REC" ]; then
  if [ -d "$REC" ]; then cp -r "$REC/." "$REC_DIR/"; else tar xzf "$REC" -C "$REC_DIR"; fi
  info "copied from $REC"
else
  info "none given (--recordings) - calls show as recorded but can't play until the files are back"
fi
chown -R asterisk:asterisk "$REC_DIR"

say "5/5 Start and check"
systemctl start dialforge-backend dialforge-dialer
for i in $(seq 1 20); do curl -sk "https://localhost:${PORT:-3000}/health" | grep -q '"connected"' && break; sleep 1; done
curl -sk "https://localhost:${PORT:-3000}/health" && echo
sudo -u "$APP_USER" npm run -s db:check | tail -3 || true
if [ -f /etc/viztex/licence.json ]; then
  if sudo -u "$APP_USER" cat /etc/viztex/licence.json >/dev/null 2>&1; then info "licence readable by the app"
  else info "!! licence NOT readable by the app - run: sudo chmod 755 /etc/viztex"; fi
fi
cat <<EOF

==========================================================================
 Restored. Log in with the same usernames and passwords as on the old server.

 Still to do:
  1. DNS: point the client's hostname at this server (if it changed).
  2. SIP trunk: give the provider this server's IP, then
       sudo bash $(dirname "$0")/add-trunk.sh --host <provider> --caller-id <did> --channels <n>
     $([ -n "$OLD_TRUNK" ] && echo "(old settings for reference: grep -A12 'type=endpoint' $OLD_TRUNK)")
  3. Agents: Ctrl+F5 and log in; Dialer: start the campaigns again (they were stopped).
  4. If something is wrong: this server's data before the restore is in
     /root/viztex-backups/before-restore-$NOW.sql.gz
==========================================================================
EOF
