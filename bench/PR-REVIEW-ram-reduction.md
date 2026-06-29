# PR Review — `ram-reduction` → `main`

**Reviewer verdict: 🔴 REQUEST CHANGES — do not merge.**

3 commits, 77 files, +4691/−474 (base `fef9b6`). Author: Ritesh Kumar Pal.
Reviewed against the committed diff (`git diff main...ram-reduction`), not the working tree.

---

## TL;DR

The *direction* is right and the *primitives* are genuinely well-built — `SessionScope`/AsyncLocalStorage, the settings copy-on-write override layering, the `onExit`-vs-`process.exit` plumbing, and the MCP lazy-connect dedup are all sound and well-tested. But this is a **half-finished migration presented as done.** The core promise — "many sessions can safely share one host process" — is not delivered: the session-scoping conversion is incomplete and unserialized in a systematic, repeating way. Some sibling fields got scoped and others didn't; an entire ALS was built and never wired; a write path was fixed while its read path was forgotten; broadcast listeners fire in the wrong session's scope.

**8 confirmed cross-session-bleed / host-integrity BLOCKERs**, several MAJORs, and the repo's own gate (`bun check`) is red. On top of that, the PR's entire justification — "cut RAM ~48%" — ships with **zero committed benchmark evidence**, and the daemon's own header comment admits single-connection is all that's actually in scope "for this phase," yet the server accepts unlimited concurrent connections with no guard.

This needs to be split and de-risked before any of the shared-host surface lands.

---

## What the PR does (the record)

