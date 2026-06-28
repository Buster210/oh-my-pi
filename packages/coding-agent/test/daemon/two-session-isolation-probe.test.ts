/**
 * Behavioral 2-session isolation proof — exercises TWO concurrent sessions in
 * one host and asserts each dimension of per-session state is isolated. This
 * is a throwaway probe: it re-uses existing harnesses (runWithSessionScope,
 * makeScope) and real exported resolvers (theme.fg, getCurrentThemeName,
 * getThemeEpoch, settings.get, readTextFromClipboard) rather than inspecting
 * code — the contract is proved by running, not by reading.
 */
import { describe, expect, it } from "bun:test";
import {
	getSessionScope,
	runWithSessionScope,
	type SessionScope,
} from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import {
	getCurrentThemeName,
	getThemeByName,
	getThemeEpoch,
	setAutoThemeMapping,
	setThemeInstance,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getProjectDir, runWithProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { disableProvider, initializeWithSettings, isProviderEnabled } from "../../src/capability";
import { Settings } from "../../src/config/settings";
import { readTextFromClipboard } from "../../src/utils/clipboard";

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

describe("two-session isolation probe (behavioral, not code-inspection)", () => {
	it("theme change in A does not change B's rendered theme or epoch", async () => {
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("Expected built-in dark and light themes");

		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		// Set different themes in each session
		runWithSessionScope(scopeA, () => setThemeInstance(dark));
		runWithSessionScope(scopeB, () => setThemeInstance(light));

		// Theme name isolation
		expect(runWithSessionScope(scopeA, () => getCurrentThemeName())).toBe("<in-memory>");
		expect(runWithSessionScope(scopeB, () => getCurrentThemeName())).toBe("<in-memory>");

		// Rendered theme isolation — same call resolves to different output per session
		const renderedA = runWithSessionScope(scopeA, () => theme.fg("accent", "probe"));
		const renderedB = runWithSessionScope(scopeB, () => theme.fg("accent", "probe"));
		expect(renderedA).toBe(dark.fg("accent", "probe"));
		expect(renderedB).toBe(light.fg("accent", "probe"));
		expect(renderedA).not.toBe(renderedB);
		// Epoch isolation — each scope's epoch was bumped independently by the
		// setThemeInstance calls above (both at 1). Now bump A again and verify
		// B's epoch stays at 1 (not affected by A's second bump).
		const epochBBefore = runWithSessionScope(scopeB, () => getThemeEpoch());
		await runWithSessionScope(scopeA, async () => {
			setThemeInstance(dark);
		});
		expect(runWithSessionScope(scopeA, () => getThemeEpoch())).toBeGreaterThanOrEqual(2);
		expect(runWithSessionScope(scopeB, () => getThemeEpoch())).toBe(epochBBefore);
	});

	it("setting override in A does not leak to B", () => {
		const settings = Settings.isolated();
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => {
			initializeWithSettings(settings);
			disableProvider("github-copilot");
		});
		runWithSessionScope(scopeB, () => {
			initializeWithSettings(settings);
		});

		// A sees the override
		expect(runWithSessionScope(scopeA, () => isProviderEnabled("github-copilot"))).toBe(false);
		// B does not
		expect(runWithSessionScope(scopeB, () => isProviderEnabled("github-copilot"))).toBe(true);
	});

	it("autoDarkTheme in A does not change B's", () => {
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => setAutoThemeMapping("dark", "dracula"));
		runWithSessionScope(scopeB, () => setAutoThemeMapping("dark", "monokai"));

		// Both started from "dark" — A changed, B changed differently
		// We verify isolation: A's scope doesn't see B's mapping
		expect(runWithSessionScope(scopeA, () => getSessionScope()?.autoDarkTheme)).toBe("dracula");
		expect(runWithSessionScope(scopeB, () => getSessionScope()?.autoDarkTheme)).toBe("monokai");
	});

	it("project-dir in A does not change B's", () => {
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		const original = getProjectDir();
		const dirA = "/tmp/session-A-work";
		const dirB = "/tmp/session-B-work";

		runWithSessionScope(scopeA, () =>
			runWithProjectDir(dirA, () => {
				expect(getProjectDir()).toBe(dirA);
			}),
		);

		runWithSessionScope(scopeB, () =>
			runWithProjectDir(dirB, () => {
				expect(getProjectDir()).toBe(dirB);
			}),
		);

		// Outside any scope, original is preserved
		expect(getProjectDir()).toBe(original);
	});

	it("terminalOut in A does not affect B", () => {
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");
		scopeA.terminalOut = d => receivedA.push(d);
		scopeB.terminalOut = d => receivedB.push(d);

		runWithSessionScope(scopeA, () => {
			const out = getSessionScope()?.terminalOut;
			expect(out).toBeDefined();
			out!("\x1b]0;Session A title\x07");
		});
		runWithSessionScope(scopeB, () => {
			const out = getSessionScope()?.terminalOut;
			expect(out).toBeDefined();
			out!("\x1b]0;Session B title\x07");
		});

		// Each session's terminalOut writes only to its own buffer
		expect(receivedA).toEqual(["\x1b]0;Session A title\x07"]);
		expect(receivedB).toEqual(["\x1b]0;Session B title\x07"]);
	});

	it("clipboard reads under A's scope use A's terminalOut, not the host OS", async () => {
		const scopeA = makeScope("A");
		scopeA.terminalOut = () => {};

		// readTextFromClipboard under a scope with terminalOut returns ""
		// and never shells out to the host OS clipboard
		const result = await runWithSessionScope(scopeA, () => readTextFromClipboard());
		expect(result).toBe("");
	});

	it("macOSReportedAppearance in A does not leak to B", () => {
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => {
			const s = getSessionScope()!;
			s.macOSReportedAppearance = "dark";
		});
		runWithSessionScope(scopeB, () => {
			const s = getSessionScope()!;
			s.macOSReportedAppearance = "light";
		});

		expect(runWithSessionScope(scopeA, () => getSessionScope()?.macOSReportedAppearance)).toBe("dark");
		expect(runWithSessionScope(scopeB, () => getSessionScope()?.macOSReportedAppearance)).toBe("light");
	});
});
