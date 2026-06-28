/**
 * Regression guard for lazy MCP startup (round 2).
 *
 * When `lazy: true` is passed to `connectServers()` or `discoverAndConnect()`,
 * servers with CACHED tool definitions are deferred: no subprocess is spawned,
 * placeholder DeferredMCPTools are registered from the cache, and the real
 * connection happens on first tool use via `#ensureConnected()` (triggered by
 * `getTools()` or `waitForConnection()`).
 *
 * Servers with a cold cache connect eagerly even under lazy=true: without
 * cached definitions there would be zero MCP tools registered, so nothing
 * could ever trigger the deferred connect (the "Connecting to MCP servers"
 * status would hang forever — the ompp fresh-config bug).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../src/mcp/manager";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";

const BUN_EXEC = process.execPath;
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");

function memoryToolCache(): MCPToolCache {
	const store = new Map<string, string>();
	const storage = {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
	return new MCPToolCache(storage);
}

function baseConfig(overrides?: Partial<MCPStdioServerConfig>): MCPStdioServerConfig {
	return { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH], ...overrides };
}

describe("MCP lazy connection", () => {
	let workDir: string;
	let manager: MCPManager | undefined;

	beforeEach(() => {
		workDir = path.join(os.tmpdir(), `mcp-lazy-connect-${Snowflake.next()}`);
		fs.mkdirSync(workDir, { recursive: true });
		manager = undefined;
	});

	afterEach(async () => {
		await manager?.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("defers connection when lazy=true with cached tools and connects on getTools()", async () => {
		const cache = memoryToolCache();
		const config = baseConfig();
		await cache.set(
			"lazyServer",
			config,
			[{ name: "cached_tool", description: "from cache", inputSchema: { type: "object" } }],
			{
				instructions: "CACHED_INSTRUCTIONS_SENTINEL",
				prompts: [{ name: "cached_prompt", description: "from cache" }],
			},
		);

		manager = new MCPManager(workDir, cache);

		// Lazy call with warm cache: stash config, register placeholder tools, NO connect
		const result = await manager.connectServers({ lazyServer: config }, {}, undefined, true);
		expect(manager.getConnectedServers()).toHaveLength(0);
		expect(result.connectedServers).toHaveLength(0);
		expect(result.tools.map(t => t.name)).toEqual(["mcp__lazyserver_cached_tool"]);

		// While deferred, the cached advertisement is served transparently
		expect(manager.getServerInstructions().get("lazyServer")).toBe("CACHED_INSTRUCTIONS_SENTINEL");
		expect(manager.getServerPrompts("lazyServer")?.map(p => p.name)).toEqual(["cached_prompt"]);
		expect(manager.getServerResources("lazyServer")).toEqual({ resources: [], templates: [] });

		// First getTools() triggers #ensureConnected → eager connect for deferred configs
		manager.getTools();
		// Wait for background connection to complete
		await new Promise(resolve => setTimeout(resolve, 500));

		// Now the server should be connected, and live instructions shadow cached
		expect(manager.getConnectedServers()).toContain("lazyServer");
		expect(manager.getServerInstructions().get("lazyServer")).toContain("INSTR_FIXTURE_SENTINEL");
	});

	it("executePrompt wakes a deferred server", async () => {
		const cache = memoryToolCache();
		const config = baseConfig();
		await cache.set("lazyServer", config, [{ name: "cached_tool", inputSchema: { type: "object" } }], {
			prompts: [{ name: "cached_prompt" }],
		});

		manager = new MCPManager(workDir, cache);
		await manager.connectServers({ lazyServer: config }, {}, undefined, true);
		expect(manager.getConnectedServers()).toHaveLength(0);

		// Fixture has no real prompt support; the wake is what's under test.
		await manager.executePrompt("lazyServer", "cached_prompt").catch(() => undefined);
		expect(manager.getConnectedServers()).toContain("lazyServer");
	});

	it("connects eagerly under lazy=true when config sets lazy:false", async () => {
		const cache = memoryToolCache();
		const config = baseConfig({ lazy: false });
		await cache.set("lazyServer", config, [{ name: "cached_tool", inputSchema: { type: "object" } }]);

		manager = new MCPManager(workDir, cache);
		const result = await manager.connectServers({ lazyServer: config }, {}, undefined, true);
		expect(result.connectedServers).toContain("lazyServer");
	});

	it("connects eagerly under lazy=true when the cache has zero tools (prompts-only server)", async () => {
		const cache = memoryToolCache();
		const config = baseConfig();
		// A cached advertisement with no tools has no automatic wake trigger —
		// deferral would strand it, so it must connect for real.
		await cache.set("lazyServer", config, [], { prompts: [{ name: "only_prompt" }] });

		manager = new MCPManager(workDir, cache);
		const result = await manager.connectServers({ lazyServer: config }, {}, undefined, true);
		expect(result.connectedServers).toContain("lazyServer");
	});

	it("connects eagerly under lazy=true when the tool cache is cold", async () => {
		manager = new MCPManager(workDir, memoryToolCache());
		const config = baseConfig();

		// Cold cache: deferring would strand the server (no placeholder tools,
		// no trigger) — must connect for real.
		const result = await manager.connectServers({ lazyServer: config }, {}, undefined, true);
		expect(manager.getConnectedServers()).toContain("lazyServer");
		expect(result.connectedServers).toContain("lazyServer");
		expect(result.tools.length).toBeGreaterThan(0);
	});

	it("connects eagerly when lazy=false (default)", async () => {
		manager = new MCPManager(workDir);
		const config = baseConfig();

		// Default (eager) call: should connect immediately
		const result = await manager.connectServers({ eager: config }, {});
		expect(manager.getConnectedServers()).toContain("eager");
		expect(result.connectedServers).toContain("eager");
	});

	it("disconnectAll clears deferred state and allows re-deferral on reload", async () => {
		const cache = memoryToolCache();
		const config = baseConfig();
		await cache.set(
			"removedServer",
			config,
			[{ name: "cached_tool", description: "from cache", inputSchema: { type: "object" } }],
			{
				instructions: "STALE_SENTINEL",
			},
		);

		manager = new MCPManager(workDir, cache);
		await manager.connectServers({ removedServer: config }, {}, undefined, true);

		// Verify deferred state is populated
		expect(manager.getConnectedServers()).toHaveLength(0);
		expect(manager.getServerInstructions().get("removedServer")).toBe("STALE_SENTINEL");

		// disconnectAll should clear all deferred state
		await manager.disconnectAll();

		// After disconnectAll, deferred state should be cleared and stale instructions gone
		expect(manager.getConnectedServers()).toHaveLength(0);
		expect(manager.getServerInstructions().get("removedServer")).toBeUndefined();

		// A subsequent lazy connect should work (lazyConnectTriggered reset)
		await manager.connectServers({ removedServer: config }, {}, undefined, true);
		expect(manager.getConnectedServers()).toHaveLength(0);
		expect(manager.getServerInstructions().get("removedServer")).toBe("STALE_SENTINEL");
	});

	it("disconnectServer clears one server's deferred state without resurrecting it", async () => {
		const cache = memoryToolCache();
		const config = baseConfig();
		await cache.set(
			"removedServer",
			config,
			[{ name: "cached_tool", description: "from cache", inputSchema: { type: "object" } }],
			{
				instructions: "STALE_SENTINEL",
			},
		);

		manager = new MCPManager(workDir, cache);
		await manager.connectServers({ removedServer: config }, {}, undefined, true);

		// Verify deferred state is populated
		expect(manager.getServerInstructions().get("removedServer")).toBe("STALE_SENTINEL");

		// disconnectServer should clear this server's deferred state
		await manager.disconnectServer("removedServer");
		expect(manager.getServerInstructions().get("removedServer")).toBeUndefined();

		// getTools() must not resurrect the disconnected server from stale deferred state
		manager.getTools();
		await Bun.sleep(10);
		expect(manager.getConnectedServers()).not.toContain("removedServer");
		expect(manager.getServerInstructions().get("removedServer")).toBeUndefined();
	});
});
