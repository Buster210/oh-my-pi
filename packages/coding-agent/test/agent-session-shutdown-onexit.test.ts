/**
 * Proves `AgentSession#setOnExit` wiring for the `shutdown` extension command
 * (agent-session.ts `#createCommandContext`): standalone (no callback set)
 * keeps calling `process.exit`, while a daemon session's injected callback
 * runs instead — so ending one daemon connection never kills the shared host.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let originalExit: typeof process.exit;
let processExitCalled: boolean;

/** A custom command whose handler calls `ctx.shutdown()` and never touches the LLM. */
function shutdownCommand(): LoadedCustomCommand {
	return {
		path: "shutdown-test",
		resolvedPath: "shutdown-test",
		source: "user",
		command: {
			name: "shutdown-test",
			description: "test",
			execute: (_args, ctx) => {
				// `shutdown` is on the runtime object (ExtensionCommandContext, cast away
				// at the custom-command boundary) but not on HookCommandContext's declared type.
				(ctx as unknown as { shutdown: () => void }).shutdown();
				return "";
			},
		},
	};
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-agent-session-shutdown-onexit-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] as AgentTool[], messages: [] },
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(),
		customCommands: [shutdownCommand()],
	});

	originalExit = process.exit;
	processExitCalled = false;
	// @ts-expect-error — overriding for the assertion window only
	process.exit = () => {
		processExitCalled = true;
	};
});

afterEach(async () => {
	process.exit = originalExit;
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

it("uses the injected onExit callback instead of process.exit when set", async () => {
	let exitCalled = false;
	session.setOnExit(() => {
		exitCalled = true;
	});

	await session.prompt("/shutdown-test");

	expect(exitCalled).toBe(true);
	expect(processExitCalled).toBe(false);
});

it("falls back to process.exit when no onExit callback is set (standalone default)", async () => {
	await session.prompt("/shutdown-test");

	expect(processExitCalled).toBe(true);
});
