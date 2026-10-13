#!/bin/bash
# Runs as the asterisk user when a call recording ends (MixMonitor's
# command - see src/services/recording.js). Compresses the WAV to MP3
# (~0.2 MB a minute instead of ~1 MB); keeps the WAV if that fails.
# Installed as /usr/local/bin/dialforge-recording-done (ops/README.md).
wav="$1"
[ -f "$wav" ] || exit 0
mp3="${wav%.wav}.mp3"
if nice -n 19 ffmpeg -nostdin -loglevel error -y -i "$wav" -ac 1 -codec:a libmp3lame -b:a 24k "$mp3" && [ -s "$mp3" ]; then
  rm -f "$wav"
else
  rm -f "$mp3"
fi
