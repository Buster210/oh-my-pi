/**
 * Per-session scoping via AsyncLocalStorage.
 *
 * In a shared-host daemon, one RPC session must not stomp the process-wide
 * singletons (`Settings` overrides, `AgentRegistry`, auto-QA consent state,
 * `MCPManager`/`AsyncJobManager` instances, active rules/skills snapshots,
 * search/image provider preferences) that another concurrent session is
 * using. This module provides the ALS primitive; `getSessionScope()` is read
 * by each singleton's accessor to resolve session-local state, falling back
 * to the existing module-level global when no scope is active.
 *
 * Outside any `runWithSessionScope` call (standalone CLI, workers), the ALS
 * store is empty and every accessor falls back to its module-level global —
 * identical to pre-scoping behaviour.
 */
import type { AsyncLocalStorage as AsyncLocalStorageType } from "node:async_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AsyncJobManager } from "../../async/job-manager";
import type { Rule } from "../../capability/rule";
import type { RawSettings, Settings } from "../../config/settings";
import type { Skill } from "../../extensibility/skills";
import type { ProtocolHandler } from "../../internal-urls/types";
import type { MCPManager } from "../../mcp/manager";
import type { AgentRegistry } from "../../registry/agent-registry";
import type { ImageProviderPreference } from "../../tools/image-gen";
import type { AutoQaConsentHandler } from "../../tools/report-tool-issue";
import type { SearchProviderId } from "../../web/search/types";
import type { SymbolPreset, Theme } from "../theme/theme";

export interface SessionScope {
	readonly sessionId: string;
	readonly agentRegistry: AgentRegistry;
	settingsOverrides: WeakMap<Settings, RawSettings>;
	/** This session's persisted Settings instance, seeded at scope creation (#BLOCKER-1). */
	settings: Settings | null;
	disabledProviders: Set<string>;
	autoQaConsentState: {
		handler: AutoQaConsentHandler | null;
		persistentSettings: Settings | null;
		cachedConsent: boolean | null;
		consentInFlight: Promise<boolean> | null;
	};
	mcpManager: MCPManager | undefined;
	asyncJobManager: AsyncJobManager | undefined;
	activeRules: readonly Rule[];
	activeSkills: readonly Skill[];
	preferredSearchProvider: SearchProviderId | "auto";
	excludedSearchProviders: Set<SearchProviderId>;
	preferredImageProvider: ImageProviderPreference;
	theme: Theme | undefined;
	currentThemeName: string | undefined;
	currentSymbolPresetOverride: SymbolPreset | undefined;
	currentColorBlindMode: boolean;
	autoDarkTheme: string;
	autoLightTheme: string;
	autoDetectedTheme: boolean;
	terminalReportedAppearance: "dark" | "light" | undefined;
	macOSReportedAppearance: "dark" | "light" | undefined;
	themeLoadRequestId: number;
	themeEpoch: number;
	/**
	 * Raw terminal-escape sink for this session's client (title/clipboard OSC
	 * sequences). A function field — not a `SocketTerminal` import — keeps this
	 * module decoupled from the daemon transport. Unset outside the TUI branch
	 * (RPC connections have no interactive terminal); callers fall back to
	 * `process.stdout` when this is absent, matching standalone behavior.
	 */
	terminalOut?: (data: string) => void;
	/**
	 * Mirrors `InternalUrlRouter`'s process-global `#handlers` map, but only for
	 * schemes dynamically registered at runtime (RPC host URI bridges). Static
	 * built-in handlers (`agent://`, `artifact://`, etc.) stay in the shared
	 * router table — only per-session dynamic registrations move here, so one
	 * RPC session's host-declared scheme never overwrites or shadows another
	 * session's handler of the same name.
	 */
	hostUriHandlers: Map<string, ProtocolHandler>;
}

const als: AsyncLocalStorageType<SessionScope> = new AsyncLocalStorage<SessionScope>();

export function getSessionScope(): SessionScope | undefined {
	return als.getStore();
}

export function runWithSessionScope<T>(scope: SessionScope, fn: () => T): T {
	return als.run(scope, fn);
}

/**
 * Shared scope-or-global storage factory: falls back to a module-level global
 * when no session scope is active (standalone CLI, workers), and reads/writes
 * the scope instead when one is (shared-host daemon). Get/set semantics are
 * byte-identical to a hand-rolled `getSessionScope()?.X ?? globalX` /
 * scope-if-present-else-global pair.
 */
export function scopedSlot<K extends keyof SessionScope>(key: K, initial: SessionScope[K]) {
	let g = initial;
	return {
		get: () => getSessionScope()?.[key] ?? g,
		set: (v: SessionScope[K]) => {
			const s = getSessionScope();
			if (s) s[key] = v;
			else g = v;
		},
	};
}
