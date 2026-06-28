import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	return text;
}

/**
 * Tests for daemon contain mode: uncaught exceptions / unhandled rejections
 * must not exit the process in contain mode, while signals invoke the registered
 * daemon shutdown handler.
 *
 * Uses subprocess isolation to avoid poisoning the test process with signal handlers.
 */
describe("postmortem daemon contain mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	let testCounter = 0;
	async function makeTempScript(content: string): Promise<string> {
		const filePath = path.join(os.tmpdir(), `omp-contain-test-${Date.now()}-${testCounter++}.ts`);
		await Bun.write(filePath, content);
		return filePath;
	}

	const postmortemUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "..", "src", "postmortem.ts")).href;

	/** Spawns `script` as a temp file, collects stdout + exit code, cleans up. */
	async function runScript(script: string): Promise<{ stdout: string; exitCode: number }> {
		const file = await makeTempScript(script);
		try {
			const proc = Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
			const [stdout, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			return { stdout, exitCode };
		} finally {
			await fs.unlink(file).catch(() => {});
		}
	}

	const standaloneCrashes = [
		{ name: "uncaughtException", trigger: `throw new Error("test uncaught exception");` },
		{ name: "unhandledRejection", trigger: `Promise.reject(new Error("test unhandled rejection"));` },
	];
	for (const { name, trigger } of standaloneCrashes) {
		it(`standalone mode: ${name} causes process.exit(1)`, async () => {
			const { exitCode } = await runScript(`${trigger} await Bun.sleep(1000);`);
			expect(exitCode).toBe(1);
		});
	}

	it("contain mode: unhandledRejection does not exit the process", async () => {
		const { stdout, exitCode } = await runScript(`
import * as postmortem from ${JSON.stringify(postmortemUrl)};
postmortem.contain();
Promise.reject(new Error("contain test unhandled rejection"));
await Bun.sleep(200);
console.log("ALIVE_AFTER_REJECTION");
`);
		expect(stdout).toContain("ALIVE_AFTER_REJECTION");
		expect(exitCode).toBe(0);
	});

	it("contain mode: uncaughtException does not exit the process", async () => {
		const { stdout, exitCode } = await runScript(`
import * as postmortem from ${JSON.stringify(postmortemUrl)};
postmortem.contain();
setTimeout(() => {
	throw new Error("contain test uncaught exception");
}, 10);
await Bun.sleep(200);
console.log("ALIVE_AFTER_EXCEPTION");
`);
		expect(stdout).toContain("ALIVE_AFTER_EXCEPTION");
		expect(exitCode).toBe(0);
	});

	it("contain mode: cleanup() after a contained error still runs registered callbacks", async () => {
		const { stdout, exitCode } = await runScript(`
import * as postmortem from ${JSON.stringify(postmortemUrl)};
postmortem.contain();
postmortem.register("test-callback", () => {
	process.stdout.write("CALLBACK_RAN\\n");
});
setTimeout(() => {
	throw new Error("contained error before cleanup");
}, 10);
await Bun.sleep(100);
await postmortem.cleanup();
console.log("CLEANUP_DONE");
`);
		expect(stdout).toContain("CALLBACK_RAN");
		expect(stdout).toContain("CLEANUP_DONE");
		expect(exitCode).toBe(0);
	});

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		it(`contain mode: ${signal} invokes registered daemonShutdownHandler`, async () => {
			const { stdout, exitCode } = await runScript(`
import * as postmortem from ${JSON.stringify(postmortemUrl)};
postmortem.contain();
postmortem.setDaemonShutdown(() => {
	process.stdout.write("HANDLER_CALLED\\n");
	process.exit(0);
});
process.emit(${JSON.stringify(signal)});
`);
			expect(stdout).toContain("HANDLER_CALLED");
			expect(exitCode).toBe(0);
		});
	}

	it("contain mode without daemonShutdownHandler: SIGINT returns without action", async () => {
		const { stdout, exitCode } = await runScript(`
import * as postmortem from ${JSON.stringify(postmortemUrl)};
postmortem.contain();
process.emit("SIGINT");
await Bun.sleep(50);
console.log("NO_EXIT_AFTER_SIGINT");
`);
		expect(stdout).toContain("NO_EXIT_AFTER_SIGINT");
		expect(exitCode).toBe(0);
	});
});
