#!/bin/bash
# Load test, on the LOAD GENERATOR (the 4th server, Ubuntu 24.04): installs
# SIPp and Node.js, makes the test audio, and raises the open-files limit.
#
#   sudo bash loadgen-setup.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
DIR=$(cd "$(dirname "$0")" && pwd)

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sipp sox nodejs >/dev/null

# 60 s of quiet noise as raw u-law (what SIPp streams while a call is up).
sox -n -r 8000 -c 1 -t ul "$DIR/sipp/audio.ul" synth 60 pinknoise vol 0.2
chown -R "${SUDO_USER:-ubuntu}": "$DIR"

# Hundreds of calls = thousands of sockets.
cat >/etc/security/limits.d/loadtest.conf <<'EOF'
* soft nofile 65535
* hard nofile 65535
EOF

echo "sipp: $(sipp -v 2>&1 | grep -m1 -o 'v[0-9.]*' || echo '?')   node: $(node -v)"
echo "audio: $DIR/sipp/audio.ul ($(stat -c %s "$DIR/sipp/audio.ul") bytes)"
echo "log out and in again (open-files limit), then follow loadtest/README.md"
