/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cached advertisement of a server — everything servable without a live
 * connection: tool definitions (callable placeholders), instructions (system
 * prompt injection), and prompt/resource listings (menus). Invoking any of
 * them wakes the real server; content always comes from the live connection.
 */
export type MCPServerSnapshot = {
	tools: MCPToolDefinition[];
	instructions?: string;
	prompts?: MCPPrompt[];
	resources?: MCPResource[];
	resourceTemplates?: MCPResourceTemplate[];
};

type MCPToolCachePayload = {
	version: number;
	configHash: string;
} & MCPServerSnapshot;

function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringify(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	async get(serverName: string, config: MCPServerConfig): Promise<MCPServerSnapshot | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		return {
			tools: parsed.tools as MCPToolDefinition[],
			instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
			prompts: Array.isArray(parsed.prompts) ? (parsed.prompts as MCPPrompt[]) : undefined,
			resources: Array.isArray(parsed.resources) ? (parsed.resources as MCPResource[]) : undefined,
			resourceTemplates: Array.isArray(parsed.resourceTemplates)
				? (parsed.resourceTemplates as MCPResourceTemplate[])
				: undefined,
		};
	}

	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		extras?: Omit<MCPServerSnapshot, "tools">,
	): Promise<void> {
		let configHash: string;
		try {
			configHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		// Tools-only writers (refresh paths) must not wipe the cached
		// instructions/prompts/resources snapshot — preserve the prior extras.
		let preserved: Omit<MCPServerSnapshot, "tools"> = {};
		if (!extras) {
			const existing = await this.get(serverName, config);
			if (existing) {
				preserved = {
					instructions: existing.instructions,
					prompts: existing.prompts,
					resources: existing.resources,
					resourceTemplates: existing.resourceTemplates,
				};
			}
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
			...preserved,
			...extras,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}
