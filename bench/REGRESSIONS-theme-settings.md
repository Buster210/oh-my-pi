# Theme/Settings Per-Session Scope Parity — Regression Report

Branch: `ram-reduction` vs `main` (fork point `fef9b6233`)

## Found & Fixed

### 1. `macOSReportedAppearance` — process-global var leaked across sessions
- **File:** `packages/coding-agent/src/modes/theme/theme.ts` (~line 2115)
- **Was:** `var macOSReportedAppearance: "dark" | "light" | undefined;`
- **Fix:** Converted to `scopedSlot("macOSReportedAppearance", undefined)`. The macOS appearance observer callback (process-level OS handle) captures the startup scope and re-enters it when firing, so appearance updates land in the correct session.

### 2. `themeEpoch` — process-global counter leaked across sessions
- **File:** `packages/coding-agent/src/modes/theme/theme.ts` (~line 2287)
- **Was:** `let themeEpoch = 0;`
- **Fix:** Converted to `scopedSlot("themeEpoch", 0)`. Each session's theme changes bump only that session's epoch, preventing cross-session render cache invalidation.

### 3. SessionScope + all test factories updated
- Added `macOSReportedAppearance` and `themeEpoch` fields to `SessionScope` interface and every `makeScope()`/`newSessionScope()` factory (6 files).

## Not Regressions (investigated, left as-is)

### Theme-change broadcast listeners (`onThemeChange` / `SettingSignal`)
Already correctly scoped. `onThemeChange()` captures `getSessionScope()` at registration and `notifyThemeChange()` re-enters each listener's captured scope. `SettingSignal.on()` captures scope at subscription time and `fire()` re-enters it. No bleed.

### `autoDetectedTheme` / `autoDarkTheme` / `autoLightTheme`
Already converted to `scopedSlot` by the ram-reduction branch. Not a regression.

### `terminalReportedAppearance`
Already converted to `scopedSlot` by the ram-reduction branch. Not a regression.

### `themeWatcher` / `themeReloadTimer` / `sigwinchHandler` — process-global
Intentionally process-global. These are OS-level handles (`fs.watch`, `process.on("SIGWINCH")`) that cannot be duplicated per AsyncLocalStorage scope. The ponytail comments document the limitation: only the most-recently-initialized session's live-reload works; theme *colors* remain scoped. Upgrade path noted in comments.

## Test Fix

The theme-epoch isolation test (`theme-session-scope.test.ts`) had an incorrect expected value — it expected scope B's epoch to be 2 (cumulative across scopes) but each scope has its own independent counter, so the correct expected value is 1. Fixed and verified.

## Verification

- `bun run build` — green
- `bun check` (biome + tsgo) — green
- `bun test test/daemon/` — 47/47 pass
- `bun test src/config/settings.test.ts` — 5/5 pass
- `bun test test/utils/clipboard.test.ts` — 19/19 pass
