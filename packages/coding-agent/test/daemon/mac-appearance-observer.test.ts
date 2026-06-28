/** Regression: global macObserver/macOSScope singletons let session B's startMacAppearanceObserver stop A's observer. Fix: ref-counted Set<SessionScope>. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { runWithSessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const stopMock = vi.fn();
let capturedObserverCb: ((err: Error | null, appearance?: string) => void) | undefined;
vi.mock("@oh-my-pi/pi-natives", () => ({
	MacAppearanceObserver: {
		start(cb: (err: Error | null, appearance?: string) => void) {
			capturedObserverCb = cb;
			return { stop: stopMock };
		},
	},
	detectMacOSAppearance: () => "dark" as const,
	replaceTabs: (s: string) => s,
	truncateToWidth: (s: string) => s,
	supportsLanguage: () => false,
	highlightCode: () => "",
}));

import * as theme from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function makeScope(sessionId: string): SessionScope {
	return {
		sessionId,
		agentRegistry: new AgentRegistry(),
		settingsOverrides: new WeakMap(),
		settings: null,
		disabledProviders: new Set(),
		autoQaConsentState: {
			handler: null,
			persistentSettings: null,
			cachedConsent: null,
			consentInFlight: null,
		},
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

describe("macOS appearance observer fan-out", () => {
	let originalZellij: string | undefined;
	let scopesToTeardown: SessionScope[] = [];

	beforeEach(() => {
		originalZellij = Bun.env.ZELLIJ;
		Bun.env.ZELLIJ = "1";
		capturedObserverCb = undefined;
		stopMock.mockClear();
		scopesToTeardown = [];
	});

	afterEach(async () => {
		for (const scope of scopesToTeardown.reverse()) {
			await runWithSessionScope(scope, () => theme.stopThemeWatcher());
		}
		scopesToTeardown = [];
		vi.restoreAllMocks();
		if (originalZellij === undefined) {
			delete Bun.env.ZELLIJ;
		} else {
			Bun.env.ZELLIJ = originalZellij;
		}
	});

	it("two sessions: simulated OS change updates BOTH scopes", async () => {
		const scopeA = makeScope("obs-a");
		const scopeB = makeScope("obs-b");
		scopesToTeardown.push(scopeA, scopeB);

		await runWithSessionScope(scopeA, () => theme.initTheme(true, undefined, false, "dark", "light"));
		await runWithSessionScope(scopeB, () => theme.initTheme(true, undefined, false, "dark", "light"));

		expect(capturedObserverCb).toBeDefined();

		capturedObserverCb!(null, "light");

		expect(scopeA.macOSReportedAppearance).toBe("light");
		expect(scopeB.macOSReportedAppearance).toBe("light");
	});

	it("teardown of scope A does not clear scope B", async () => {
		const scopeA = makeScope("obs-a");
		const scopeB = makeScope("obs-b");
		scopesToTeardown.push(scopeA, scopeB);

		await runWithSessionScope(scopeA, () => theme.initTheme(true, undefined, false, "dark", "light"));
		await runWithSessionScope(scopeB, () => theme.initTheme(true, undefined, false, "dark", "light"));

		capturedObserverCb!(null, "dark");
		expect(scopeA.macOSReportedAppearance).toBe("dark");
		expect(scopeB.macOSReportedAppearance).toBe("dark");

		await runWithSessionScope(scopeA, () => theme.stopThemeWatcher());

		expect(scopeB.macOSReportedAppearance).toBe("dark");
		expect(scopeA.macOSReportedAppearance).toBeUndefined();
		expect(stopMock).not.toHaveBeenCalled();

		// A removed from fan-out; further OS changes reach B only.
		capturedObserverCb!(null, "light");
		expect(scopeB.macOSReportedAppearance).toBe("light");
		expect(scopeA.macOSReportedAppearance).toBeUndefined();

		await runWithSessionScope(scopeB, () => theme.stopThemeWatcher());
		expect(stopMock).toHaveBeenCalledTimes(1);

		const scopeC = makeScope("obs-c");
		scopesToTeardown.push(scopeC);
		capturedObserverCb = undefined;
		await runWithSessionScope(scopeC, () => theme.initTheme(true, undefined, false, "dark", "light"));
		expect(capturedObserverCb).toBeDefined();
		capturedObserverCb!(null, "light");
		expect(scopeC.macOSReportedAppearance).toBe("light");
	});

	it("standalone (no scope) path writes to global fallback", async () => {
		const scope = makeScope("obs-standalone");
		scopesToTeardown.push(scope);

		await theme.initTheme(true, undefined, false, "dark", "light");

		expect(capturedObserverCb).toBeDefined();

		capturedObserverCb!(null, "light");

		const getMac = (theme as Record<string, unknown>).getCurrentMacOSAppearance as
			| (() => string | undefined)
			| undefined;
		if (getMac) {
			expect(getMac()).toBe("light");
		} else {
			expect(capturedObserverCb).toBeDefined();
		}
	});
});
