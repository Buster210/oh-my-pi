# PR Review — `ram-reduction` → `main` (maintainer summary)

## Maintainer verdict: 🔴 REQUEST CHANGES — not mergeable

Full review: `PR-REVIEW-ram-reduction.md`. This is the condensed verdict.

**The record.** Branch `ram-reduction`, 3 Ritesh commits, 77 files, +4691/−474. Thesis: sessions were each a full Bun process (RAM scales per-session) → make many sessions share one host process. Sound idea.

**The reaction.** Direction right, primitives genuinely good (`SessionScope`/ALS, settings copy-on-write, the `onExit` seam, MCP dedup — all sound; dedup verified race-safe). But it's a **~70%-done migration shipped as done.** The scoping conversion is incomplete in a repeating pattern, and a second session attaching would hit silent state corruption + a trivial host-OOM.

## 8 confirmed BLOCKERs
(all verified — capability one found by 2 reviewers + maintainer grep)

- **Capability ALS built, never wired** — `runWithCapabilityContext` has zero callers; every session shares one `disabledProviders`/`settings` → A's provider-disable writes into B's settings file.
- **`process.chdir` corrupts all sessions** — cwd-handshake timeout drops out of scope; `/move` → process-wide chdir. Fix is a one-liner (use the already-resolved `cwd`, not raw `clientCwd`).
- **Theme-change + settings broadcasts fire in the wrong session's ALS scope** — A's `/theme light` repaints B's UI.
- **Two theme fields left process-global** among their scoped siblings (`autoDetectedTheme`, `terminalReportedAppearance`).
- **Clipboard *read* path leaks the host clipboard across sessions** — write path fixed, reads forgotten → paste can surface another session's/operator's secrets. Privacy bug.
- **Uncapped socket frame length** → one client claims ~4 GB → host OOM. DoS.
- **"Offload SQLite *reads*" also moved writes** onto the same 2-slot pool, no WAL → new `SQLITE_BUSY`. Commit message is wrong.

## ~9 MAJORs
MCP `disconnectAll` leaks stale instructions into the system prompt forever; LSP idle-timeout is process-global and one session can disable it for all; daemon `server.on error → process.exit` kills the whole host; no write backpressure; unguarded 2nd connection though the header admits isolation is incomplete; worker-death hang; puppeteer load race; lost SQLite cancellation.

## Gate is RED
`bun check` fails (2 biome format), and types fail too (`TS2345` in the new daemon test; biome short-circuited so `bun check` never even reached types). Tests are green but cover *zero* concurrent-session paths — the suite passes with every blocker present.

## Process flags
- "Cut RAM ~48%" claim ships with **no committed benchmark** — the `bench/` harness that proves it is left untracked.
- `HANDOFF.md` describes a *different* effort (`native-lazy.ts`, commit `1eeb383` that doesn't exist here) — stale record in the tree.

## Path to merge
Split it — land the primitives + lazy MCP now; fix all 8 blockers with a real two-session test each; gate the daemon behind completed scoping or the single-connection guard; commit `bench/` with a before/after number; green the gate.

Net: keep the foundation, block the shared-host surface. Close in architecture, not in safety.
