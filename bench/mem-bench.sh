#!/bin/zsh
# Memory benchmark for OMP sessions.
#
# Measures the REAL per-process private working set (phys_footprint) of N
# parallel idle sessions — not RSS. RSS counts the OS-shared native addon
# (~127MB Mach-O, SM=COW) as if it were private to every process, so it
# overstates the true per-instance cost by ~140MB and hides what actually
# duplicates across instances: the V8/bun JS heap.
#
# One iteration = launch 1 session, measure; scale to N in parallel, measure;
# kill all. The number that must drop (without behavior regression) to prove
# cross-instance savings is TOTAL PRIVATE (sum of phys_footprint).
#
# Usage: bench/mem-bench.sh [launcher] [settle_secs] [counts...]
#   launcher     path to ompp launcher     (default: <repo>/bench/ompp)
#   settle_secs  boot settle time          (default: 14)
#   counts       parallel-instance counts  (default: 1 3)
set -u

SCRIPT_DIR=${0:A:h}
LAUNCHER=${1:-$SCRIPT_DIR/ompp}
SETTLE=${2:-14}
shift 2 2>/dev/null || true
COUNTS=("$@")
[[ ${#COUNTS} -eq 0 ]] && COUNTS=(1 3)

# match the real session process: `bun --preload .../omp.ts .../cli.js`
PATTERN="bun --preload.*cli.js"
PIDS=()

cleanup() {
	pkill -f "$PATTERN" 2>/dev/null
	for p in ${PIDS[@]}; do kill $p 2>/dev/null; pkill -P $p 2>/dev/null; done
	PIDS=()
}
trap cleanup EXIT INT TERM

launch_one() {
	# held-open stdin (sleep into a pty via script) so the TUI idles instead of
	# hitting EOF and exiting immediately.
	( sleep 3600 | script -q /dev/null zsh -ic "key '$LAUNCHER'" >/dev/null 2>&1 ) &
	PIDS+=($!)
}

fp_mb() { # phys_footprint of pid -> MB (integer), 0 if gone
	local v
	v=$(footprint -p "$1" 2>/dev/null | awk '/phys_footprint:/{u=$3; x=$2; if(u=="GB")x*=1024; else if(u=="KB")x=x/1024; print int(x); exit}')
	print -- ${v:-0}
}
rss_mb() { ps -o rss= -p "$1" 2>/dev/null | awk '{print int($1/1024)}'; }
cpu_pct() { ps -o %cpu= -p "$1" 2>/dev/null | awk '{print $1}'; }

run_count() {
	local n=$1 i
	print "\n=== $n parallel session(s) ==="
	PIDS=()
	for ((i=0;i<n;i++)); do launch_one; done
	print "launched $n; settling ${SETTLE}s..."
	sleep "$SETTLE"

	# collect the actual bun session pids (comm==bun; skip zsh/script wrappers)
	local -a spids
	spids=()
	local p
	for p in ${(f)"$(pgrep -f "$PATTERN")"}; do
		[[ "$(ps -o comm= -p $p 2>/dev/null)" == *bun ]] && spids+=($p)
	done
	if [[ ${#spids} -eq 0 ]]; then print "!! no sessions found (boot failed?)"; cleanup; return 1; fi

	printf "%-8s %14s %10s %8s\n" "PID" "phys_MB(priv)" "RSS_MB" "%CPU"
	local tot_priv=0 tot_rss=0 pid
	for pid in ${spids[@]}; do
		local fp=$(fp_mb $pid) rs=$(rss_mb $pid) cp=$(cpu_pct $pid)
		printf "%-8s %14s %10s %8s\n" "$pid" "$fp" "${rs:-?}" "${cp:-?}"
		tot_priv=$((tot_priv+fp)); tot_rss=$((tot_rss+${rs:-0}))
	done
	local cnt=${#spids}
	print "-------------------------------------------------"
	printf "instances=%d  TOTAL_PRIVATE=%d MB  total_RSS=%d MB\n" $cnt $tot_priv $tot_rss
	[[ $cnt -gt 0 ]] && printf "avg private/instance=%d MB\n" $((tot_priv/cnt))
	cleanup
	sleep 3
}

print "launcher: $LAUNCHER"
print "settle:   ${SETTLE}s   counts: ${COUNTS[*]}"
for c in ${COUNTS[@]}; do run_count "$c"; done
print "\ndone."
