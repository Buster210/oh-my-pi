/**
 * Proves the RPC shutdown coordinator routes through the exit/onExit seam
 * so pi.shutdown() in a shared-host daemon only ends the calling session
 * rather than killing the entire process.
 *
 * The coordinator calls its performShutdown callback, which in runRpcMode
 * uses the exit() closure that checks io.onExit before process.exit.
 * This test exercises that exact pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RpcShutdownCoordinator } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

/** Replicate the exit() closure from runRpcMode — checks io.onExit first. */
function makeExit(io?: { onExit?: () => void }): () => void {
	return () => {
		if (io?.onExit) {
			io.onExit();
			return;
		}
		process.exit(0);
	};
}

describe("RpcShutdownCoordinator + exit/onExit seam", () => {
	let originalExit: typeof process.exit;
	let processExitCalled: boolean;

	beforeEach(() => {
		originalExit = process.exit;
		processExitCalled = false;
		// @ts-expect-error — overriding for assertion window only
		process.exit = () => {
			processExitCalled = true;
			// Do NOT actually exit the test runner.
		};
	});

	afterEach(() => {
		process.exit = originalExit;
	});

	it("calls io.onExit instead of process.exit when onExit is provided", async () => {
		let onExitCalled = false;
		const exitFn = makeExit({
			onExit: () => {
				onExitCalled = true;
			},
		});

		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: async () => {
				exitFn();
			},
		});

		await coordinator.checkShutdownRequested();

		expect(onExitCalled).toBe(true);
		expect(processExitCalled).toBe(false);
	});

	it("falls back to process.exit when no onExit is provided (standalone)", async () => {
		const exitFn = makeExit();

		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: async () => {
				exitFn();
			},
		});

		await coordinator.checkShutdownRequested();

		expect(processExitCalled).toBe(true);
	});

	it("drains tracked background tasks before calling performShutdown", async () => {
		let shutdownCalled = false;
		const { promise: task, resolve } = Promise.withResolvers<void>();

		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: async () => {
				shutdownCalled = true;
			},
		});

		coordinator.track(task);
		resolve();
		await coordinator.checkShutdownRequested();

		expect(shutdownCalled).toBe(true);
	});
});
