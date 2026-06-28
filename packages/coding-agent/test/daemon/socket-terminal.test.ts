import { afterEach, expect, test } from "bun:test";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeFrame,
	encodeResize,
	FRAME_CWD,
	FRAME_INPUT,
	FRAME_RESUME,
	SocketTerminal,
} from "../../src/modes/daemon/socket-terminal";

let server: net.Server | undefined;
afterEach(() => {
	server?.close();
	server = undefined;
});

function pair(): Promise<[net.Socket, net.Socket]> {
	return new Promise(resolve => {
		const path = join(tmpdir(), `sti-${process.pid}-${Math.floor(performance.now() * 1000)}.sock`);
		server = net.createServer(hostSock => {
			resolve([hostSock, client]);
		});
		let client: net.Socket;
		server.listen(path, () => {
			client = net.connect(path);
		});
	});
}

/** Stands up a UDS pair plus the terminal under test wired to the host side. */
async function setup(runInScope?: <T>(fn: () => T) => T) {
	const [host, client] = await pair();
	const terminal = new SocketTerminal(host, 80, 24, runInScope);
	return { host, client, terminal };
}

test("input frames from client reach the terminal's input handler", async () => {
	const { client, terminal } = await setup();
	const received: string[] = [];
	terminal.start(
		d => received.push(d),
		() => {},
	);

	client.write(encodeFrame(FRAME_INPUT, Buffer.from("hello", "utf8")));
	await Bun.sleep(30);
	expect(received.join("")).toBe("hello");
	client.destroy();
});

test("input arriving before start() is buffered and flushed in order", async () => {
	const { client, terminal } = await setup();
	// Client sends its first keystrokes BEFORE the TUI attaches its handler
	// (the real daemon init race). These must not be dropped.
	client.write(encodeFrame(FRAME_INPUT, Buffer.from("hel", "utf8")));
	client.write(encodeFrame(FRAME_INPUT, Buffer.from("lo", "utf8")));
	await Bun.sleep(30);

	const received: string[] = [];
	terminal.start(
		d => received.push(d),
		() => {},
	);
	expect(received.join("")).toBe("hello");

	client.write(encodeFrame(FRAME_INPUT, Buffer.from("!", "utf8")));
	await Bun.sleep(30);
	expect(received.join("")).toBe("hello!");
	client.destroy();
});

test("resize frames update columns/rows and fire the resize handler", async () => {
	const { client, terminal } = await setup();
	let resizes = 0;
	terminal.start(
		() => {},
		() => resizes++,
	);

	client.write(encodeResize(120, 40));
	await Bun.sleep(30);
	expect(terminal.columns).toBe(120);
	expect(terminal.rows).toBe(40);
	expect(resizes).toBe(1);
	client.destroy();
});

test("terminal writes stream to the client as raw bytes", async () => {
	const { client, terminal } = await setup();
	const chunks: Buffer[] = [];
	client.on("data", c => chunks.push(c as Buffer));

	terminal.write("\x1b[2Jframe-bytes");
	await Bun.sleep(30);
	expect(Buffer.concat(chunks).toString("utf8")).toBe("\x1b[2Jframe-bytes");
	client.destroy();
});

test("split frames reassemble across chunk boundaries", async () => {
	const { client, terminal } = await setup();
	const received: string[] = [];
	terminal.start(
		d => received.push(d),
		() => {},
	);

	const full = encodeFrame(FRAME_INPUT, Buffer.from("abcdef", "utf8"));
	client.write(full.subarray(0, 3));
	await Bun.sleep(10);
	client.write(full.subarray(3));
	await Bun.sleep(30);
	expect(received.join("")).toBe("abcdef");
	client.destroy();
});

// FRAME_CWD/waitForCwd and FRAME_RESUME/waitForResumeSessionId are two
// independent frame-code -> single-shot-promise pairs with identical
// round-trip and never-sent shapes.
const singleShotCases = [
	{
		frame: FRAME_CWD,
		wait: (t: SocketTerminal, ms: number) => t.waitForCwd(ms),
		value: "/Users/alice/project",
		label: "waitForCwd",
	},
	{
		frame: FRAME_RESUME,
		wait: (t: SocketTerminal, ms: number) => t.waitForResumeSessionId(ms),
		value: "conn-42",
		label: "waitForResumeSessionId",
	},
];

