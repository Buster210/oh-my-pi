/**
 * Proves the daemon's per-session theme scoping (M2b) is isolated and
 * byte-identical when no scope is active:
 *
 * 1. Two concurrently-active scopes each set a different theme via
 *    `setThemeInstance()`; `getCurrentThemeName()` and the `theme` export
 *    (a stable Proxy that delegates to `getSessionScope()?.theme`) resolve to
 *    each scope's own theme, never the other's.
 * 2. Outside any scope, `theme`/`getCurrentThemeName()` fall back to the
 *    module-level global, untouched by either scope's write.
 */
import { describe, expect, it } from "bun:test";
import { getActiveRules, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { SessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { runWithSessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import {
	getAutoThemeMapping,
	getCurrentThemeName,
	getThemeByName,
	getThemeEpoch,
	setAutoThemeMapping,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	setThemeInstance,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

function makeScope(sessionId: string): SessionScope {
	return {
		sessionId,
		agentRegistry: new AgentRegistry(),
		settingsOverrides: new WeakMap(),
		settings: null,
		disabledProviders: new Set(),
		autoQaConsentState: { handler: null, persistentSettings: null, cachedConsent: null, consentInFlight: null },
		mcpManager: undefined,
		asyncJobManager: undefined,
		activeRules: [],
		activeSkills: [],
		preferredSearchProvider: "auto",
		excludedSearchProviders: new Set(),
		preferredImageProvider: "auto",
		theme: undefined,
		currentThemeName: undefined,
		currentSymbolPresetOverride: undefined,
		currentColorBlindMode: false,
		autoDarkTheme: "dark",
		autoLightTheme: "light",
		autoDetectedTheme: false,
		terminalReportedAppearance: undefined,
		macOSReportedAppearance: undefined,
		themeLoadRequestId: 0,
		themeEpoch: 0,
		hostUriHandlers: new Map(),
	};
}

describe("theme session scope isolation", () => {
	it("two scopes setting different themes never see each other's, and the outside global is untouched", async () => {
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("Expected built-in dark and light themes to exist");

		// Snapshot the standalone (no-scope) state to prove it's untouched after.
		setThemeInstance(dark);
		const outsideNameBefore = getCurrentThemeName();
		const outsideFgBefore = theme.fg("accent", "x");

		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => setThemeInstance(dark));
		runWithSessionScope(scopeB, () => setThemeInstance(light));

		expect(runWithSessionScope(scopeA, () => getCurrentThemeName())).toBe("<in-memory>");
		expect(runWithSessionScope(scopeA, () => theme.fg("accent", "x"))).toBe(dark.fg("accent", "x"));
		expect(runWithSessionScope(scopeB, () => theme.fg("accent", "x"))).toBe(light.fg("accent", "x"));

		// The two scopes' rendered output differs (dark vs light really are different themes).
		expect(runWithSessionScope(scopeA, () => theme.fg("accent", "x"))).not.toBe(
			runWithSessionScope(scopeB, () => theme.fg("accent", "x")),
		);

		// Outside any scope, nothing changed — same name and same rendered output as before.
		expect(getCurrentThemeName()).toBe(outsideNameBefore);
		expect(theme.fg("accent", "x")).toBe(outsideFgBefore);
	});

	it("two scopes setting different autoDarkTheme never see each other's, and the outside global is untouched", () => {
		const outsideBefore = getAutoThemeMapping("dark");

		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => setAutoThemeMapping("dark", "theme-a"));
		runWithSessionScope(scopeB, () => setAutoThemeMapping("dark", "theme-b"));

		expect(runWithSessionScope(scopeA, () => getAutoThemeMapping("dark"))).toBe("theme-a");
		expect(runWithSessionScope(scopeB, () => getAutoThemeMapping("dark"))).toBe("theme-b");

		// Outside any scope, the module global is untouched by either scope's write.
		expect(getAutoThemeMapping("dark")).toBe(outsideBefore);
	});

	// Sanity check this test file follows the same ALS isolation contract as
	// the other scoped singletons (session-scope.test.ts), not just theme.
	it("activeRules set inside the theme test's scopes stays isolated too", () => {
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");
		const source = { provider: "test", providerName: "Test", path: "/rules", level: "user" as const };
		const rulesA = [{ name: "a", path: "/a", content: "a", _source: source }];

		runWithSessionScope(scopeA, () => setActiveRules(rulesA));
		expect(runWithSessionScope(scopeA, () => getActiveRules())).toBe(rulesA);
		expect(runWithSessionScope(scopeB, () => getActiveRules())).not.toBe(rulesA);
	});

	// BLOCKER #8: themeLoadRequestId used to be a module-global that would get
	// clobbered by concurrent sessions. Session A's theme load could be wrongly
	// discarded as "superseded" when session B triggered another theme load.
	// This test proves the request counter is session-scoped by verifying that
	// incrementing in one session does not affect another's counter.
	it("theme load request IDs are isolated per session", async () => {
		// Test the counter isolation directly - this is the contract that prevents
		// cross-session cancellation in setTheme/previewTheme/setSymbolPreset/setColorBlindMode.
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		expect(scopeA.themeLoadRequestId).toBe(0);
		expect(scopeB.themeLoadRequestId).toBe(0);

		await runWithSessionScope(scopeA, async () => {
			const result = await setTheme("dark");
			expect(result.success).toBe(true);
		});
		expect(scopeA.themeLoadRequestId).toBe(1);
		expect(scopeB.themeLoadRequestId).toBe(0); // B's counter unchanged

		await runWithSessionScope(scopeB, async () => {
			const result = await setTheme("light");
			expect(result.success).toBe(true);
		});
		expect(scopeA.themeLoadRequestId).toBe(1); // A's counter unchanged
		expect(scopeB.themeLoadRequestId).toBe(1);

		await runWithSessionScope(scopeA, async () => {
			await setTheme("dark");
		});
		await runWithSessionScope(scopeB, async () => {
			await setTheme("light");
		});
		expect(scopeA.themeLoadRequestId).toBe(2);
		expect(scopeB.themeLoadRequestId).toBe(2);
	});

	// BLOCKER #9: epoch was a module-global; session A's bump corrupted B's memoized renderers.
	it("theme epoch is isolated per session", async () => {
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		expect(runWithSessionScope(scopeA, () => getThemeEpoch())).toBe(0);
		expect(runWithSessionScope(scopeB, () => getThemeEpoch())).toBe(0);

		// Bump epoch in scope A
		await runWithSessionScope(scopeA, async () => {
			await setColorBlindMode(true);
		});
		expect(runWithSessionScope(scopeA, () => getThemeEpoch())).toBe(1);
		expect(runWithSessionScope(scopeB, () => getThemeEpoch())).toBe(0); // B's epoch unchanged

		// Bump epoch in scope B - should be independent from A
		await runWithSessionScope(scopeB, async () => {
			await setSymbolPreset("nerd");
		});
		expect(runWithSessionScope(scopeA, () => getThemeEpoch())).toBe(1); // A's epoch unchanged
		expect(runWithSessionScope(scopeB, () => getThemeEpoch())).toBe(1);
	});
});