OMP sessions were each a full Bun process — RAM scales linearly per session (CLAUDE.md gotcha #8). This branch makes **many sessions share one host process**:

1. `feat(utils,tui): per-session runtime primitives` — `SessionScope` + ALS + `scopedSlot`, session-scoped dirs/settings/theme/notifications.
2. `feat: session-scoped runtime, lazy MCP connect, shared-host TUI daemon` — the daemon host, socket-terminal, lazy MCP.
3. `feat(tools): offload SQLite reads to a dedicated worker thread`.

---

## What's good (credit where due)

- `session-scope.ts` — the `SessionScope`/`scopedSlot`/ALS mechanics are correct: per-connection scope objects, no retaining map, GC-clean on connection close. No leak.
- `settings.ts` — the `#overridesFor`/`#mutableOverridesFor`/`#rebuildMerged` copy-on-write design is correct and tested for *isolation*, not just happy path (incl. an in-flight-save race test). Shared last-write-wins to the single on-disk config is deliberate and documented.
- The `onExit` seam replacing `process.exit` across `rpc-mode.ts` / `input-controller.ts` / `interactive-mode.ts` is well-designed and correctly wired everywhere it's actually used — the author clearly understood that `process.exit`/`SIGSTOP` on a shared host kills every session.
- MCP lazy-connect dedup is **race-safe** — verified: no `await` before the pending-map/flag are set, so run-to-completion makes check-then-act atomic. No double-spawn.
- Postmortem contain-mode, the collab transport-interface extraction, and most of the "misc" file touches are correctly routed through `getSessionScope()`.

The disagreement is not with the approach. It's that the approach is ~70% applied and shipped as 100%.

---

## 🔴 BLOCKERS (8 confirmed)

### The recurring theme: incomplete session-scoping → cross-session bleed

**B1 — Capability context: ALS built, never wired.** `capability/index.ts:38-50,452-455`
*(found independently by 2 reviewers + maintainer grep: `runWithCapabilityContext` has ZERO callers repo-wide.)*
`capabilityALS` + `runWithCapabilityContext()` exist with a doc comment claiming the daemon isolates each session — but nothing ever calls `.run()`. `currentContext()` always resolves to the single module-level `defaultContext`. Every concurrent session shares one `settings` ref and one `disabledProviders` Set. Session A disables a provider → B sees it; B bootstraps after A → `defaultContext.settings` now points at B's `Settings`, so A's later `persistDisabledProviders()` **writes into B's settings file.** The ALS scaffolding gives a false impression the problem is solved.
Fix: wrap each daemon session in `runWithCapabilityContext(...)` in `daemon-host.ts`, or fold `settings`/`disabledProviders` into `SessionScope`.

**B2 — `process.chdir()` corrupts every session.** `daemon-host.ts:250-252`, `dirs.ts:193-203`
Line 250 already resolves a safe `cwd = clientCwd ?? sessionOptions.cwd ?? process.cwd()` — but line 252 then re-checks the raw `clientCwd` and, when the TUI cwd handshake times out (documented: a fresh client "never sends one"), runs the session **outside** `runWithProjectDir`. Inside that unscoped session, `setProjectDir()` (reachable live via `/move`) hits the no-store branch and calls process-wide `process.chdir()`, corrupting every other concurrent session's OS cwd — the exact failure `dirs.ts`'s own comment warns about.
Fix: one-liner — scope with the already-resolved `cwd`, not raw `clientCwd`; and/or block cwd-mutating paths when `cwdScope.getStore()` is absent.

**B3 — Theme-change broadcast fires in the wrong session's scope.** `theme.ts:2502-2505`, `interactive-mode.ts:1044-1058`
`notifyThemeChange()` is just `for (const cb of onThemeChangeCallbacks) cb(event)` — no scope capture. Each listener synchronously reads the scoped `theme` proxy resolving to *whatever ALS context is active at call time* = the firing session's. Session A runs `/theme light`; session B's editor border/status repaints with A's colors until B recomputes on its own.
Fix: capture each subscriber's `SessionScope` at registration and `runWithSessionScope(captured, () => cb(event))` per listener.

**B4 — Same broadcast bug in `settings.ts` `SettingSignal`.** `settings.ts:1472-1500,1570-1576`, `interactive-mode.ts:1037-1039`
Module-level `statusLineSessionAccentSignal.fire()` invokes every session's listener synchronously in the firing session's ALS context → `updateEditorBorderColor()` reads the wrong session's theme/settings. Same root cause as B3, triggered by a settings change.
Fix: same capture-and-re-enter pattern, or a per-session drain queue.

**B5 — Two theme fields left process-global among scoped siblings.** `theme.ts:2110,2256`
`theme`, `currentThemeName`, `currentColorBlindMode`, `autoDarkTheme`, `autoLightTheme` (+1) were converted to `scopedSlot(...)`. `autoDetectedTheme` (`var`, 2256) and `terminalReportedAppearance` (`var`, 2110) were **not**. Session B calling `enableAutoTheme()` flips the flag process-wide; session A (which picked a static theme) gets auto-switching silently re-enabled on the next appearance event.
Fix: `scopedSlot` both, like their six siblings.

**B6 — Clipboard READ path leaks the host's clipboard across sessions.** `clipboard.ts:302-345`
The *write* path was correctly scoped through `getSessionScope()?.terminalOut` (with a comment about cross-contamination) — but the three *read* functions (`readImageFromClipboard`, `readTextFromClipboard`, `readMacFileUrlsFromClipboard`) were left calling `pbpaste`/native/PowerShell directly. `input-controller.ts` (now reused for daemon sessions) wires these into Ctrl+V. Under the shared host a session's paste reads the **host machine's OS clipboard**, surfacing another session's or the operator's clipboard — possibly secrets — into an unrelated session's transcript. This is a **privacy/security** issue, not just a correctness one.
Fix: gate all three reads the same way the write path was; return empty / route via a socket-terminal paste channel when `terminalOut` is set.

### Host integrity

**B7 — Unbounded socket frame length → shared-host OOM (DoS).** `socket-terminal.ts:120-127`
`#ingest` reads a 32-bit BE length (`readUInt32BE(1)`, no cap) and `Buffer.concat`s until that many bytes arrive. A client — or a desynced/corrupted stream — claiming `len ≈ 4 GB` with slow follow-up grows the buffer without limit; a single connection exhausts the host and kills every session it serves.
Fix: reject/destroy the socket when `len` exceeds a sane max (e.g. 1–10 MB) before buffering.

### Data-layer honesty

**B8 — "Offload SQLite *reads*" also silently offloads *writes* onto the same pool.** `sqlite-reader-worker.ts:70-89`, `sqlite-reader.ts:842`
`write.ts` no longer opens any `Database` itself — `insertRow`/`updateRow*`/`deleteRow*` were all moved onto the **same 2-slot worker pool** as reads. The worker opens a writable connection per write and readonly per read; with `POOL_MAX=2` a read and a write genuinely run concurrently on two OS threads against one file. **No `journal_mode=WAL`** anywhere — only `busy_timeout=3000` guards the writer-exclusive lock. A read + write dispatched to both slots at once now surfaces `SQLITE_BUSY` where it previously couldn't (write.ts used to hold one connection for its whole read-then-write flow). The commit message is also misleading — it says "reads."
Fix: keep writes on the main thread or a single-slot *separate* writer worker; if writes must be offloaded, enable WAL or serialize writers — and fix the commit message.

---

## 🟠 MAJORS

- **Shared theme request-counter cross-cancels sessions.** `theme.ts:2283-2284` — module-global `themeLoadRequestId` compared inside `setTheme`/`previewTheme`/etc. Session B's theme call bumps the counter while A awaits `loadTheme`, so A's request is discarded as "superseded" though nothing in A superseded it. Scope it.
- **MCP `disconnectAll()` leaks deferred state → stale instructions forever.** `manager.ts:886-907` — clears connections but not `#deferredConfigs`/`#deferredSnapshots`/`#lazyConnectTriggered`. After `/mcp reload` with a server removed from `.mcp.json`, its cached instructions keep being injected into the system prompt indefinitely; and lazy-defer silently dies for the rest of the process. Add the three clears.
- **LSP idle-timeout is process-global.** `lsp/client.ts:30-56` — `setIdleTimeout()` (called per-session warmup) mutates one shared `idleTimeoutMs`/interval. Any session resolving `null`/`0` calls `stopIdleChecker()` and **disables idle-shutdown for every other session's LSP clients** — directly undermining this PR's RAM goal. Scope it or make the checker per-client.
- **Daemon server error kills the whole host.** `daemon-host.ts:334-337` — `server.on("error", … process.exit(1))` fires for runtime errors too (e.g. `EMFILE` under fd churn), tearing down every live session. Distinguish one-shot listen-failure (fatal) from runtime errors (log + survive).
- **No socket write backpressure.** `socket-terminal.ts:176-183` — `socket.write()` return value ignored; a slow/stalled client lets Node buffer unboundedly on the host — another host-wide memory vector. Honor `false`/`'drain'`.
- **No guard on the documented single-TUI assumption.** `daemon-host.ts:212-302` — header says single-connection is all that's isolated "this phase," but `net.createServer` accepts unlimited connections. Two concurrent TUI clients silently share the not-yet-isolated singletons (B1–B6). Reject the 2nd TUI socket until isolation is complete.
- **Worker-death handling gap (SQLite).** `sqlite-reader.ts:856-862` — pool slot wires `onmessage`/`onerror` but not `messageerror`/`close`. On OOM-kill / native crash / clone failure, `slot.busy` stays set and the in-flight promise hangs until the 12s timeout; with only 2 slots, a second dead slot stalls all sqlite requests. Mirror `context-manager.ts`'s `wrapBunWorker`.
- **Puppeteer first-load race.** `browser/launch.ts:66-90` — `if (puppeteerModule) return` with no single-flight guard; two sessions' concurrent first browser call both patch the shared `process.cwd` in interleaved `withPatchedCwd` calls, reintroducing the cosmiconfig crash this function exists to prevent. Use an in-flight `Promise`.
- **SQLite reads lost cancellation.** `read.ts:1799-1917` — `signal` is no longer threaded past the entry check; `queueSqliteWorkerRequest` only takes `timeoutMs`. An aborted read still runs to completion (up to 12s) occupying 1 of 2 shared slots, starving other sessions. Thread `signal` into `SqliteWorkerCallOptions` and reject+free on abort.

## 🟡 MINORS / NITS

- Unbounded `sqliteWorkerQueue` — no depth cap; a burst (more likely under shared host) piles up before anything rejects. `sqlite-reader.ts:~970`.
- `#connectionOrWake` swallows failures silently (`catch { return undefined }`) with no retry/log → permanent, indistinguishable-from-not-found failure. `manager.ts:1333-1342`.
- **Stale comments that actively mislead** — three doc comments are already wrong *within this same PR* and point a future debugger at the wrong branch: `dirs.ts:633` (claims RPC falls through to global; daemon-host always scopes it), and `notification-suppression.ts:8-10` (claims "nobody wraps" — `main.ts` and `daemon-host.ts` both do). Fix or delete.
- `getTools()` wakes *every* deferred MCP server, not just the one being used — "lazy" is really "lazy until the next `getTools()` for any reason," coarser than the per-server "first tool call" model advertised. Dents the RAM story; worth a callout.

---

## Gate status — 🔴 RED

`bun check` = `biome check && check:docs && check:types`:
- **biome format fails (2):** `daemon-host.ts:263`, `test/daemon/socket-terminal.test.ts:126` — new files never run through the formatter.
- Because biome short-circuits, **`check:types` was never reached by `bun check`.** Run alone it also fails: **`test/daemon/socket-terminal.test.ts:37` — `TS2345`** (test stub's `(fn: () => void) => void` not assignable to `<T>(fn: () => T) => T`).
- `bun test` on the touched suites *is* green (daemon 44/44, sqlite 31/31) — but the tests only cover happy/sequential paths. Not one test spins up two concurrent daemon connections, sends an oversized frame, or races a read against a write — i.e. no test exercises any of the 8 blockers.

The PR does not pass the repo's own documented check. CI would be red.

---

## Process / hygiene (maintainer flags)

- **No evidence for the central claim.** The whole PR is justified by "cut RAM ~48% (521→273 MB)," but there is **no benchmark in the diff**, and the `bench/` harness that would prove it (`daemon-ram-test.sh`, `mem-bench.sh`, `heap-probe.ts`) is left **untracked and not gitignored** — floating in the tree. An extraordinary architectural change (shared-host daemon) needs its measurement committed and a before/after number in the PR body.
- **`HANDOFF.md` is stale/orphaned** — it narrates a *different* effort (a `native-lazy.ts` binary-deferral, "commit `1eeb383`") that **does not exist in this repo** and touches no file in this PR. Either it belongs to abandoned work (delete it) or the branch is missing commits it claims. Untracked, so not in the "PR" — but confusing to leave in the tree.
- **Commit granularity/messages.** Three commits for one logical change is fine, but commit 3's message ("offload SQLite reads") is factually wrong (it moved writes too — B8). Fix before merge.
- `scripts/ompp` (untracked dev wrapper) — decide: commit under a dev-tools path or gitignore.

---

## Recommended path to merge

The primitives are worth keeping. The shared-host surface is not ready. I'd split:

1. **Land now (low-risk), separately:** `SessionScope`/`scopedSlot`, settings override layering, the `onExit` seam, lazy MCP connect *minus* the `disconnectAll` leak (fix that first). These are self-contained and tested.
2. **Fix before the daemon lands — all 8 blockers**, with a test each that actually exercises two concurrent sessions (the current suite would pass even with every blocker present). The capability + theme-broadcast + clipboard-read bugs are the load-bearing ones.
3. **Gate the daemon behind completion:** until every process-global singleton is scoped *and* audited, either enforce the single-TUI-connection guard the header comment already assumes, or don't expose `net.createServer` to a second connection.
4. **Commit `bench/` and put a before/after RAM number in the PR.** No perf merge without the measurement it claims.
5. Green the gate (`biome` + `tsgo`), fix the misleading commit message and the three stale comments.

Net: right idea, sound foundation, **not mergeable as-is** — it would ship silent cross-session state corruption and a trivial host-OOM the moment a second session attaches.
