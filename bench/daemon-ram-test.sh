#!/usr/bin/env bash
# daemon-ram-test.sh — grounded RAM/CPU verdict for the shared-host daemon.
#
# Invoke WITH keys so the daemon can boot its catalog/providers:
#   zsh -ic 'key bash bench/daemon-ram-test.sh'
# The daemon inherits the keys from this script's env. Thin clients need none.
#
# What it does:
#  1. Kills stale daemon/ompp so the baseline is clean.
#  2. Starts ONE daemon host (OMP_DAEMON_TUI=1) — the shared module graph loads once.
#  3. Attaches N thin TUI clients, EACH in its own tmux window (parallel TUI).
#  4. After each attach, snapshots phys_footprint (honest per-proc RAM) + %CPU for
#     the daemon and every client, and the marginal daemon growth per session.
#
# The verdict = marginal daemon RAM per attached session vs the standalone
# ~415MB/instance control. Flat daemon growth => real sharing.
set -u

BENCH="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$BENCH/.." && pwd)"
SOCK="/tmp/omp-daemon/omp-$(id -u).sock"
TMUX_SES="omp-ram"
N="${1:-4}"          # number of parallel sessions to ramp to
SETTLE="${2:-8}"     # seconds to let each session allocate before measuring
LOG=/tmp/omp-daemon.log

phys() { # $1=pid -> phys_footprint in MB (0 if gone). footprint prints "phys_footprint: 389 MB".
	local x
	x=$(footprint -p "$1" 2>/dev/null | awk '/phys_footprint:/{v=$2;u=$3;if(u=="GB")v=v*1024;else if(u=="KB")v=v/1024;printf "%d",v;exit}')
	echo "${x:-0}"
}
cpu() { ps -o %cpu= -p "$1" 2>/dev/null | tr -d ' ' || echo 0; }
rss() { ps -o rss= -p "$1" 2>/dev/null | awk '{print int($1/1024)}' || echo 0; }
alive() { [ -S "$SOCK" ] && node -e 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' "$SOCK" 2>/dev/null; }

echo "== cleanup stale processes =="
tmux kill-session -t "$TMUX_SES" 2>/dev/null || true
pkill -9 -f 'dist/cli.js' 2>/dev/null || true
pkill -9 -f 'tui-client.cjs' 2>/dev/null || true
rm -f "$SOCK"
sleep 1

echo "== start daemon host (OMP_DAEMON_TUI=1) =="
export OMP_DAEMON_TUI=1
nohup bash "$BENCH/ompp" --mode daemon >"$LOG" 2>&1 &
for i in $(seq 1 80); do alive && break; sleep 0.5; done
if ! alive; then echo "FAIL: daemon did not come up; tail $LOG:"; tail -20 "$LOG"; exit 1; fi
DPID=$(pgrep -f 'dist/cli.js.*mode daemon' | head -1)
[ -z "$DPID" ] && DPID=$(pgrep -f 'dist/cli.js' | head -1)
echo "daemon pid=$DPID up."
sleep 2
BASE=$(phys "$DPID")
echo "baseline daemon phys=${BASE}MB (0 sessions)"

CLIENTS=()
echo
printf '%-8s %-12s %-10s %-12s %-14s %-12s\n' "sessions" "daemon_phys" "d_cpu%" "clients_phys" "total_phys" "marg/sess"
printf '%-8s %-12s %-10s %-12s %-14s %-12s\n' "0" "${BASE}MB" "$(cpu "$DPID")" "0MB" "${BASE}MB" "-"

tmux new-session -d -s "$TMUX_SES" -x 200 -y 50 "footprint -p $DPID; sleep 3600" 2>/dev/null || \
	tmux new-session -d -s "$TMUX_SES" -x 200 -y 50 2>/dev/null

for n in $(seq 1 "$N"); do
	tmux new-window -t "$TMUX_SES" -n "sess$n" "node '$BENCH/tui-client.cjs' '$SOCK'" 2>/dev/null
	sleep "$SETTLE"
	# newest client pid
	CPID=$(pgrep -f 'tui-client.cjs' | tail -1)
	CLIENTS+=("$CPID")
	dphys=$(phys "$DPID")
	dcpu=$(cpu "$DPID")
	csum=0
	for c in "${CLIENTS[@]}"; do csum=$(( csum + $(phys "$c") )); done
	total=$(( dphys + csum ))
	marg=$(( (dphys - BASE) / n ))
	printf '%-8s %-12s %-10s %-12s %-14s %-12s\n' "$n" "${dphys}MB" "$dcpu" "${csum}MB" "${total}MB" "${marg}MB"
done

echo
echo "== verdict inputs =="
echo "daemon base (0 sess):        ${BASE}MB"
FINAL=$(phys "$DPID")
echo "daemon final (${N} sess):     ${FINAL}MB"
echo "daemon growth over ${N} sess:  $(( FINAL - BASE ))MB"
echo "marginal daemon RAM / sess:  $(( (FINAL - BASE) / N ))MB"
echo "standalone control / inst:   ~415MB (proven linear)"
echo "clients (thin node) each:    ~$(phys "${CLIENTS[0]:-$DPID}")MB"
echo
echo "tmux session '$TMUX_SES' left running with $N parallel TUI clients + a footprint pane."
echo "  attach:   tmux attach -t $TMUX_SES"
echo "  teardown: tmux kill-session -t $TMUX_SES; pkill -9 -f dist/cli.js; pkill -9 -f tui-client.cjs"
