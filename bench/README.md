# Memory benchmark

Measures the **real** per-process private working set of parallel OMP sessions.

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
zsh bench/mem-bench.sh [launcher] [settle_secs] [counts...]
zsh bench/mem-bench.sh bench/ompp 15 1 3      # default
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

## Note

`bench/ompp` runs the minified bundle and resolves the native addon from the
global install (repo's committed `.node` fails the version sentinel). It
isolates config under `PI_CONFIG_DIR=.ompp`.
