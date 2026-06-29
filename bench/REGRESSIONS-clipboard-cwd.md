# Regressions sweep — clipboard + cwd/dirs parity (main → ram-reduction)

Baseline: `main` @ `fef9b6233`. Target: `ram-reduction` @ `d3e071dcf` (this worktree, fast-forwarded from the `d806ac5e4` base it was created at — `d806ac5e4` is an ancestor of `ram-reduction`, so no rebase/merge was needed, just `git merge --ff-only ram-reduction`).

Result: **no unfixed regressions found.** Each lead below was already fixed by an earlier commit on this branch, prior to this sweep. No code changes made; only this report is added.

## Lead 1 — clipboard READ path unscoped

**Not a regression — already fixed.**

`packages/coding-agent/src/utils/clipboard.ts`: `readMacFileUrlsFromClipboard`, `readImageFromClipboard`, and `readTextFromClipboard` each open with:

```ts
if (getSessionScope()?.terminalOut) return [];   // / null / ""
```

`git diff main -- packages/coding-agent/src/utils/clipboard.ts` confirms this gate is new on this branch (absent on `main`), and the WRITE path (`copyToClipboard`) has the matching `sink` branch that redirects to OSC 52 instead of the host clipboard. Read and write are symmetrically scoped — a daemon session with `terminalOut` set never touches the host's `pbpaste`/native/PowerShell clipboard.

Landed in `5bc796d4c` era work (async clipboard read) plus the daemon-scoping gate added alongside `e7e4c4b80 feat(coding-agent): session-scoped runtime for shared-host daemon`.

Verified: `packages/coding-agent/test/utils/clipboard.test.ts` (part of `29d559007`) exercises the gated paths; `bun test test/utils/clipboard.test.ts` — 33 tests pass (see Verification below, run together with the daemon suites).

## Lead 2 — cwd resolution / `daemon-host.ts` / `process.chdir`

**Not a regression — already fixed** (was a real blocker, since resolved).

`packages/coding-agent/src/modes/daemon/daemon-host.ts:275` (TUI branch):
```ts
const cwd = clientCwd ?? options.sessionOptions.cwd ?? process.cwd();
...
const runScoped = <T>(fn: () => T): T => runWithProjectDir(cwd, fn);
```
The resolved `cwd` — never raw `clientCwd` — is what's threaded into `runWithProjectDir`. `PR-REVIEW-ram-reduction.md` (committed on this branch, dated before the fix) documents this exact bug as BLOCKER #2: a prior version re-checked raw `clientCwd` after resolving `cwd`, so a handshake timeout left the session running outside `runWithProjectDir` entirely, and a later `/move` hit `dirs.ts`'s unguarded `process.chdir()` fallback, corrupting every other concurrent session's OS cwd.

Fixed in `29d559007 fix(daemon): wire real capability context + close RPC chdir gap` (B2): the RPC/ACP branch (line ~338, no client-cwd handshake in that transport) now *always* calls `runWithProjectDir(cwd, fn)` with `cwd = options.sessionOptions.cwd ?? process.cwd()` — never skipped. Confirmed via `git show 29d559007 -- packages/coding-agent/src/modes/daemon/daemon-host.ts`.

`process.chdir` is called in exactly one place project-wide (`packages/utils/src/dirs.ts`, `setProjectDir`'s no-store fallback), and only reached when there is no `cwdScope` store *and* no `daemonSessionScope` marker — i.e. never inside a daemon connection, since both daemon branches now always wrap in `runWithProjectDir` (which pushes a `cwdScope` store) before running session code.

Note (not a regression, pre-existing scope limit, out of task scope): the RPC transport itself has no per-connection client-cwd handshake (unlike the TUI branch's `SocketTerminal.waitForCwd`), so all RPC connections to one daemon share `options.sessionOptions.cwd` (the daemon's launch-time cwd) rather than each client's own directory. This is a transport-level limitation, not a cross-session *leak* (every session still gets a correctly-scoped, consistent cwd — just the same one) and isn't one of the three named leads; flagging for awareness only, no fix applied.

Verified: `packages/coding-agent/test/daemon/concurrent-session.test.ts`, `packages/utils/test/daemon-session-scope-guard.test.ts` (added by `29d559007`) both pass — see Verification below.

## Lead 3 — `packages/utils/dirs.ts` per-session dir scoping

**Not a regression — already correctly scoped.**

`getProjectDir()`/`setProjectDir()` are backed by an `AsyncLocalStorage<{cwd, worktreesDir}>` (`cwdScope`). Inside a daemon session (a `cwdScope` store present), `setProjectDir` mutates only that store's `cwd`, never the module-level `projectDir` global and never `process.chdir()`. Outside any scope (standalone CLI), behavior is byte-identical to `main` (falls through to the same module-global + `process.chdir()` path `main` always used).

Defense-in-depth confirmed present: if `setProjectDir` is ever called inside `daemonSessionScope` with no `cwdScope` store (a caller bug — the session wasn't wrapped in `runWithProjectDir`), it throws instead of silently corrupting every other session's OS cwd via `process.chdir()`.

`setWorktreesDir`/`getWorktreesDir` ride the same `cwdScope` ALS; a `ponytail:` comment at `dirs.ts:645` already documents the one known gap (RPC sessions fall through to the module global for `worktreesDir`, same as `getProjectDir`/`setProjectDir` already did pre-fix) and names the upgrade path. Not a regression — a documented, deliberate scope boundary matching the RPC transport's existing cwd-handshake limitation from Lead 2.

`setProfile`/`setAgentDir` are guarded separately: both throw (`assertNotDaemonScoped`) when called inside `daemonSessionScope`, so a daemon session can't silently repoint every other session's config root via a profile switch.

Verified: `packages/utils/test/project-dir-scope.test.ts`, `packages/utils/test/daemon-session-scope-guard.test.ts` pass.

## Verification

- `bun install` (no lockfile change — clean `git status` before/after) + native addon build (`packages/natives`: `bun run build`, darwin-arm64) to provision this fresh worktree.
- `cd packages/coding-agent && bun run build` — green.
- `cd packages/coding-agent && bun check` (biome + docs-index + tsgo) — green, no fixes applied.
- `cd packages/coding-agent && bun test test/utils/clipboard.test.ts test/daemon/concurrent-session.test.ts test/daemon/session-scope.test.ts` — 33 pass, 0 fail.
- `cd packages/utils && bun test test/project-dir-scope.test.ts test/daemon-session-scope-guard.test.ts` — 9 pass, 0 fail.

No isolation test was added — no code fix was needed, so there is nothing new to regression-test; the existing tests above already cover the isolation guarantees for all three leads and were run to confirm they still pass on this checkout.
