# MCP + LSP shared-host parity — findings

Baseline: `main` (`fef9b6233`). Branch under test: `ram-reduction` (`d3e071dcf`).

## 1. MCP `disconnectServer` leaked deferred state — REGRESSION, fixed

`packages/coding-agent/src/mcp/manager.ts` `disconnectServer()` cleared
`#pendingConnections`, `#pendingToolLoads`, `#pendingReconnections`, `#sources`,
`#serverConfigs`, `#pendingResourceRefresh`, `#reconnectHistory` for the named
server, but never touched `#deferredConfigs` / `#deferredSnapshots` (both new
in `ram-reduction`'s lazy-connect feature; `disconnectAll()` already clears
all three deferred fields correctly).

Concrete bug traced: if the disconnected server was still in its deferred
(never-yet-connected) window, its stale entry survives in `#deferredConfigs`.
The next `getTools()` call anywhere in that session invokes
`#ensureConnected()`, which iterates `#deferredConfigs` and reconnects
everything in it — silently resurrecting a server the caller just explicitly
disconnected. Separately, `#deferredSnapshots` kept serving that server's
stale cached instructions/prompts/resources through `getServerInstructions()`,
`getServerPrompts()`, `#connectionOrWake()`, etc. after disconnect.

Fix: `disconnectServer(name)` now also calls `#deferredConfigs.delete(name)`
and `#deferredSnapshots.delete(name)`, mirroring what `disconnectAll()` already
does per-map. `#lazyConnectTriggered` is deliberately left untouched — it's a
session-wide one-shot flag (not per-server) that only gates whether the
initial deferred-connect window is still open; removing one server's deferred
entry doesn't change whether that window is open, so there is nothing to
reset for it here (see `ponytail:` comment at the call site).

Test added: `test/mcp-lazy-connect.test.ts` — "disconnectServer clears one
server's deferred state without resurrecting it" (reuses the existing
`disconnectAll` test's cache/config fixture pattern). Green.

## 2. LSP idle-timeout (`lsp/client.ts` ~30-56) — NOT a regression

Diffed against `main`: the idle-timeout mechanism was already converted from
a single process-global `idleTimeoutMs` + one shared `setInterval` sweeping
all clients (the `main` shape) to per-client scoping:
- `idleTimeoutByCwd: Map<string, number | null>` — timeout value keyed by cwd,
  set via `setIdleTimeout(cwd, ms)`, read once per client at creation time
  (comment at the read site explains why keying by cwd instead of one shared
  global avoids a second session's `setIdleTimeout` call stomping a value
  another cwd's in-flight client creation is about to read).
- Each `LspClient` carries its own `idleCheckInterval` and its own
  `setInterval` closure checks only `client.lastActivity` for that one client,
  clearing itself on process exit.

This already gives correct per-session/per-cwd behavior in the shared host —
no session can time out another session's client, and no client is exempt
from ever idling. No change made; confirmed via `git diff fef9b6233 -- lsp/client.ts`.

## 3. Lazy-connect dedup — confirmed, no regression

`#lazyConnectTriggered` is set exactly once per `MCPManager` instance inside
`#ensureConnected()`, and every entry path (`getTools()`, `waitForConnection()`,
`#connectionOrWake()`) funnels through that same guarded method — connects the
deferred batch exactly once per manager (i.e. per session, since
`MCPManager.getInstance()` resolves to `getSessionScope()?.mcpManager` under
`AsyncLocalStorage`). No tool call path bypasses the guard. Existing test
suite (`mcp-lazy-connect.test.ts`) already covers the single-connect and
reconnect-after-disconnectAll cases; both still pass.

## Verify

- `bun test test/mcp-lazy-connect.test.ts` — 8 pass, 0 fail (incl. new test).
- `biome check .` — clean, no fixes needed.
- `bun run check:types` (tsgo) and `bun run build` (native embed step) both
  fail in this worktree — confirmed **pre-existing**, identical failure with
  the fix stashed out: `bun-types` is missing from this worktree's
  `node_modules` (`tsgo` can't find the `bun` type-lib entry point) and the
  Rust native addon (`pi_natives.darwin-arm64.node`) isn't built for this
  worktree's package version. Both are environment/workspace-install gaps
  unrelated to this diff, not something to paper over by touching the
  lockfile or rebuilding native crates under a "regressions only" scope.
