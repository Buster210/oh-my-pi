import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { SessionScope } from "../modes/daemon/session-scope";
import { runWithSessionScope } from "../modes/daemon/session-scope";
import { Settings } from "./settings";

/**
 * Session-scoped `set()` must not leak into other live daemon sessions.
 *
 * Standalone semantics: a persisted change in instance A does NOT affect
 * already-running instance B. In the shared daemon, `set()` inside a session
 * scope must (1) take effect for the calling session, (2) persist to disk,
 * (3) NOT change what other live sessions read.
 */

function createTestScope(sessionId: string): SessionScope {
	return {
		sessionId,
		agentRegistry: {} as SessionScope["agentRegistry"],
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
		preferredImageProvider: { provider: "builtin" } as unknown as SessionScope["preferredImageProvider"],
		theme: undefined,
		currentThemeName: undefined,
		currentSymbolPresetOverride: undefined,
		currentColorBlindMode: false,
		autoDarkTheme: "",
		autoLightTheme: "",
		autoDetectedTheme: false,
		terminalReportedAppearance: undefined,
		macOSReportedAppearance: undefined,
		themeLoadRequestId: 0,
		themeEpoch: 0,
		hostUriHandlers: new Map(),
	} as SessionScope;
}

describe("settings session-scoped set()", () => {
	it("(a+b) scoped set() is visible to the calling session but NOT to session B", () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const scopeA = createTestScope("session-a");
		const scopeB = createTestScope("session-b");

		runWithSessionScope(scopeA, () => {
			settings.set("compaction.enabled", true);
			expect(settings.get("compaction.enabled")).toBe(true);
		});

		runWithSessionScope(scopeB, () => {
			expect(settings.get("compaction.enabled")).toBe(false);
		});
	});

	it("(d) unscoped set() mutates globally as before", () => {
		const settings = Settings.isolated();
		const defaultVal = settings.get("compaction.enabled");

		settings.set("compaction.enabled", !defaultVal);
		expect(settings.get("compaction.enabled")).toBe(!defaultVal);

		const scope = createTestScope("session-c");
		runWithSessionScope(scope, () => {
			expect(settings.get("compaction.enabled")).toBe(!defaultVal);
		});
	});

	it("(c) queued save output contains the new scoped value", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
		const configPath = path.join(tmpDir, "config.yml");

		await Bun.write(configPath, YAML.stringify({ compaction: { enabled: false } }, null, 2));

		try {
			const settings = await Settings.loadIsolated({
				agentDir: tmpDir,
				cwd: tmpDir,
			});

			const scope = createTestScope("session-persist");

			runWithSessionScope(scope, () => {
				settings.set("compaction.enabled", true);
				expect(settings.get("compaction.enabled")).toBe(true);
			});

			await settings.flush();

			const saved = YAML.parse(await Bun.file(configPath).text()) as { compaction?: { enabled?: boolean } };
			expect(saved?.compaction?.enabled).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("(e) scoped value never leaks to other sessions while the save is in flight", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
		const configPath = path.join(tmpDir, "config.yml");
		await Bun.write(configPath, YAML.stringify({ compaction: { enabled: false } }, null, 2));

		try {
			const settings = await Settings.loadIsolated({ agentDir: tmpDir, cwd: tmpDir });
			const scopeA = createTestScope("session-a");
			const scopeB = createTestScope("session-b");

			runWithSessionScope(scopeA, () => {
				settings.set("compaction.enabled", true);
			});

			// Different override path forces merged-settings cache bypass on every probe.
			runWithSessionScope(scopeB, () => {
				settings.override("advisor.enabled", settings.get("advisor.enabled"));
			});

			// Probe every tick to catch mid-write #global pollution.
			let leaked = false;
			let done = false;
			const flushPromise = settings.flush().finally(() => {
				done = true;
			});
			while (!done) {
				runWithSessionScope(scopeB, () => {
					if (settings.get("compaction.enabled") === true) leaked = true;
				});
				if (settings.get("compaction.enabled") === true) leaked = true;
				await Bun.sleep(0);
			}
			await flushPromise;

			// Post-flush: aliased objects must not retain pollution.
			runWithSessionScope(scopeB, () => {
				if (settings.get("compaction.enabled") === true) leaked = true;
			});
			if (settings.get("compaction.enabled") === true) leaked = true;

			expect(leaked).toBe(false);
			// Scoped value persisted to disk.
			const saved = YAML.parse(await Bun.file(configPath).text()) as { compaction?: { enabled?: boolean } };
			expect(saved?.compaction?.enabled).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("multiple sessions setting different paths do not interfere", () => {
		const settings = Settings.isolated();
		const scopeA = createTestScope("session-a");
		const scopeB = createTestScope("session-b");
		const defaultCompaction = settings.get("compaction.enabled");
		const defaultAdvisor = settings.get("advisor.enabled");

		runWithSessionScope(scopeA, () => {
			settings.set("compaction.enabled", !defaultCompaction);
		});

		runWithSessionScope(scopeB, () => {
			settings.set("advisor.enabled", !defaultAdvisor);
		});

		runWithSessionScope(scopeA, () => {
			expect(settings.get("compaction.enabled")).toBe(!defaultCompaction);
			expect(settings.get("advisor.enabled")).toBe(defaultAdvisor);
		});

		runWithSessionScope(scopeB, () => {
			expect(settings.get("compaction.enabled")).toBe(defaultCompaction);
			expect(settings.get("advisor.enabled")).toBe(!defaultAdvisor);
		});
	});
});
