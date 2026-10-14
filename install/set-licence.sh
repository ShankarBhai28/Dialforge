#!/bin/bash
# Sets the client's licence on a VIZTEX server - what they pay for. Only the
# provider runs this (the client never gets the server); the app re-reads it
# within 10 seconds, no restart.
#
#   sudo bash set-licence.sh --customer "Acme Pvt Ltd" --seats 10 --channels 15 --expires 2026-12-31
#   sudo bash set-licence.sh --expires 2027-03-31      # renew: other values kept
#   sudo bash set-licence.sh --seats 15                 # more seats, then: npm run ext:add ...
#   sudo bash set-licence.sh --show
#
# Options (each one left out keeps its current value):
#   --customer NAME   shown on the admin's Licence card
#   --seats N         most extensions (= agents working at once); ext:add refuses more
#   --channels N      most calls on the trunk at once - dialer, manual, transfers, inbound
#   --expires DATE    last day of service (YYYY-MM-DD), or "none". Admins are warned
#                     14 days before; after it agents can't log in or call, the dialer
#                     stops; admins can still log in and all data stays.
#   --show            print the licence and what's in use, change nothing
set -euo pipefail

FILE=/etc/viztex/licence.json
CUSTOMER="" SEATS="" CHANNELS="" EXPIRES="" SHOW=0 GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --customer) CUSTOMER="$2"; GIVEN=1; shift 2 ;;
    --seats) SEATS="$2"; GIVEN=1; shift 2 ;;
    --channels) CHANNELS="$2"; GIVEN=1; shift 2 ;;
    --expires) EXPIRES="$2"; GIVEN=1; shift 2 ;;
    --show) SHOW=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
die() { printf '\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"
APP_USER="${SUDO_USER:-ubuntu}"
APP_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)/dialforge-backend"
[ -d "$APP_DIR" ] || die "$APP_DIR not found"

show() {
  cd "$APP_DIR"
  sudo -u "$APP_USER" LICENCE_FILE="$FILE" node -e '
    const { getLicence } = require("./src/services/licence");
    const l = getLicence();
    if (l.state === "none") { console.log("No licence set - no limits."); process.exit(0); }
    if (l.state === "invalid") { console.log("Licence file is broken: " + l.error); process.exit(1); }
    console.log(`Customer: ${l.customer || "-"}`);
    console.log(`Seats:    ${l.seats || "no limit"}`);
    console.log(`Channels: ${l.channels || "no limit"}`);
    console.log(`Expires:  ${l.expires ? `${l.expires} (${l.daysLeft < 0 ? "ENDED" : l.daysLeft + " days left"})` : "never"}  - ${l.state}`);
  '
  sudo -u "$APP_USER" npm run -s ext:add -- --list | tail -1
}
if [ "$SHOW" = 1 ] || [ "$GIVEN" = 0 ]; then show; exit 0; fi

mkdir -p /etc/viztex
chmod 755 /etc/viztex # the app (not root) reads the licence; secrets.env stays root-only itself
[ -f "$FILE" ] && cp -p "$FILE" "$FILE.$(date +%Y%m%d-%H%M%S)"
# Merge with what's there, check with the app's own rules, then write.
NEW=$(CUR="$([ -f "$FILE" ] && cat "$FILE" || echo '{}')" CUSTOMER="$CUSTOMER" SEATS="$SEATS" \
  CHANNELS="$CHANNELS" EXPIRES="$EXPIRES" node -e '
  const { parseLicence } = require(process.argv[1] + "/src/services/licence");
  const e = process.env;
  const cur = JSON.parse(e.CUR || "{}");
  const num = (v, k) => { if (!/^[0-9]+$/.test(v) || Number(v) < 1) { console.error(`--${k} must be a whole number above 0`); process.exit(1); } return Number(v); };
  if (e.CUSTOMER) cur.customer = e.CUSTOMER;
  if (e.SEATS) cur.seats = num(e.SEATS, "seats");
  if (e.CHANNELS) cur.channels = num(e.CHANNELS, "channels");
  if (e.EXPIRES) { if (e.EXPIRES === "none") delete cur.expires; else cur.expires = e.EXPIRES; }
  const r = parseLicence(JSON.stringify(cur));
  if (r.error) { console.error(r.error); process.exit(1); }
  process.stdout.write(JSON.stringify(cur, null, 2) + "\n");
' "$APP_DIR") || die "licence not changed"
printf '%s' "$NEW" > "$FILE.tmp"
chown root:root "$FILE.tmp" && chmod 644 "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
echo "Licence saved ($FILE) - the app picks it up within 10 seconds."
show
