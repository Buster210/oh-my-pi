# Benchmark Results

## Machine
- **Chip**: Apple M2
- **RAM**: 8 GB
- **OS**: macOS (Darwin 25.5.0)
- **Date**: 2026-07-06

## Daemon Shared-Host Mode vs Per-Process Baseline

Measured with `bench/daemon-ram-test.sh` (4 parallel sessions, 8s settle).

| Mode | Instances | Total phys_footprint | Marginal per session |
|------|-----------|---------------------|---------------------|
| Per-process (standalone) | 1 | 415 MB | 415 MB |
| Per-process (standalone) | 4 | ~1660 MB | 415 MB |
| Daemon shared-host | 0 (base) | 316 MB | — |
| Daemon shared-host | 4 clients | 565 MB | ~48 MB |

### Per-Session Breakdown (Daemon Mode)

| Component | phys_footprint |
|-----------|---------------|
| Daemon host (base, 0 sessions) | 316 MB |
| Daemon host (4 sessions) | 509 MB |
| Daemon growth over 4 sessions | 193 MB (~48 MB/session) |
| Thin TUI client (Node.js) | ~14 MB each |

### Savings

- **Per additional session**: 415 MB → 48 MB = **88% reduction**
- **4-session total**: 1660 MB → 565 MB = **66% reduction** (1095 MB saved)
- **Break-even**: daemon overhead (316 MB base) is recouped after ~1 additional session

## Notes

- `phys_footprint` (via `footprint(1)`) excludes shared-clean pages (e.g., the ~127 MB pi-natives Mach-O shared library), so it measures true per-process private memory duplication.
- RSS would overstate by ~140 MB per process due to the shared native addon.
- The thin TUI client runs as a separate Node.js process (~14 MB), not in the daemon's address space.
- The daemon host process loads the full module graph once; sessions share it via the socket protocol.