for (const { frame, wait, value, label } of singleShotCases) {
	test(`${label} resolves with the value sent in its FRAME`, async () => {
		const { client, terminal } = await setup();
		client.write(encodeFrame(frame, Buffer.from(value, "utf8")));
		expect(await wait(terminal, 1000)).toBe(value);
		client.destroy();
	});

	test(`${label} resolves undefined when the client never sends one`, async () => {
		const { terminal } = await setup();
		expect(await wait(terminal, 30)).toBeUndefined();
	});
}

test("stop() detaches handlers so late frames are ignored", async () => {
	const { client, terminal } = await setup();
	const received: string[] = [];
	terminal.start(
		d => received.push(d),
		() => {},
	);
	terminal.stop();

	client.write(encodeFrame(FRAME_INPUT, Buffer.from("late", "utf8")));
	await Bun.sleep(30);
	expect(received).toEqual([]);
	client.destroy();
});

test("live input dispatches inside the provided scope runner", async () => {
	const { AsyncLocalStorage } = await import("node:async_hooks");
	const als = new AsyncLocalStorage<string>();
	// Mirrors the daemon host: socket data events fire outside the session's
	// ALS scopes; the terminal must re-enter them via runInScope per dispatch.
	const { client, terminal } = await setup(fn => als.run("session-scope", fn));
	const seen: Array<string | undefined> = [];
	terminal.start(
		() => seen.push(als.getStore()),
		() => {},
	);

	client.write(encodeFrame(FRAME_INPUT, Buffer.from("hi", "utf8")));
	await Bun.sleep(30);
	expect(seen).toEqual(["session-scope"]);
	client.destroy();
});

test("write backpressure queues data and flushes on drain event", async () => {
	const writes: string[] = [];
	let drainEmitted = false;
	const events: Record<string, (() => void)[]> = {};
	const mockSocket = {
		writable: true,
		write: (data: string | Buffer): boolean => {
			writes.push(data.toString());
			return drainEmitted;
		},
		once: (event: string, cb: () => void) => {
			if (!events[event]) events[event] = [];
			(events[event] as any[]).push(cb);
		},
		on: (event: string, cb: () => void) => {
			if (!events[event]) events[event] = [];
			(events[event] as any[]).push(cb);
		},
		destroy: () => {
			mockSocket.writable = false;
		},
	} as unknown as net.Socket;

	const terminal = new SocketTerminal(mockSocket as net.Socket, 80, 24);

	// First write returns false - should set waiting flag and wait for drain
	terminal.write("first");
	expect(writes).toEqual(["first"]);
	expect(events["drain"]).toBeDefined();

	// Second write while waiting - should queue without attempting write
	terminal.write("second");
	expect(writes).toEqual(["first"]); // No new write yet

	// Third write - also queued
	terminal.write("third");
	expect(writes).toEqual(["first"]); // Still no new write

	// Emit drain - should flush queue in order
	drainEmitted = true;
	const drainCb = events["drain"]![0];
	drainCb();
	await Bun.sleep(10);

	expect(writes).toEqual(["first", "second", "third"]);
});

test("write backpressure clears queue when socket becomes unwritable", async () => {
	const writes: string[] = [];
	const events: Record<string, (() => void)[]> = {};
	const mockSocket = {
		writable: true,
		write: (data: string | Buffer): boolean => {
			writes.push(data.toString());
			return false; // Always backpressure
		},
		once: (event: string, cb: () => void) => {
			if (!events[event]) events[event] = [];
			(events[event] as any[]).push(cb);
		},
		on: (event: string, cb: () => void) => {
			if (!events[event]) events[event] = [];
			(events[event] as any[]).push(cb);
		},
		destroy: () => {
			mockSocket.writable = false;
		},
	} as unknown as net.Socket;

	const terminal = new SocketTerminal(mockSocket as net.Socket, 80, 24);

	// Queue multiple writes
	terminal.write("one");
	terminal.write("two");
	terminal.write("three");
	expect(writes).toEqual(["one"]); // Only first write happened, others queued

	// Socket becomes unwritable before drain fires
	mockSocket.writable = false;

	// Emit drain - should clear queue without error
	events["drain"]![0]();
	await Bun.sleep(10);

	// No more writes after socket became unwritable
	expect(writes).toEqual(["one"]);
});
