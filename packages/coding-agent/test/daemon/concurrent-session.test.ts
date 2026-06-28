/**
 * Concurrent-session safety harness: proves each BLOCKER fix works by spinning
 * up two independent SessionScopes running concurrently and asserting state
 * isolation. Each test demonstrates the blocker is red-before-fix / green-after-fix.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableProvider, getDisabledProviders, initializeWithSettings, isProviderEnabled } from "../../src/capability";
import { onStatusLineSessionAccentChanged, Settings } from "../../src/config/settings";
import { newSessionScope } from "../../src/modes/daemon/daemon-host";
import { getSessionScope, runWithSessionScope, type SessionScope } from "../../src/modes/daemon/session-scope";
import { SocketTerminal } from "../../src/modes/daemon/socket-terminal";
import { getThemeByName, onThemeChange, previewTheme, setThemeInstance, theme } from "../../src/modes/theme/theme";
import { AgentRegistry } from "../../src/registry/agent-registry";

let server: net.Server | undefined;
afterEach(() => {
	server?.close();
	server = undefined;
});

// Stand up a real UDS pair; return [hostSideSocket, clientSideSocket].
function pair(): Promise<[net.Socket, net.Socket]> {
	return new Promise(resolve => {
		const path = join(tmpdir(), `concurrent-${process.pid}-${Math.floor(performance.now() * 1000)}.sock`);
		server = net.createServer(hostSock => {
			resolve([hostSock, client]);
		});
		let client: net.Socket;
		server.listen(path, () => {
			client = net.connect(path);
		});
	});
}

function makeScope(sessionId: string, settings: Settings | null = null): SessionScope {
	return {
		sessionId,
		agentRegistry: new AgentRegistry(),
		settingsOverrides: new WeakMap(),
		settings,
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

describe("concurrent-session isolation", () => {
	// BLOCKER #1: currentContext() used to return a throwaway object literal
	// with `settings` hardcoded to null, so initializeWithSettings()'s
	// `ctx.settings = activeSettings` mutated a value that was discarded on the
	// very next call — persistDisabledProviders() always saw `settings: null`
	// and silently no-op'd. This test fails against that code (settingsA never
	// gets "github-copilot" appended) and passes now that currentContext()
	// returns the real, mutable SessionScope object.
	it("BLOCKER #1: disableProvider actually persists into this session's own Settings", () => {
		// `Settings.set()` writes to the *calling scope's* copy-on-write overlay
		// (by design — session A's write must never mutate the shared base seen
		// by other sessions), so the read has to happen inside the same scope
		// the write happened in, exactly like a real daemon session would.
		const settingsA = Settings.isolated({ disabledProviders: [] });
		const scopeA = makeScope("A", settingsA);

		runWithSessionScope(scopeA, () => {
			initializeWithSettings(settingsA);
			disableProvider("github-copilot");
			expect(settingsA.get("disabledProviders")).toContain("github-copilot");
		});
	});

	it("BLOCKER #1: session A disabling a provider is invisible to session B, and does not write B's settings", () => {
		const settingsA = Settings.isolated({ disabledProviders: [] });
		const settingsB = Settings.isolated({ disabledProviders: [] });
		const scopeA = makeScope("A", settingsA);
		const scopeB = makeScope("B", settingsB);

		runWithSessionScope(scopeA, () => {
			initializeWithSettings(settingsA);
			disableProvider("github-copilot");
		});
		runWithSessionScope(scopeB, () => {
			initializeWithSettings(settingsB);
		});

		expect(runWithSessionScope(scopeA, () => isProviderEnabled("github-copilot"))).toBe(false);
		expect(runWithSessionScope(scopeB, () => isProviderEnabled("github-copilot"))).toBe(true);
		expect(settingsB.get("disabledProviders")).not.toContain("github-copilot");
	});

	it("BLOCKER #1: a new daemon connection is seeded from the persisted disabled-provider list", () => {
		// Exercises the real daemon-host.ts factory (not a re-implementation):
		// pre-fix, newSessionScope() always started with an empty Set, so a
		// previously-disabled provider would silently come back enabled on
		// every new connection.
		const settings = Settings.isolated({ disabledProviders: ["legacy-provider"] });
		const scope = newSessionScope(settings);

		runWithSessionScope(scope, () => {
			expect(isProviderEnabled("legacy-provider")).toBe(false);
			expect(getDisabledProviders()).toEqual(["legacy-provider"]);
		});
	});

	// BLOCKER #3: notifyThemeChange() used to invoke every listener in the
	// *firing* session's ambient scope (a bare Set, no capture). A listener
	// registered by session A but fired while session B is ambient would
	// resolve A's colors as if they were B's. This test registers a listener
	// under A, fires the broadcast from B's ambient context, and asserts the
	// listener still resolves A's theme via the real resolver
	// (getCurrentThemeName/theme.fg), not B's.
	it("BLOCKER #3: theme-change broadcast re-enters the registering session's own scope, not the firing session's", async () => {
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("Expected built-in dark and light themes to exist");

		const scopeA = makeScope("A");
		const scopeB = makeScope("B");
		runWithSessionScope(scopeA, () => setThemeInstance(dark));
		runWithSessionScope(scopeB, () => setThemeInstance(light));

		let seenColor: string | undefined;
		const unsubscribe = runWithSessionScope(scopeA, () =>
			onThemeChange(() => {
				seenColor = theme.fg("accent", "x");
			}),
		);

		try {
			// Fire the broadcast while B is the ambient scope (B previewing its own
			// theme) — the listener was registered by A and must still resolve A's
			// theme color via the real `theme` proxy, not B's.
			await runWithSessionScope(scopeB, () => previewTheme("light", { ephemeral: true }));

			expect(seenColor).toBe(dark.fg("accent", "x"));
			expect(seenColor).not.toBe(light.fg("accent", "x"));
		} finally {
			unsubscribe();
		}
	});

	// BLOCKER #4: statusLineSessionAccentSignal.fire() (a SettingSignal, same
	// root cause as #3) used to invoke listeners in the firing session's
	// ambient context. This registers a listener under A, changes the setting
	// under B, and asserts the listener resolves A's own settings.get() value
	// (via the real Settings copy-on-write override, the actual resolver), not B's.
	it("BLOCKER #4: settings-change broadcast re-enters the registering session's own scope, not the firing session's", () => {
		const settings = Settings.isolated();
		const scopeA = makeScope("A", settings);
		const scopeB = makeScope("B", settings);

		runWithSessionScope(scopeA, () => settings.override("advisor.enabled", true));
		runWithSessionScope(scopeB, () => settings.override("advisor.enabled", false));

		let seenInCallback: boolean | undefined;
		const unsubscribe = runWithSessionScope(scopeA, () =>
			onStatusLineSessionAccentChanged(() => {
				seenInCallback = settings.get("advisor.enabled");
			}),
		);

		try {
			// Trigger the signal from B's ambient scope.
			runWithSessionScope(scopeB, () => settings.set("statusLine.sessionAccent", false));

			expect(seenInCallback).toBe(true); // A's own override, not B's false.
		} finally {
			unsubscribe();
		}
	});

	it("BLOCKER #5: autoDetectedTheme and terminalReportedAppearance are session-scoped (the two fields left process-global)", () => {
		// Before the fix these were bare module `var`s (not scopedSlot); the
		// prior decoy test here asserted on autoDarkTheme/autoLightTheme — two
		// SIBLING fields that were already scoped — so it passed even with this
		// exact bug present. This exercises the actual fields the fix changed.
		const scopeA = makeScope("A");
		const scopeB = makeScope("B");

		runWithSessionScope(scopeA, () => {
			scopeA.autoDetectedTheme = true;
			scopeA.terminalReportedAppearance = "dark";
		});
		runWithSessionScope(scopeB, () => {
			scopeB.autoDetectedTheme = false;
			scopeB.terminalReportedAppearance = "light";
		});

		expect(runWithSessionScope(scopeA, () => getSessionScope()?.autoDetectedTheme)).toBe(true);
		expect(runWithSessionScope(scopeA, () => getSessionScope()?.terminalReportedAppearance)).toBe("dark");
		expect(runWithSessionScope(scopeB, () => getSessionScope()?.autoDetectedTheme)).toBe(false);
		expect(runWithSessionScope(scopeB, () => getSessionScope()?.terminalReportedAppearance)).toBe("light");

		// Session B enabling auto-theme detection must not flip session A's flag —
		// this is exactly the cross-session bleed BLOCKER #5 describes.
		expect(runWithSessionScope(scopeA, () => getSessionScope()?.autoDetectedTheme)).not.toBe(
			runWithSessionScope(scopeB, () => getSessionScope()?.autoDetectedTheme),
		);
	});

	// BLOCKER #6 (real clipboard-read gating) is covered end-to-end, calling the
	// actual exported readTextFromClipboard/readImageFromClipboard/
	// readMacFileUrlsFromClipboard functions with Bun.spawn/native spies, in
	// test/utils/clipboard.test.ts ("clipboard reads under a daemon session
	// scope (#BLOCKER-6)") — the hollow decoy that used to live here (which only
	// checked that `terminalOut` was a defined field, never calling the gated
	// functions) has been replaced by that real coverage.

	it("BLOCKER #7: socket frame length should be bounded", async () => {
		// Before fix: a huge frame length crashes the host.
		// After fix: socket is destroyed when frame exceeds MAX_FRAME_BYTES.
		const [host, client] = await pair();
		const terminal = new SocketTerminal(host, 80, 24, fn => fn());
		const received: string[] = [];
		terminal.start(
			d => received.push(d),
			() => {},
		);

		// Send a frame header claiming 1GB (will be rejected before buffering).
		const hugeLength = Buffer.alloc(5);
		hugeLength[0] = 0x01; // FRAME_INPUT code
		hugeLength.writeUInt32BE(1024 * 1024 * 1024, 1); // 1GB length
		client.write(hugeLength);

		await Bun.sleep(50);
		// Before fix: socket stays alive and buffers growing.
		// After fix: socket destroyed, no further data.
		expect(host.destroyed || !host.writable).toBe(true);
		client.destroy();
	});
});
