#!/bin/bash
# Adds (or replaces) the client's SIP trunk on a VIZTEX server.
#
# Two kinds of trunk - ask the provider which one you got:
#   IP-allowlisted (most Indian providers: they allow this server's IP):
#     sudo bash add-trunk.sh --host 152.52.42.148 --caller-id 8065098690 --channels 30
#   Username / password (the server registers to the provider):
#     sudo bash add-trunk.sh --host sip.provider.com --username 12345 --password '...' --register \
#       --caller-id 8065098690 --channels 30
#
# Options:
#   --host HOST          provider's SIP server (IP or name) - required
#   --port PORT          default 5060
#   --match IP[,IP]      provider IPs calls come FROM (default: --host)
#   --username / --password   digest credentials, if the provider gave them
#   --register           register to the provider (needs --username/--password)
#   --caller-id NUMBER   outgoing caller ID (a DID of this trunk)
#   --codecs LIST        default ulaw,alaw
#   --channels N         concurrent calls the provider allows (dialer cap)
#
# Calls from the trunk enter the [from-trunk] dialplan -> the app routes them
# by DID (DID Numbers: each number -> a queue). Outgoing calls use endpoint "trunk".
# A backup of pjsip.conf and .env is kept; nothing else is touched.
# Servers split in three: run it on the telephony server (it has Asterisk but
# no app); it then prints the 3 settings to add to the app server's .env.
set -euo pipefail

HOST="" PORT=5060 MATCH="" USERNAME="" PASSWORD="" REGISTER=0 CALLER_ID="" CODECS="ulaw,alaw" CHANNELS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --match) MATCH="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --register) REGISTER=1; shift ;;
    --caller-id) CALLER_ID="$2"; shift 2 ;;
    --codecs) CODECS="$2"; shift 2 ;;
    --channels) CHANNELS="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
die() { echo "FAILED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"
[ -n "$HOST" ] || die "--host is required (see --help)"
[ "$REGISTER" = 0 ] || { [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; } || die "--register needs --username and --password"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[ -z "$CHANNELS" ] || [[ "$CHANNELS" =~ ^[0-9]+$ ]] || die "--channels must be a number"
[ -z "$CALLER_ID" ] || [[ "$CALLER_ID" =~ ^\+?[0-9]{6,15}$ ]] || die "--caller-id must be a phone number"

APP_USER="${SUDO_USER:-ubuntu}"
APP_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)/dialforge-backend"
ENV_FILE="$APP_DIR/.env"
PJSIP=/etc/asterisk/pjsip.conf
MARKER='; ---- trunk (add-trunk.sh) ----'
[ -f "$PJSIP" ] || die "$PJSIP not found - run this on the server that runs Asterisk (install.sh first)"
grep -qF "$MARKER" "$PJSIP" || die "$PJSIP has no trunk marker - was it written by install.sh?"
# No app here: the telephony server of split servers (the app's .env is on the app server).
HAS_APP=1; [ -f "$ENV_FILE" ] || HAS_APP=0
PUBLIC_IP=$(sed -n 's/^external_signaling_address=//p' "$PJSIP" | head -1)
MATCH="${MATCH:-$HOST}"

B="/etc/viztex/backup-trunk-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$B" && cp -p "$PJSIP" "$B/" && chmod -R go-rwx "$B"
[ "$HAS_APP" = 0 ] || cp -p "$ENV_FILE" "$B/"
echo "backup: $B"

# Everything above the marker stays; the trunk part is rewritten.
{
  awk -v m="$MARKER" '{ print } $0 == m { exit }' "$PJSIP"
  cat <<EOF
[trunk]
type=endpoint
context=from-trunk
disallow=all
allow=$CODECS
aors=trunk
from_domain=$PUBLIC_IP
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
transport=transport-udp
EOF
  if [ -n "$USERNAME" ]; then
    cat <<EOF
outbound_auth=trunk-auth
from_user=$USERNAME

[trunk-auth]
type=auth
auth_type=userpass
username=$USERNAME
password=$PASSWORD
EOF
  fi
  cat <<EOF

[trunk]
type=aor
contact=sip:$HOST:$PORT
qualify_frequency=60

[trunk]
type=identify
endpoint=trunk
EOF
  IFS=',' read -ra IPS <<< "$MATCH"
  for ip in "${IPS[@]}"; do echo "match=$ip"; done
  if [ "$REGISTER" = 1 ]; then
    cat <<EOF

[trunk-reg]
type=registration
transport=transport-udp
outbound_auth=trunk-auth
server_uri=sip:$HOST:$PORT
client_uri=sip:$USERNAME@$HOST:$PORT
contact_user=$USERNAME
retry_interval=60
EOF
  fi
} > "$PJSIP.new"
install -o root -g asterisk -m 640 "$PJSIP.new" "$PJSIP" && rm -f "$PJSIP.new"

setenv() { # setenv KEY VALUE in .env
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
/usr/sbin/asterisk -rx 'pjsip reload' >/dev/null
if [ "$HAS_APP" = 1 ]; then
  setenv TRUNK_ENDPOINT trunk
  [ -z "$CALLER_ID" ] || setenv TRUNK_CALLER_ID "$CALLER_ID"
  [ -z "$CHANNELS" ] || setenv DIALER_MAX_TRUNK_CHANNELS "$CHANNELS"
  systemctl restart dialforge-backend dialforge-dialer
fi
sleep 3
echo
/usr/sbin/asterisk -rx 'pjsip show endpoint trunk' | sed -n '1,12p' | grep -E 'Endpoint:|Aor:|Contact:|Identify' || true
[ "$REGISTER" = 0 ] || /usr/sbin/asterisk -rx 'pjsip show registrations' | grep -E 'trunk-reg' || true
cat <<EOF

Trunk added (endpoint "trunk", calls in -> [from-trunk]).
 - Give the provider this server's IP to allow: $PUBLIC_IP
 - Open UDP 5060 to the provider's IP ($MATCH) in the security group / firewall.
 - Map each DID to a queue: DID Numbers (the campaigns that have the queue take its calls).
 - Test: an agent calls a mobile number; then call a DID from a mobile.
EOF
if [ "$HAS_APP" = 1 ]; then
  echo "Undo: sudo cp $B/pjsip.conf $PJSIP && sudo cp $B/.env $ENV_FILE && sudo asterisk -rx 'pjsip reload' && sudo systemctl restart dialforge-backend dialforge-dialer"
else
  cat <<EOF
 - This is the telephony server: on the APP server, in ~/dialforge-backend/.env set
     TRUNK_ENDPOINT=trunk$([ -z "$CALLER_ID" ] || printf '\n     TRUNK_CALLER_ID=%s' "$CALLER_ID")$([ -z "$CHANNELS" ] || printf '\n     DIALER_MAX_TRUNK_CHANNELS=%s' "$CHANNELS")
   then: sudo systemctl restart dialforge-backend dialforge-dialer
Undo here: sudo cp $B/pjsip.conf $PJSIP && sudo asterisk -rx 'pjsip reload'
EOF
fi
