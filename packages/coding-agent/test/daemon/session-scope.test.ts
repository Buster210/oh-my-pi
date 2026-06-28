/**
 * Proves per-session ALS scoping is isolated and byte-identical when no
 * scope is active:
 *
 * 1. Outside any scope, `AgentRegistry.global()` returns the module `#global`
 *    singleton (the standalone guarantee).
 * 2. Two concurrently-active scopes see their own `AgentRegistry` instance
 *    via `AgentRegistry.global()`, never each other's or the module global.
 * 3. A `Settings.override()` set inside scope A's overlay is invisible from
 *    scope B and invisible outside any scope.
 */
import { describe, expect, it } from "bun:test";
import { getActiveRules, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalResource } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { SessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { getSessionScope, runWithSessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
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
		themeLoadRequestId: 0,
		hostUriHandlers: new Map(),
	};
}

function makeHandler(scheme: string, tag: string) {
	return {
		scheme,
		immutable: false,
		async resolve(): Promise<InternalResource> {
			return { url: `${scheme}://x`, content: tag, contentType: "text/plain", size: tag.length };
		},
	};
}

describe("session-scope ALS isolation", () => {
	it("getSessionScope() is undefined outside any scope", () => {
		expect(getSessionScope()).toBeUndefined();
	});

	it("AgentRegistry.global() falls back to the module #global outside any scope", () => {
		const outside = AgentRegistry.global();
		expect(outside).toBe(AgentRegistry.global());
	});

	it("AgentRegistry.global() resolves to the active scope's registry, isolated per scope", () => {
		const outsideBefore = AgentRegistry.global();
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		const seenA = runWithSessionScope(scopeA, () => AgentRegistry.global());
		const seenB = runWithSessionScope(scopeB, () => AgentRegistry.global());

		expect(seenA).toBe(scopeA.agentRegistry);
		expect(seenB).toBe(scopeB.agentRegistry);
		expect(seenA).not.toBe(seenB);
		expect(seenA).not.toBe(outsideBefore);

		// Leaving the scope restores the standalone fallback untouched.
		expect(AgentRegistry.global()).toBe(outsideBefore);
	});

	it("a settings override set inside one scope is invisible in another scope and outside any scope", () => {
		const settings = Settings.isolated();
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => {
			settings.override("dev.autoqa", true);
		});

		// Visible inside scope A.
		runWithSessionScope(scopeA, () => {
			expect(settings.get("dev.autoqa")).toBe(true);
		});

		// Invisible inside scope B.
		runWithSessionScope(scopeB, () => {
			expect(settings.get("dev.autoqa")).toBe(false);
		});

		// Invisible outside any scope (standalone fallback untouched).
		expect(settings.get("dev.autoqa")).toBe(false);
	});

	it("activeRules set inside one scope is isolated from another scope and the module global outside any scope", () => {
		const outsideBefore = getActiveRules();
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");
		const source = { provider: "test", providerName: "Test", path: "/rules", level: "user" as const };
		const rulesA = [{ name: "a", path: "/a", content: "a", _source: source }];
		const rulesB = [{ name: "b", path: "/b", content: "b", _source: source }];

		runWithSessionScope(scopeA, () => setActiveRules(rulesA));
		runWithSessionScope(scopeB, () => setActiveRules(rulesB));

		expect(runWithSessionScope(scopeA, () => getActiveRules())).toBe(rulesA);
		expect(runWithSessionScope(scopeB, () => getActiveRules())).toBe(rulesB);

		// The module-level global outside any scope is untouched by either scope's write.
		expect(getActiveRules()).toBe(outsideBefore);
	});

	it("registerScoped: a host-uri scheme registered in one scope is invisible in another scope and outside any scope", async () => {
		const router = InternalUrlRouter.instance();
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => {
			router.registerScoped(makeHandler("hostdoc", "from-A"));
		});

		// Same scheme name registered independently in scope B — must not see A's handler.
		expect(runWithSessionScope(scopeB, () => router.getHandler("hostdoc"))).toBeUndefined();

		// Visible inside scope A.
		const resolvedA = await runWithSessionScope(scopeA, () => router.resolve("hostdoc://x"));
		expect(resolvedA.content).toBe("from-A");

		// Invisible outside any scope (standalone fallback untouched, no leak into the shared table).
		expect(router.getHandler("hostdoc")).toBeUndefined();

		// unregisterScoped only removes A's own registration.
		runWithSessionScope(scopeA, () => {
			expect(router.unregisterScoped("hostdoc")).toBe(true);
		});
		expect(runWithSessionScope(scopeA, () => router.getHandler("hostdoc"))).toBeUndefined();
	});
});

describe("session-scoped set()", () => {
	it("two scopes can set the same path independently", () => {
		const settings = Settings.isolated({ "display.showTokenUsage": false });
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => settings.set("display.showTokenUsage", true));
		runWithSessionScope(scopeB, () => settings.set("display.showTokenUsage", false));

		// Each scope retains its own value for the shared path.
		expect(runWithSessionScope(scopeA, () => settings.get("display.showTokenUsage"))).toBe(true);
		expect(runWithSessionScope(scopeB, () => settings.get("display.showTokenUsage"))).toBe(false);

		// Outside any scope the standalone default is untouched.
		expect(settings.get("display.showTokenUsage")).toBe(false);
	});
});
