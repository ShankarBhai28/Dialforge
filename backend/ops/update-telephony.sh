#!/bin/bash
# Updates the telephony parts of a VIZTEX server from a new release:
#   - the app's dialplan files (asterisk/extensions-*.conf -> /etc/asterisk/),
#     then a dialplan reload (calls in progress are not affected)
#   - the recording script (/usr/local/bin/dialforge-recording-done)
#   - the ops scripts of a telephony server of split servers (/opt/viztex/ops)
# Only what changed is replaced; the old file is kept in BACKUP_DIR first.
# Run by scripts/deploy-dev.sh on the server that runs Asterisk.
#
#   bash update-telephony.sh <release folder with asterisk/ and ops/> [BACKUP_DIR]
set -euo pipefail
SRC=${1:?release folder}
B=${2:-$HOME/backups/telephony-$(date +%Y%m%d-%H%M%S)}
command -v asterisk >/dev/null || [ -x /usr/sbin/asterisk ] || { echo "no Asterisk on this server - nothing to update"; exit 0; }
mkdir -p "$B"

changed=0
for f in "$SRC"/asterisk/extensions-*.conf; do
  [ -f "$f" ] || continue
  dest=/etc/asterisk/$(basename "$f")
  if ! sudo cmp -s "$f" "$dest"; then
    sudo cp -p "$dest" "$B/" 2>/dev/null || true
    sudo install -o root -g asterisk -m 640 "$f" "$dest"
    echo "updated $dest"
    changed=1
  fi
done
if [ "$changed" = 1 ]; then
  sudo asterisk -rx 'dialplan reload' >/dev/null && echo "dialplan reloaded"
fi

if ! cmp -s "$SRC/ops/recording-done.sh" /usr/local/bin/dialforge-recording-done; then
  sudo cp -p /usr/local/bin/dialforge-recording-done "$B/dialforge-recording-done.bak" 2>/dev/null || true
  sudo install -o root -g root -m 755 "$SRC/ops/recording-done.sh" /usr/local/bin/dialforge-recording-done
  echo "updated /usr/local/bin/dialforge-recording-done"
fi

# A telephony server of split servers runs backup + health from /opt/viztex/ops.
if [ -d /opt/viztex/ops ] && ! diff -rq "$SRC/ops" /opt/viztex/ops >/dev/null 2>&1; then
  sudo tar czf "$B/opt-viztex-ops.tgz" -C /opt/viztex ops
  sudo rm -rf /opt/viztex/ops.new && sudo cp -r "$SRC/ops" /opt/viztex/ops.new
  sudo chown -R root:root /opt/viztex/ops.new && sudo chmod 755 /opt/viztex/ops.new/*.sh
  sudo rm -rf /opt/viztex/ops && sudo mv /opt/viztex/ops.new /opt/viztex/ops
  echo "updated /opt/viztex/ops"
fi
echo "telephony parts up to date (backup of replaced files: $B)"
