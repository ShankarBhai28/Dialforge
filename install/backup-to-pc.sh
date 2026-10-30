#!/usr/bin/env bash
# Runs on YOUR PC (Git Bash), not on a server: copies a VIZTEX server's
# newest nightly backup (database + config) to this PC - a copy outside the
# AWS account. On 30 Oct 2026 an account hold blocked both the server and
# the S3 bucket its backups went to; this copy doesn't depend on AWS.
#
#   bash install/backup-to-pc.sh --host <IP or domain> --key ~/Documents/<key>.pem \
#     [--name dialforge-dev] [--keep 8] [--now]
#
# --name  folder name on the PC (default: the host)
# --keep  how many backups of each kind to keep on the PC (default 8)
# --now   make a fresh backup on the server first (else: last night's)
#
# Files go to ~/Documents/VIZTEX-backups/<name>/: db-<time>.sql.gz,
# config-<time>.tgz (has the app's .env - passwords: keep this folder
# private, never send or upload it) and last.json. install/restore.sh
# rebuilds a server from them (--db / --config).
# The server must be running. Every week, or after a day of real changes.
set -euo pipefail

HOST="" KEY="" NAME="" KEEP=8 NOW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --now) NOW=1; shift ;;
    *) echo "unknown option $1 (see the top of backup-to-pc.sh)" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] && [ -n "$KEY" ] || { echo "--host and --key are needed (see the top of backup-to-pc.sh)" >&2; exit 2; }
[ -f "$KEY" ] || { echo "key file not found: $KEY" >&2; exit 2; }
NAME=${NAME:-$HOST}
DEST="$HOME/Documents/VIZTEX-backups/$NAME"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST")

"${SSH[@]}" true 2>/dev/null || { echo "can't reach ubuntu@$HOST - is the server running, and your IP allowed (security group My IP)?" >&2; exit 1; }

if [ "$NOW" = 1 ]; then
  echo "making a fresh backup on the server (a minute or two)..."
  "${SSH[@]}" "sudo systemctl start dialforge-backup.service" || { echo "the server's backup failed - see: journalctl -u dialforge-backup" >&2; exit 1; }
fi

# Newest of each kind on the server.
mapfile -t files < <("${SSH[@]}" 'cd ~/backups/nightly 2>/dev/null && for k in db config; do ls -t $k-* 2>/dev/null | head -1; done')
[ "${#files[@]}" -gt 0 ] || { echo "no backups in ~/backups/nightly on the server - run again with --now" >&2; exit 1; }

mkdir -p "$DEST"
for f in "${files[@]}" last.json; do
  if [ -f "$DEST/$f" ] && [ "$f" != last.json ]; then
    echo "already here: $f"
    continue
  fi
  scp -q -i "$KEY" -o BatchMode=yes "ubuntu@$HOST:backups/nightly/$f" "$DEST/$f"
  echo "copied: $f ($(du -h "$DEST/$f" | cut -f1))"
done

# A dump that doesn't unzip is no backup.
for f in "${files[@]}"; do
  case "$f" in
    *.gz | *.tgz) gzip -t "$DEST/$f" || { echo "BROKEN copy: $f - run again" >&2; rm -f "$DEST/$f"; exit 1; } ;;
  esac
done

# Keep the newest --keep of each kind.
for k in db config; do
  ls -t "$DEST"/$k-* 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
    echo "removed old: $(basename "$old")"
  done
done

echo "done: $DEST"
grep -o '"status": *"[a-z]*"' "$DEST/last.json" 2>/dev/null | sed 's/^/server backup /' || true
