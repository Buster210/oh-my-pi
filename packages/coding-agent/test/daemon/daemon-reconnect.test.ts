/**
 * Sanity coverage for the daemon self-heal reconnect protocol (bench/tui-client.cjs
 * + daemon-host.ts): the session-id preamble on the wire, the graceful-shutdown
 * marker (read-only — see bench/tui-client.cjs's isGracefulShutdown), and the
 * session-end sentinel shape. Doesn't spin up a full daemon host (that calls
 * process.exit on shutdown); instead it exercises the exact wire format /
 * marker-file contract both sides rely on. The reconnect *decision* logic itself
 * (decideAfterClose) lives in bench/tui-client.cjs and is covered by
 * bench/tui-client.test.cjs — run `node --test bench/tui-client.test.cjs`.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gracefulShutdownMarkerPath, TUI_SESSION_END_SENTINEL } from "../../src/modes/daemon/daemon-host";

let server: net.Server | undefined;
afterEach(async () => {
	server?.close();
	server = undefined;
});

function pair(): Promise<[net.Socket, net.Socket]> {
	return new Promise(resolve => {
		const path = join(tmpdir(), `dr-${process.pid}-${Math.floor(performance.now() * 1000)}.sock`);
		server = net.createServer(hostSock => {
			resolve([hostSock, client]);
		});
		let client: net.Socket;
		server.listen(path, () => {
			client = net.connect(path);
		});
	});
}

/** Mirrors bench/tui-client.cjs's preamble parser: buffers until the first `\n`,
 * parses that line as JSON, and returns it plus whatever raw bytes followed in
 * the same read. */
function parsePreamble(buf: Buffer): { msg: unknown; rest: Buffer } | undefined {
	const nl = buf.indexOf(0x0a);
	if (nl === -1) return undefined;
	return { msg: JSON.parse(buf.subarray(0, nl).toString("utf8")), rest: buf.subarray(nl + 1) };
}

test("the session-id preamble round-trips, and raw TUI bytes after it are unaffected", async () => {
	const [host, client] = await pair();
	const sessionId = "conn-7";

	// Exactly what daemon-host.ts writes before runInteractiveMode starts rendering.
	host.write(`${JSON.stringify({ omp: "session", sessionId })}\n`);
	// Then the usual raw byte stream — arriving in the same TCP/UDS read as the
	// preamble is the tightest case (no boundary flush between them).
	host.write("\x1b[2Jhello from the tui");

	const chunks: Buffer[] = [];
	await new Promise<void>(resolve => {
		client.on("data", c => {
			chunks.push(c as Buffer);
			if (Buffer.concat(chunks).includes("hello from the tui")) resolve();
		});
	});

	const parsed = parsePreamble(Buffer.concat(chunks));
	expect(parsed).toBeDefined();
	expect(parsed?.msg).toEqual({ omp: "session", sessionId: "conn-7" });
	expect(parsed?.rest.toString("utf8")).toBe("\x1b[2Jhello from the tui");
	client.destroy();
});

test("preamble split across two socket reads still parses (client buffers until the newline)", async () => {
	const [host, client] = await pair();
	const line = `${JSON.stringify({ omp: "session", sessionId: "conn-split" })}\n`;

	const chunks: Buffer[] = [];
	let parsed: ReturnType<typeof parsePreamble>;
	const gotIt = new Promise<void>(resolve => {
		client.on("data", c => {
			chunks.push(c as Buffer);
			parsed = parsePreamble(Buffer.concat(chunks));
			if (parsed) resolve();
		});
	});

	// Client's listener is attached (above) before either write, matching the real
	// client, which listens from the moment it connects — the meaningful case here
	// is the newline landing in a later read than the JSON that precedes it.
	host.write(line.slice(0, 5));
	await Bun.sleep(10);
	host.write(line.slice(5));
	await gotIt;

	expect(parsed?.msg).toEqual({ omp: "session", sessionId: "conn-split" });
	client.destroy();
});

test("graceful shutdown marker: absent means crash", async () => {
	const socketPath = join(tmpdir(), `dr-marker-a-${process.pid}-${Math.floor(performance.now() * 1000)}.sock`);
	const markerPath = gracefulShutdownMarkerPath(socketPath);
	await expect(fs.access(markerPath)).rejects.toThrow();
});

test("graceful shutdown marker: read-without-consume — N reconnecting clients all see it", async () => {
	const socketPath = join(tmpdir(), `dr-marker-b-${process.pid}-${Math.floor(performance.now() * 1000)}.sock`);
	const markerPath = gracefulShutdownMarkerPath(socketPath);

	// daemon-host.ts's shutdown() writes this before exiting.
	await fs.writeFile(markerPath, "");
	// Client-side check (bench/tui-client.cjs isGracefulShutdown) must be read-only:
	// a consume-on-read unlink here would mean only the first of N simultaneously
	// reconnecting clients sees "graceful" — the rest hit ENOENT, misdiagnose a
	// crash, and respawn the daemon the user just intentionally stopped.
	for (let reader = 0; reader < 3; reader++) {
		await fs.access(markerPath); // throws (failing the test) if the marker is gone
	}

	// Staleness is handled at the *next* daemon boot instead (runDaemonHost's
	// startup unlink), not by the client — simulate that boot here.
	await fs.unlink(markerPath);
	await expect(fs.access(markerPath)).rejects.toThrow();
});

test("TUI session-end sentinel is a `\\n`-terminated JSON line prefixed with a byte that can't appear in normal terminal output", () => {
	expect(TUI_SESSION_END_SENTINEL.startsWith("\x00")).toBe(true);
	expect(TUI_SESSION_END_SENTINEL.endsWith("\n")).toBe(true);
	expect(JSON.parse(TUI_SESSION_END_SENTINEL.slice(1, -1))).toEqual({ omp: "end" });
});
