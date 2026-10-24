#!/bin/bash
# Load test: samples this server every 10 s into a CSV (stop with Ctrl+C).
# Run it on each VIZTEX server (inside tmux) for the whole test:
#
#   bash measure.sh                  # -> ~/loadtest-<host>-<date>.csv
#
# Columns: time, CPU % (all cores), load (1 min), memory used MB, and - on
# the telephony server - Asterisk's active channels and calls, plus the
# audio quality of every call right now (pjsip show channelstats): the
# number of call legs measured, average and worst packet loss % (received)
# and average and worst jitter (ms, received). Plus the CPU % of asterisk,
# mysqld and node (the app and dialer) when they run here.
set -u
OUT=~/loadtest-$(hostname -s)-$(date +%Y%m%d-%H%M).csv
HAS_AST=0
command -v asterisk >/dev/null && sudo asterisk -rx "core show version" >/dev/null 2>&1 && HAS_AST=1

cpu_total() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
# CPU ticks used so far by every process with this name.
proc_ticks() { pgrep -x "$1" | while read -r p; do awk '{print $14+$15}' "/proc/$p/stat" 2>/dev/null; done | awk '{s+=$1} END {print s+0}'; }

echo "time,cpu_pct,load1,mem_used_mb,channels,calls,legs,loss_avg_pct,loss_max_pct,jitter_avg_ms,jitter_max_ms,asterisk_cpu_pct,mysqld_cpu_pct,node_cpu_pct" >"$OUT"
echo "writing $OUT every 10 s (Ctrl+C to stop)"
read -r T0 I0 < <(cpu_total)
A0=$(proc_ticks asterisk) M0=$(proc_ticks mysqld) N0=$(proc_ticks node)
while true; do
  sleep 10
  read -r T1 I1 < <(cpu_total)
  A1=$(proc_ticks asterisk) M1=$(proc_ticks mysqld) N1=$(proc_ticks node)
  DT=$((T1 - T0))
  [ "$DT" -gt 0 ] || DT=1
  cpu=$(awk -v t="$DT" -v i=$((I1 - I0)) 'BEGIN {printf "%.1f", 100 * (t - i) / t}')
  # Per process: % of the whole machine (ticks of that process / all ticks).
  pct() { awk -v d="$1" -v t="$DT" 'BEGIN {printf "%.1f", (d < 0 ? 0 : 100 * d / t)}'; }
  ast=$(pct $((A1 - A0))) my=$(pct $((M1 - M0))) nd=$(pct $((N1 - N0)))
  T0=$T1 I0=$I1 A0=$A1 M0=$M1 N0=$N1
  load=$(cut -d' ' -f1 /proc/loadavg)
  mem=$(free -m | awk '/^Mem:/{print $3}')
  chans="" calls="" q=",,,,"
  if [ "$HAS_AST" = 1 ]; then
    c=$(sudo asterisk -rx "core show channels count" 2>/dev/null)
    chans=$(echo "$c" | awk '/active channel/{print $1}')
    calls=$(echo "$c" | awk '/active call/{print $1}')
    # channelstats rows end in: rxcount rxlost rxpct rxjitter txcount txlost txpct txjitter rtt
    q=$(sudo asterisk -rx "pjsip show channelstats" 2>/dev/null | awk '
      NF >= 10 && $(NF-8) ~ /^[0-9]+$/ && $(NF-6) ~ /^[0-9.]+$/ {
        n++; l = $(NF-6) + 0; j = $(NF-5) + 0; sl += l; sj += j
        if (l > ml) ml = l; if (j > mj) mj = j }
      END { if (n) printf "%d,%.2f,%.2f,%.1f,%.1f", n, sl/n, ml, sj/n, mj; else printf "0,,,," }')
  fi
  echo "$(date +%T),$cpu,$load,$mem,$chans,$calls,$q,$ast,$my,$nd" >>"$OUT"
done
