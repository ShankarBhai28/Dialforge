#!/usr/bin/env bash
# Deploys the current working tree to a DialForge server (the shared dev
# server by default). Same steps every time:
#   checks -> build web -> package -> refuse if calls are active -> backup
#   -> install -> restart only what changed -> health check -> rollback hint
#
# Usage (from the repo root, Git Bash or Linux):
#   DEPLOY_KEY=~/Documents/dialforge-key.pem scripts/deploy-dev.sh
# Options (env vars):
#   DEPLOY_HOST   ssh target              (default ubuntu@3.7.241.104 = dialforge-dev)
#   DEPLOY_DIR    app folder on server    (default dialforge-backend, under the ssh user's home)
#   DEPLOY_KEY    ssh private key file    (required)
#   SKIP_CHECKS=1 skip `npm run check`    (not recommended)
#   FORCE=1       deploy even if calls are active (restarting drops them)
#   DRY_RUN=1     build and package only; show what would be sent
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@3.7.241.104}
DIR=${DEPLOY_DIR:-dialforge-backend}
KEY=${DEPLOY_KEY:?set DEPLOY_KEY to your .pem file}
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "$HOST")
TS=$(date +%Y%m%d-%H%M%S)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

step() { printf '\n== %s\n' "$*"; }

step "Branch $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (+ uncommitted changes)')"

if [ "${SKIP_CHECKS:-}" != 1 ]; then
  step "Checks (lint, format, typecheck, tests)"
  npm run check --silent
fi

step "Build web app"
npm run build:web --silent

step "Package"
PKG=$(mktemp -d)/dialforge-deploy.tgz
# What runs on the server: entry points, root modules, src/, classic pages,
# the built React app, and the dependency manifest. Never .env, certs or logs.
(cd backend && tar czf "$PKG" \
  server.js dialer-engine.js dialer-common.js call-control.js ari.js ami.js db.js seed-users.js \
  package.json package-lock.json src public web-dist)
echo "package: $(du -h "$PKG" | cut -f1)"
if [ "${DRY_RUN:-}" = 1 ]; then
  tar tzf "$PKG" | sed 's#/.*##' | sort | uniq -c
  echo "DRY_RUN - nothing sent."
  exit 0
fi

step "Upload"
scp -q -i "$KEY" "$PKG" "$HOST:/tmp/dialforge-deploy-$TS.tgz"

step "Install on $HOST"
"${SSH[@]}" "TS=$TS DIR=$DIR FORCE=${FORCE:-} bash -s" <<'REMOTE'
set -euo pipefail
cd ~/"$DIR"
PKG=/tmp/dialforge-deploy-$TS.tgz

calls=$(sudo asterisk -rx 'core show channels count' | awk '/active call/ {print $1}')
if [ "${calls:-0}" != 0 ] && [ "${FORCE:-}" != 1 ]; then
  echo "ABORT: $calls active call(s). Restarting would drop them. Try later or set FORCE=1."
  rm -f "$PKG"
  exit 3
fi

B=~/backups/pre-deploy-$TS
mkdir -p "$B"
tar czf "$B/backend-files.tgz" --exclude=node_modules --exclude=certs --exclude='*.log' --exclude=.env .
echo "backup: $B"

# What changed decides what restarts.
sum() { cat "$@" 2>/dev/null | md5sum | cut -d' ' -f1; }
DIALER_FILES="dialer-engine.js dialer-common.js db.js ari.js"
old_dialer=$(sum $DIALER_FILES)
old_deps=$(sum package-lock.json)

rm -rf web-dist   # old hashed assets would pile up otherwise
tar xzf "$PKG" && rm -f "$PKG"

if [ "$(sum package-lock.json)" != "$old_deps" ]; then
  echo "dependencies changed: npm ci --omit=dev"
  npm ci --omit=dev --no-audit --no-fund
fi

sudo systemctl restart dialforge-backend
echo "restarted dialforge-backend"
if [ "$(sum $DIALER_FILES)" != "$old_dialer" ]; then
  sudo systemctl restart dialforge-dialer
  echo "dialer code changed: restarted dialforge-dialer"
fi

sleep 4
systemctl is-active dialforge-backend dialforge-dialer
health=$(curl -sk https://localhost:3000/health)
echo "health: $health"
app=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:3000/app/)
echo "/app/: $app"
case "$health" in *'"ok"'*) ;; *) echo "HEALTH CHECK FAILED - roll back:"; echo "  cd ~/$DIR && tar xzf $B/backend-files.tgz && sudo systemctl restart dialforge-backend dialforge-dialer"; exit 4 ;; esac
echo
echo "Rollback if needed:"
echo "  cd ~/$DIR && tar xzf $B/backend-files.tgz && sudo systemctl restart dialforge-backend dialforge-dialer"
REMOTE

step "Done"
