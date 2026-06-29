# Regressions Lifecycle Sweep — ram-reduction vs main (fef9b6233)

**NEEDS SIGN-OFF: see section C.** SQLite write path was audited only, per
spec constraint — not modified. A human decision is required on the residual
risk noted below.

Scope: `ram-reduction` branch (shared daemon host, `AsyncLocalStorage`
session scoping) checked for regressions vs `main` parity baseline. Sections
below record every candidate found and whether it was a real regression.

## A. Lifecycle — none found, already fixed on this branch

- `daemon-host.ts` `server.on("error", ...)` (line 364): gated by
  `isFatalServerError(hasListened)` (line 172) — only exits before the
  socket is listening (bind failure); once listening, a runtime connection
  error is logged and the host keeps serving other sessions. This already
  matches the spec's ask; introduced by commit `007e73aa7` on this branch
  (before this sweep). **Not a regression to fix.**
- `grep -rn "process\.exit\|SIGSTOP\|process\.kill" packages/coding-agent/src`
  (172 matches, 50 files) reviewed for any session-scoped path reachable from
  the daemon:
  - `input-controller.ts` `handleCtrlC`/`handleCtrlZ`: both branch on
    `this.onExit` first — under a daemon session `onExit` is always set (see
    `interactive-mode.ts:655,778`), so `process.exit(130)` and the
    `SIGSTOP` path (`process.kill(0, "SIGSTOP")`) are both dead code under
    the shared host; only reachable in standalone (single-process) mode.
  - `rpc-mode.ts` `exit()` (line 543): `io?.onExit ? io.onExit() : process.exit(0)`
    — daemon's RPC branch always passes `onExit` (`daemon-host.ts:329`).
  - `agent-session.ts` `shutdown` context method (~7825): same pattern,
    `this.#onExit ? this.#onExit() : process.exit(0)`.
  - `main.ts`: all `process.exit(...)` calls (845, 996, 1008, 1011, 1016,
    1144, 1155, 1172, 1190, 1271, 1327, 1402, 1428, ...) live in
    `runRootCommand`/`main()` (CLI bootstrap, lines 1006+/1527+), not in
    `runInteractiveMode` (419-556), which is the only `main.ts` export the
    daemon imports and calls. Confirmed no `process.exit`/`SIGSTOP`/
    `process.kill` inside `runInteractiveMode`'s body.
  - `modes/acp/acp-mode.ts`, `modes/print-mode.ts`, `cli.ts`: standalone
    entry-point modes, never imported by `daemon-host.ts`; not reachable
    from a shared-host session.
  - Remaining hits (`plugin-cli.ts`, `config-cli.ts`, `ssh-cli.ts`,
    `setup-cli.ts`, etc.) are CLI subcommand scripts invoked as separate
    one-shot processes, not part of the daemon-hosted session lifecycle.

**Conclusion: no lifecycle regression exists to fix.** The `onExit` seam
already fully replaces raw exit/suspend signals on every path a daemon
session can reach.

## B. Singleton sweep

Grepped every module-level `let`/`var` in
`packages/coding-agent/src/{modes,config,session,capability,mcp,lsp,tools}`,
`packages/utils/src`, `packages/tui/src`. Cross-checked against
`getSessionScope()`/`scopedSlot` usage and daemon reachability.

**Already scoped (prior commits on this branch, confirmed present, no
further action):**
- `config/settings.ts` — overrides/listeners keyed off `getSessionScope()`.
- `modes/theme/theme.ts` — theme cache, highlight cache, macOS-appearance,
  load-request counter all read `getSessionScope()` first (BLOCKER#3-5 +
  `efa53dff5`).
