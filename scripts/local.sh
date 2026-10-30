#!/usr/bin/env bash
# VIZTEX on this PC (Git Bash) - no Asterisk, so no calls; every screen works.
#
#   bash scripts/local.sh start    backend (https://localhost:3000) + screen (http://localhost:5173/app/)
#   bash scripts/local.sh stop     stops both
#   bash scripts/local.sh status   running or not
#   bash scripts/local.sh logs     the last lines of both logs
#
# Needs (once): MySQL running (Windows service MySQL84), backend/.env pointing at the
# local database, backend/certs/ with a local certificate - see docs/LOCAL_PC.md.
# The backend log keeps saying it can't reach AMI / ARI: expected, there is no Asterisk.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/.local-run" # pids + logs (git ignores it)
mkdir -p "$RUN"

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

start() {
  [ -f "$ROOT/backend/.env" ] || { echo "backend/.env missing - see docs/LOCAL_PC.md" >&2; exit 1; }
  [ -f "$ROOT/backend/certs/fullchain.pem" ] || { echo "backend/certs missing - see docs/LOCAL_PC.md" >&2; exit 1; }
  if running backend; then
    echo "backend already running"
  else
    (cd "$ROOT/backend" && exec node server.js) > "$RUN/backend.log" 2>&1 &
    echo $! > "$RUN/backend.pid"
    echo "backend started"
  fi
  if running web; then
    echo "screen already running"
  else
    # The screen passes API calls to the backend, whose certificate is our own.
    (cd "$ROOT/web" && NODE_EXTRA_CA_CERTS="$ROOT/backend/certs/fullchain.pem" DIALFORGE_API=https://localhost:3000 \
      exec node node_modules/vite/bin/vite.js --port 5173 --strictPort) > "$RUN/web.log" 2>&1 &
    echo $! > "$RUN/web.pid"
    echo "screen started"
  fi
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/auth/me)" = 401 ] && break
    sleep 1
  done
  status
  echo "open: http://localhost:5173/app/"
}

stop() {
  for p in web backend; do
    if running "$p"; then
      kill "$(cat "$RUN/$p.pid")" && echo "$p stopped"
    else
      echo "$p was not running"
    fi
    rm -f "$RUN/$p.pid"
  done
}

status() {
  local b w
  b=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:3000/health)
  w=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/auth/me)
  [ "$b" = 200 ] && echo "backend: running" || echo "backend: NOT running (see: bash scripts/local.sh logs)"
  [ "$w" = 401 ] && echo "screen:  running, talks to the backend" || echo "screen:  NOT ready (see: bash scripts/local.sh logs)"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs)
    for p in backend web; do
      echo "--- $p"
      tail -n 15 "$RUN/$p.log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
    done
    ;;
  *) echo "usage: bash scripts/local.sh start | stop | status | logs" >&2; exit 2 ;;
esac
