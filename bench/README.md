# Memory benchmark

Measures the **real** per-process private working set of parallel OMP sessions.

## Quick Reference

| Mode | Command | Notes |
|------|---------|-------|
| Default (shared) | `./ompp` | Auto-starts daemon, shared `~/.omp` config |
| Isolated | `./ompp --isolated` | `.ompp` config, no daemon |
| Source | `./ompp --isolated --source` | Source TS, no daemon |
| Lazy | `./ompp --isolated --lazy` | Source + MCP lazy-connect |
| Anywhere | `./ompp --anywhere` | Global install, `~/.ompp-anywhere` config |
| Direct CLI | `./ompp --mode cli` | No daemon, direct bun execution |
| Daemon | `./ompp --mode daemon` | Start daemon explicitly |
| Client | `./ompp --mode client` | Thin client only (fail if daemon down) |

Run `./ompp --help` for full flag reference.

## Why phys_footprint, not RSS

The 127 MB `pi_natives` addon is a Mach-O shared library (`__TEXT` 130 MB,
`SM=COW`). macOS maps it **once physically** and shares those pages across every
process. RSS counts them as private in each process, so RSS overstates the true
per-instance cost by ~140 MB and hides what actually duplicates: the V8/bun JS
heap. `phys_footprint` (via `footprint(1)`) excludes shared-clean pages, so
`sum(phys_footprint)` across sessions is the honest "extra RAM per instance"
number — the one that must drop to prove cross-instance savings.

## Run

```sh
# builds are expected at packages/coding-agent/dist/cli.js (bun run gen:bundle)
zsh bench/mem-bench.sh [launcher] [settle_secs] counts...

# unified ompp (recommended)
zsh bench/mem-bench.sh bench/ompp 15 1 3

# with flags — pass via quoted launcher path
zsh bench/mem-bench.sh "bench/ompp --isolated" 15 1 3
```

Sessions launch via `key <launcher>` in a non-interactive login zsh under a pty
(held-open stdin so the TUI idles). One iteration = 1 session measured, then N
parallel measured, then all killed.

## Baseline (HEAD @ d39691c, minified dist/cli.js, M2 8GB)

| Instances | Total private | Avg/instance | RSS   |
|-----------|---------------|--------------|-------|
| 1         | 384 MB        | 384 MB       | 526 MB|
| 3         | 1171 MB       | 390 MB       | 1305 MB|

Private memory scales linearly (~390 MB/instance duplicated). Handoff's "521 MB
baseline" was RSS; the honest private figure is ~384 MB.

## Legacy

`ompp.original.bak` is the pre-consolidation script. Superseded by `ompp`
which covers all four original modes (shared, isolated, source, anywhere) in
one script with flag-based dispatch.
