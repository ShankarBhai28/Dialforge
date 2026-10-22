#!/bin/bash
# Runs as the asterisk user when a call recording ends (MixMonitor's
# command - see src/services/recording.js). Compresses the WAV to MP3
# (~0.2 MB a minute instead of ~1 MB); keeps the WAV if that fails.
# With a second argument (s3://<bucket>/dialforge/<host>/recordings) it
# uploads the result there right away - the same place the nightly backup
# syncs to, so a failed upload is caught up that night.
# Installed as /usr/local/bin/dialforge-recording-done (ops/README.md).
wav="$1"
s3="${2:-}"
[ -f "$wav" ] || exit 0
mp3="${wav%.wav}.mp3"
if nice -n 19 ffmpeg -nostdin -loglevel error -y -i "$wav" -ac 1 -codec:a libmp3lame -b:a 24k "$mp3" && [ -s "$mp3" ]; then
  rm -f "$wav"
else
  rm -f "$mp3"
fi

# Upload what we have (the MP3, or the WAV if converting failed).
if [ -n "$s3" ]; then
  base_dir=/var/spool/asterisk/monitor/dialforge
  f="$mp3"; [ -f "$f" ] || f="$wav"
  case "$f" in "$base_dir"/*) rel="${f#"$base_dir"/}" ;; *) exit 0 ;; esac
  aws=$(command -v aws || echo /snap/bin/aws)
  HOME=${HOME:-/var/lib/asterisk} "$aws" s3 cp --only-show-errors --sse AES256 "$f" "$s3/$rel" 2>&1 |
    logger -t dialforge-recording || true
fi
