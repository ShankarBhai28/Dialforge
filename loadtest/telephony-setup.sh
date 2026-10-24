#!/bin/bash
# Load test, on the TELEPHONY server: plain-SIP twins of the load-test
# extensions, so SIPp (which can't be a WebRTC browser phone) can register
# and answer as the agents. Test servers only - never on a customer's server.
#
#   sudo bash telephony-setup.sh --loadgen-ip 172.31.x.x --from 5001 --count 200 --password '<test password>' [--carrier-port 5060]
#   sudo bash telephony-setup.sh --remove
#
# Asterisk reads pjsip.conf before the database (sorcery.conf), so these
# endpoints win over the WebRTC ones the app makes for the same extension
# numbers (npm run ext:add --from 5001 on the app server). Only calls from /
# registrations from --loadgen-ip are accepted (per-endpoint permit/deny -
# not a global ACL, which would block the real phones and the trunk). Written to
# /etc/asterisk/pjsip_loadtest.conf, included from pjsip.conf; --remove
# takes both out again.
#
# Also the fake carrier as a separate trunk endpoint, "loadtrunk" (SIPp on
# --loadgen-ip:--carrier-port). The real trunk stays as it is; point the app
# at the fake one only for the test (app .env: TRUNK_ENDPOINT=loadtrunk) and
# back afterwards. No "identify" for it: the agents register from the same
# address, and the carrier never starts calls.
set -euo pipefail

FROM=5001 COUNT=0 PASSWORD="" LOADGEN="" REMOVE=0 CARRIER_PORT=5060
while [ $# -gt 0 ]; do
  case "$1" in
    --loadgen-ip) LOADGEN="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --carrier-port) CARRIER_PORT="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

CONF=/etc/asterisk/pjsip_loadtest.conf
MAIN=/etc/asterisk/pjsip.conf
LINE='#include pjsip_loadtest.conf'

if [ "$REMOVE" = 1 ]; then
  sed -i "\|^$LINE\$|d" "$MAIN"
  rm -f "$CONF"
  asterisk -rx "module reload res_pjsip.so" >/dev/null
  echo "load-test endpoints removed"
  exit 0
fi

[ -n "$LOADGEN" ] && [[ "$LOADGEN" =~ ^[0-9.]+$ ]] || { echo "--loadgen-ip IP is required" >&2; exit 2; }
[ "$COUNT" -gt 0 ] 2>/dev/null || { echo "--count N is required" >&2; exit 2; }
[ ${#PASSWORD} -ge 8 ] || { echo "--password (8+ characters) is required" >&2; exit 2; }
[[ "$PASSWORD" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--password: letters, digits, . _ - only" >&2; exit 2; }

{
  echo "; VIZTEX load test - written by loadtest/telephony-setup.sh. Remove with --remove."
  cat <<EOF

[loadtrunk]
type=endpoint
transport=transport-udp
context=from-trunk
disallow=all
allow=ulaw
aors=loadtrunk
direct_media=no
rtp_symmetric=yes
[loadtrunk]
type=aor
contact=sip:$LOADGEN:$CARRIER_PORT
qualify_frequency=0
EOF
  for ((i = 0; i < COUNT; i++)); do
    e=$((FROM + i))
    cat <<EOF

[$e]
type=endpoint
transport=transport-udp
context=internal
disallow=all
allow=ulaw
aors=$e
auth=$e
deny=0.0.0.0/0.0.0.0
permit=$LOADGEN/255.255.255.255
contact_deny=0.0.0.0/0.0.0.0
contact_permit=$LOADGEN/255.255.255.255
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
[$e]
type=auth
auth_type=userpass
username=$e
password=$PASSWORD
[$e]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=0
maximum_expiration=7200
EOF
  done
} >"$CONF"
chown root:asterisk "$CONF"
chmod 640 "$CONF"
grep -qxF "$LINE" "$MAIN" || echo "$LINE" >>"$MAIN"
asterisk -rx "module reload res_pjsip.so" >/dev/null
sleep 1
n=$(asterisk -rx "pjsip show endpoints" | grep -cE "^ Endpoint:  ($(seq -s'|' "$FROM" $((FROM + COUNT - 1))))[ /]" || true)
echo "load-test endpoints: $n of $COUNT loaded ($FROM-$((FROM + COUNT - 1)), plain SIP from $LOADGEN only)"
echo "fake carrier: endpoint loadtrunk -> sip:$LOADGEN:$CARRIER_PORT (app .env: TRUNK_ENDPOINT=loadtrunk for the test)"
