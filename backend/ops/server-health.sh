#!/bin/bash
# Health of a telephony or database server when one customer's VIZTEX is split
# over three servers (the app server checks itself: src/services/health.js).
# Run every minute by viztex-server-health.timer, as root.
#
# Checks: the services this server must run (SERVER_ROLE telephony: asterisk,
# coturn; db: mysql), disk (warn < 15% free, fail < 5%), memory (warn < 10%
# available, fail < 5%). A check that turns bad or recovers sends an alert;
# one still bad is reminded every 2 hours. Same Telegram bot / webhook as the
# app (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, ALERT_WEBHOOK_URL).
#
# Settings: /etc/viztex/server.env (SERVER_ROLE, SERVER_NAME, APP_DISPLAY_NAME,
# alert settings). State: /var/lib/viztex-health/<check>.
# Test by hand:  sudo bash /opt/viztex/ops/server-health.sh --verbose
set -uo pipefail

ENVF=${SERVER_ENV:-/etc/viztex/server.env}
STATE=${HEALTH_STATE_DIR:-/var/lib/viztex-health}
REMIND=${REMIND_SECONDS:-7200}
set -a; . "$ENVF" >/dev/null 2>&1; set +a
VERBOSE=0; [ "${1:-}" = --verbose ] && VERBOSE=1
mkdir -p "$STATE"
NOW=$(date +%s)

case "${SERVER_ROLE:-}" in
  telephony) SERVICES=${HEALTH_SERVICES:-asterisk coturn} ;;
  db) SERVICES=${HEALTH_SERVICES:-mysql} ;;
  *) SERVICES=${HEALTH_SERVICES:-} ;;
esac

LINES=()
# record <key> <ok|warn|fail> <label> <detail>: alert on a change, remind while bad.
record() {
  local key=$1 status=$2 label=$3 detail=$4 f="$STATE/$1" prev="" since=0 line
  [ -f "$f" ] && read -r prev since < "$f"
  [ "$VERBOSE" = 1 ] && printf '%-5s %s - %s\n' "$status" "$label" "$detail"
  if [ "$status" != "${prev:-ok}" ]; then
    if [ "$status" = ok ]; then line="RESOLVED: $label - $detail"; else line="${status^^}: $label - $detail"; fi
    LINES+=("$line")
    echo "$status $NOW" > "$f"
  elif [ "$status" != ok ] && [ $((NOW - since)) -ge "$REMIND" ]; then
    LINES+=("STILL ${status^^}: $label - $detail")
    echo "$status $NOW" > "$f"
  elif [ ! -f "$f" ]; then
    echo "$status $NOW" > "$f"
  fi
}

for s in $SERVICES; do
  st=$(systemctl is-active "$s" 2>/dev/null)
  if [ "$st" = active ]; then record "svc-$s" ok "Service $s" running; else record "svc-$s" fail "Service $s" "${st:-unknown}"; fi
done

read -r size avail < <(df -P / | awk 'NR==2 {print $2, $4}')
free_pct=$((avail * 100 / size))
free_gb=$(awk -v k="$avail" 'BEGIN {printf "%.1f", k / 1048576}')
d="$free_gb GB free ($free_pct%)"
if [ "$free_pct" -lt 5 ]; then record disk fail Disk "$d"; elif [ "$free_pct" -lt 15 ]; then record disk warn Disk "$d"; else record disk ok Disk "$d"; fi

mem_pct=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "%d", a * 100 / t}' /proc/meminfo)
m="$mem_pct% available"
if [ "$mem_pct" -lt 5 ]; then record memory fail Memory "$m"; elif [ "$mem_pct" -lt 10 ]; then record memory warn Memory "$m"; else record memory ok Memory "$m"; fi

[ ${#LINES[@]} -eq 0 ] && exit 0
text="${APP_DISPLAY_NAME:-VIZTEX} (${SERVER_NAME:-$(hostname -s)}, ${SERVER_ROLE:-server} server):"
for l in "${LINES[@]}"; do text="$text"$'\n'"$l"; done
[ "$VERBOSE" = 1 ] && printf '\nalert:\n%s\n' "$text"
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -s -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$text" >/dev/null ||
    echo "telegram alert not sent" >&2
fi
if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  body=$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
  curl -s -m 10 -H 'content-type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" >/dev/null ||
    echo "webhook alert not sent" >&2
fi
exit 0