- `capability/rule.ts` `activeRules` — `getSessionScope()?.activeRules ?? activeRules`.
- `tools/image-gen.ts` `preferredImageProvider` — same `scopedSlot` pattern.
- `tools/report-tool-issue.ts` `autoQaConsentState` — same pattern.
- `packages/utils/src/dirs.ts` `projectDir`/`worktreesDirOverride` — replaced
  by `cwdScope` (`AsyncLocalStorage`), with `setProjectDir()` throwing instead
  of a raw `process.chdir()` when called with no active scope inside a
  daemon session (defense-in-depth, BLOCKER#2).
- `modes/daemon/socket-terminal.ts`, `utils/clipboard.ts` — session-gated per
  prior commits.

**Reviewed, left global — sharing does not change user-visible behavior:**
- `tools/github-cache.ts` `cachedDb`, `lsp/lspmux.ts` `cachedState` — process-
  level resource/capability caches (installed binaries, GitHub API cache),
  not per-user preference; identical content for every session.
- `tools/browser/launch.ts`, `tools/browser/readable.ts`, `tools/fetch.ts`
  `specialHandlersPromise` — lazy `import()` module-handle caches; loading
  the same module twice would just waste time, not change behavior.
- `mcp/timeout.ts` `neverAbortController` — a controller that is never
  aborted; sharing it across sessions has no observable effect.
- `modes/components/settings-defs.ts` `cachedDefs`, `settings-selector.ts`
  `cachedSidebarWidth` — derived from static setting-name lists, not from
  session/terminal state; deterministic regardless of caller.
- `modes/components/tool-execution.ts` `toolExecutionInstanceSeq`,
  `tools/sqlite-reader.ts` `nextSqliteRequestId`, `tools/resolve.ts`
  `pendingPreviewSeq` — monotonic ids used only for correlation/logging; a
  shared counter still produces unique ids across sessions, no correctness
  impact.
- `packages/utils/src/logger.ts`, `postmortem.ts` — intentionally
  process-wide (single log stream, single signal-handling state machine for
  the whole daemon); per-session logging is handled via structured fields, not
  separate logger instances.
- `tui/src/keybindings.ts` `globalKeybindings`, `tui/src/terminal.ts`
  `activeTerminal` and friends — part of the standalone `ProcessTerminal`/TUI
  bootstrap. The daemon's TUI branch uses a per-connection `SocketTerminal`
  (`daemon-host.ts:260`) instead, so these singletons are never reached from
  a shared-host session.
- `modes/theme/theme.ts` `themeWatcher`/`sigwinchHandler` — one real
  `fs.watch`/`SIGWINCH` per daemon process is correct (one config file, one
  terminal-adjacent process); the fix already re-dispatches the resulting
  event into each session's own scope, so the *source* being process-global
  is fine.

**Conclusion: no additional singleton regressions found.** The prior review
(`afa686af6`, `29d559007`, `efa53dff5`) already converted every mutable
singleton whose sharing would change user-visible behavior across concurrent
sessions.

## C. SQLite write path — AUDIT ONLY, NEEDS SIGN-OFF

`tools/sqlite-reader-worker.ts` `openDatabase()` (~lines 25-49): every write
request opens a **new** `bun:sqlite` connection with
`PRAGMA busy_timeout = 3000` and, for writable connections,
`PRAGMA journal_mode = WAL`. This is *already* addressed on this branch
(`BLOCKER-8`, commit `afa686af6`, documented further in `29d559007`) — WAL
was deliberately made unconditional (not daemon-gated) because the 2-slot
worker pool (`SQLITE_WORKER_POOL_MAX = 2`, `sqlite-reader.ts` ~842) already
dispatches concurrent read+write to the same file even in standalone mode.

Residual risk not yet decided (flagging for sign-off, not fixing):
1. **No `synchronous` pragma tuning.** WAL's default `synchronous=FULL`
   fsyncs on every commit; some teams deliberately drop to `NORMAL` under WAL
   (safe against app crash, not OS crash) for throughput. Not changed here —
   performance tradeoff, needs a decision.
2. **No WAL checkpoint schedule.** SQLite auto-checkpoints at ~1000 pages by
   default; a long-lived daemon with steady write traffic could grow the
   `-wal` sidecar file unboundedly between checkpoints if a reader holds a
   long-running transaction open. No explicit `wal_checkpoint` call exists.
3. **Every request opens a fresh connection** rather than reusing one per
   worker slot — each open pays the WAL/journal-mode setup cost again. Not a
   correctness issue, a minor throughput one.
4. **`busy_timeout = 3000`** (3s) is the only backpressure against
   `SQLITE_BUSY` beyond WAL's normal concurrency; under sustained write
   contention past that a request fails instead of queuing further. The
   2-slot worker pool bounds concurrent writers, so this is likely fine, but
   was not stress-tested as part of this sweep.

None of the above were changed. They are flagged for a human decision on
whether the current WAL-only mitigation is sufficient or whether
`synchronous=NORMAL` + an explicit checkpoint policy should be added.

## Verification

- `bun install` (fresh worktree, no lockfile change), `packages/natives`
  built locally (`bun run build`) to produce the native addon this repo
  requires — infra step, not a code change.
- `cd packages/coding-agent && bun check` — green (biome, docs index,
  `tsgo --noEmit`).
- `cd packages/coding-agent && bun run build` — green.
- `cd packages/coding-agent && bun test test/daemon` — 46 pass, 0 fail
  (existing suite; no new tests added since no code regression was found to
  fix — nothing to add a regression test for, per the "one test per real
  fix" instruction).

No code changes were required; this commit adds only this report.
