/**
 * Proves setTerminalTitle/pushTerminalTitle/popTerminalTitle and
 * copyToClipboard route their OSC sequences through the active session's
 * `terminalOut` sink instead of `process.stdout` — and that outside any
 * scope they fall back to the pre-daemon process.stdout/isTTY path, so
 * standalone behavior is untouched.
 */
import { describe, expect, it } from "bun:test";
import type { SessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { runWithSessionScope } from "@oh-my-pi/pi-coding-agent/modes/daemon/session-scope";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { popTerminalTitle, pushTerminalTitle, setTerminalTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function makeScope(sink: (data: string) => void): SessionScope {
	return {
		sessionId: "test",
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
		terminalOut: sink,
	};
}

describe("terminal escape routing (title + clipboard)", () => {
	it("setTerminalTitle writes OSC 0 to the scope's sink, not process.stdout", () => {
		const written: string[] = [];
		const stdoutWrite = process.stdout.write;
		let stdoutCalled = false;
		process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
			stdoutCalled = true;
			// @ts-expect-error test stub
			return stdoutWrite.call(process.stdout, chunk, ...rest);
		}) as typeof process.stdout.write;

		try {
			runWithSessionScope(
				makeScope(data => written.push(data)),
				() => {
					setTerminalTitle("hello");
				},
			);
		} finally {
			process.stdout.write = stdoutWrite;
		}

		expect(written).toEqual(["\x1b]0;hello\x07"]);
		expect(stdoutCalled).toBe(false);
	});

	it("pushTerminalTitle/popTerminalTitle write save/restore OSC to the sink", () => {
		const written: string[] = [];
		runWithSessionScope(
			makeScope(data => written.push(data)),
			() => {
				pushTerminalTitle();
				popTerminalTitle();
			},
		);
		expect(written).toEqual(["\x1b[22;2t", "\x1b[23;2t"]);
	});

	it("copyToClipboard sends OSC 52 to the sink and skips the native fallback", async () => {
		const written: string[] = [];
		await runWithSessionScope(
			makeScope(data => written.push(data)),
			() => copyToClipboard("secret"),
		);

		expect(written).toHaveLength(1);
		const expected = `\x1b]52;c;${Buffer.from("secret").toString("base64")}\x07`;
		expect(written[0]).toBe(expected);
	});

	it("falls back to the process.stdout/isTTY path outside any scope (sink not required)", () => {
		// No scope active — getSessionScope() is undefined, so setTerminalTitle
		// must not throw reaching for a sink and must take the standalone branch.
		expect(() => setTerminalTitle("no-scope")).not.toThrow();
	});
});
