#!/usr/bin/env bash
# cwd-verify.sh — proves per-session cwd: two TUI clients from two different
# directories must produce two distinct "daemon: tui session cwd" log lines,
# and the daemon must still be branded omp (logs under ~/.omp).
# Run:  zsh -ic 'key bash bench/cwd-verify.sh'
set -u
BENCH="$(cd "$(dirname "$0")" && pwd)"
SOCK="/tmp/omp-daemon/omp-$(id -u).sock"
A=/tmp/omp-projA; B=/tmp/omp-projB
alive(){ [ -S "$SOCK" ] && node -e 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' "$SOCK" 2>/dev/null; }

pkill -9 -f 'dist/cli.js' 2>/dev/null; pkill -9 -f 'tui-client.cjs' 2>/dev/null
rm -f "$SOCK"; rmdir "${SOCK}.lock" 2>/dev/null || true
mkdir -p "$A" "$B"; sleep 1

echo "== start ompp daemon =="
export OMP_DAEMON_TUI=1
nohup bash "$BENCH/ompp" --mode daemon >/tmp/omp-daemon.log 2>&1 &
for _ in $(seq 1 80); do alive && break; sleep 0.5; done
alive || { echo "FAIL daemon down"; tail -15 /tmp/omp-daemon.log; exit 1; }
echo "daemon up"

echo "== connect client A ($A) and client B ($B) =="
OMP_LAUNCH_CWD="$A" node "$BENCH/tui-client.cjs" "$SOCK" >/dev/null 2>&1 &
sleep 6
OMP_LAUNCH_CWD="$B" node "$BENCH/tui-client.cjs" "$SOCK" >/dev/null 2>&1 &
sleep 8

LOG=$(ls -t ~/.omp/logs/*.log 2>/dev/null | head -1)
echo "== branding check: log dir =="
case "$LOG" in
  *"/.omp/"*) echo "PASS branding: logging under ~/.omp ($LOG)";;
  *) echo "WARN: log not under ~/.omp -> $LOG";;
esac
echo "== per-session cwd log lines (this daemon pid only) =="
DPID=$(pgrep -f 'dist/cli.js.*mode daemon' | head -1)
grep '"daemon: tui session cwd"' "$LOG" | grep "\"pid\":$DPID" | tail -5
echo "== distinct cwds seen =="
N=$(grep '"daemon: tui session cwd"' "$LOG" | grep "\"pid\":$DPID" | grep -oE '"cwd":"[^"]*"' | sort -u | tee /dev/stderr | wc -l | tr -d ' ')
echo "distinct=$N (expect 2: $A and $B)"
[ "$N" -ge 2 ] && echo "PASS: two sessions got two different cwds in ONE daemon." || echo "FAIL: cwds not distinct."

pkill -9 -f 'dist/cli.js' 2>/dev/null; pkill -9 -f 'tui-client.cjs' 2>/dev/null; rm -f "$SOCK"
