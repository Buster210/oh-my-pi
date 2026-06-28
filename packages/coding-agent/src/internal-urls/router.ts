/**
 * Internal URL router for internal protocols (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, `ssh://`, and `vault://`).
 *
 * One process-global router with one static handler per built-in scheme.
 * Access via `InternalUrlRouter.instance()`. Handlers are stateless; per-session
 * and shared state lives in `./state.ts`. Schemes registered dynamically at
 * runtime (RPC host-uri bridges) go through `registerScoped`/`unregisterScoped`
 * instead of `register`/`unregister` — those live in the calling session's
 * `SessionScope.hostUriHandlers` so concurrent daemon sessions never overwrite
 * each other's host-declared scheme.
 */

import { getSessionScope } from "../modes/daemon/session-scope";
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { HistoryProtocolHandler } from "./history-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { OmpProtocolHandler } from "./omp-protocol";
import { parseInternalUrl } from "./parse";
import { RuleProtocolHandler } from "./rule-protocol";
import { SkillProtocolHandler } from "./skill-protocol";
import { SshProtocolHandler } from "./ssh-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";
import { VaultProtocolHandler } from "./vault-protocol";

export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();

	constructor() {
		this.register(new OmpProtocolHandler());
		this.register(new AgentProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new VaultProtocolHandler());
		this.register(new SkillProtocolHandler());
		this.register(new RuleProtocolHandler());
		this.register(new McpProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
		this.register(new HistoryProtocolHandler());
		this.register(new SshProtocolHandler());
	}

	/** Process-global router instance. */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests. */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	unregister(scheme: string): boolean {
		return this.#handlers.delete(scheme.toLowerCase());
	}

	/**
	 * Register a handler for the currently active session only (falls back to
	 * the shared `#handlers` table outside any `SessionScope`, e.g. standalone
	 * CLI — byte-identical to `register()` there). Used by RPC host-uri
	 * bridges: a daemon session's dynamically-declared scheme must never
	 * overwrite another concurrent session's handler of the same name in the
	 * process-global router.
	 */
	registerScoped(handler: ProtocolHandler): void {
		const scope = getSessionScope();
		if (scope) {
			scope.hostUriHandlers.set(handler.scheme.toLowerCase(), handler);
			return;
		}
		this.register(handler);
	}

	/** Session-scoped counterpart to {@link registerScoped}. */
	unregisterScoped(scheme: string): boolean {
		const scope = getSessionScope();
		if (scope) {
			return scope.hostUriHandlers.delete(scheme.toLowerCase());
		}
		return this.unregister(scheme);
	}

	/** Session-scoped handler (if any) takes precedence over the shared built-in table. */
	#handlerFor(scheme: string): ProtocolHandler | undefined {
		return getSessionScope()?.hostUriHandlers.get(scheme) ?? this.#handlers.get(scheme);
	}

	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handlerFor(scheme.toLowerCase());
	}

	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		return this.#handlerFor(match[1].toLowerCase()) !== undefined;
	}

	/** Schemes whose handler supports host/path autocomplete. */
	completionSchemes(): string[] {
		const schemes: string[] = [];
		for (const [scheme, handler] of this.#handlers) {
			if (handler.complete) schemes.push(scheme);
		}
		for (const [scheme, handler] of getSessionScope()?.hostUriHandlers ?? []) {
			if (handler.complete) schemes.push(scheme);
		}
		return schemes;
	}

	/**
	 * Candidate completions for the host/path portion of `scheme://<query>`.
	 * Returns `null` when the scheme is unknown or does not support completion.
	 */
	async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
		const handler = this.#handlerFor(scheme.toLowerCase());
		if (!handler?.complete) return null;
		return handler.complete(query, context);
	}

	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlerFor(scheme);

		if (!handler) {
			const available = [...this.#handlers.keys(), ...(getSessionScope()?.hostUriHandlers.keys() ?? [])]
				.map(s => `${s}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}

		const resource = await handler.resolve(parsed as InternalUrl, context);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}
}
