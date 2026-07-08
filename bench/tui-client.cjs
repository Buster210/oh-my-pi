// Thin native-TUI client (~12MB node). Dumb byte pipe: the daemon runs the real
// TUI and streams rendered bytes here; we dump them to the terminal verbatim.
// Keyboard input + resize go back framed. NO rendering logic lives here — that's
// the whole point (parity = the server's real TUI, not a reimplementation).
//
// Self-healing: if the daemon connection drops unexpectedly (daemon crash), this
// client respawns the daemon (via the same mkdir-lock path bench/ompp uses) and
// reattaches, resuming the prior session id so the on-disk transcript rehydrates
// it. A clean disconnect (this session ended, or the daemon shut down on purpose)
// never triggers a respawn — see decideAfterClose() below.
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const FRAME_INPUT = 1;
const FRAME_RESIZE = 2;
const FRAME_CWD = 3;
const FRAME_RESUME = 4;
// client→host: reply to a host clipboard-read control line. Payload =
// [4-byte BE request id][raw result bytes]; just the id when the read failed
// or the clipboard is empty. See FRAME_CLIPBOARD in socket-terminal.ts.
const FRAME_CLIPBOARD = 5;
function frame(type, payload) {
	const h = Buffer.allocUnsafe(5);
	h[0] = type;
	h.writeUInt32BE(payload.length, 1);
	return Buffer.concat([h, payload]);
}
function resizeFrame(cols, rows) {
	const p = Buffer.allocUnsafe(8);
	p.writeUInt32BE(Math.max(1, cols || 80), 0);
	p.writeUInt32BE(Math.max(1, rows || 24), 4);
	return frame(FRAME_RESIZE, p);
}
function cwdFrame(cwd) {
	return frame(FRAME_CWD, Buffer.from(cwd, "utf8"));
}
function resumeFrame(sessionId) {
	return frame(FRAME_RESUME, Buffer.from(sessionId, "utf8"));
}

const MAX_RECONNECT_ATTEMPTS = 3;
const DAEMON_LOG = "/tmp/omp-daemon.log";
// A lock older than this is assumed abandoned (holder crashed between mkdir and
// rmdir) rather than mid-spawn — must exceed the winner's own wait ceiling below
// so a legitimately-still-spawning holder is never mistaken for dead.
const LOCK_STALE_MS = 50000;
// Sentinel a TUI connection ending deliberately writes as its last bytes, right
// before the daemon calls socket.end() — see TUI_SESSION_END_SENTINEL in
// daemon-host.ts (duplicated here; no shared module between the two runtimes).
const END_SENTINEL = `\x00${JSON.stringify({ omp: "end" })}\n`;
const END_SENTINEL_BYTES = Buffer.from(END_SENTINEL, "utf8");

function gracefulMarkerPath(socketPath) {
	return `${socketPath}.graceful`;
}
function lockPath(socketPath) {
	return `${socketPath}.lock`;
}
function lockPidFile(lockDir) {
	return path.join(lockDir, "pid");
}

/**
 * A graceful daemon shutdown leaves this marker behind (daemon-host.ts's
 * shutdown()); the *next* daemon boot deletes it, so its mere presence already
 * means "the daemon at this socket path stopped on purpose, and nothing has
 * booted here since" — no need to consume it. Read-only, so every one of N
 * simultaneously-reconnecting clients sees the same answer (a consume-on-read
 * `unlink` here would race: only the first reader would see it, and the rest
 * would misdiagnose a crash and respawn the daemon the user just stopped).
 */
function isGracefulShutdown(socketPath, fsImpl = fs) {
	return fsImpl.existsSync(gracefulMarkerPath(socketPath));
}

/** `kill -0` equivalent: true if `pid` is a live process we can at least see. */
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // exists, just owned by someone else
	}
}

/** Is the respawn lock abandoned (dead holder, or just too old to still be a live spawn)? */
function isLockStale(lockDir, nowMs = Date.now(), fsImpl = fs) {
	let pidText;
	try {
		pidText = fsImpl.readFileSync(lockPidFile(lockDir), "utf8");
	} catch {
		pidText = undefined;
	}
	if (pidText !== undefined) {
		const pid = Number.parseInt(pidText, 10);
		return !(Number.isInteger(pid) && isProcessAlive(pid));
	}
	// No pid file yet — either a fresh mkdir mid-write, or an ancient lock from
	// before this field existed. Age is the only signal left.
	let stat;
	try {
		stat = fsImpl.statSync(lockDir);
	} catch {
		return true; // vanished mid-check; treat as free
	}
	return nowMs - stat.mtimeMs > LOCK_STALE_MS;
}

/**
 * Decision after an unexpected socket close. Pure (no I/O beyond the marker
 * check) and separated from the socket plumbing so the race this used to have —
 * "daemon is reachable again" was treated as proof this session ended on
 * purpose, even when a sibling client's respawn just won a race against this
 * client's own crash detection — is unit-testable without a real socket pair.
 * Deliberate ends are the only case that skips reconnect: an end-sentinel
 * (session finished, e.g. the user quit) or a graceful-shutdown marker (daemon
 * stopped on purpose). Anything else — including "the daemon looks alive again,
 * probably someone else's respawn" — reattaches with FRAME_RESUME, which is a
 * no-op if this session is in fact still running under that daemon.
 */
function decideAfterClose({ sawEndSentinel, socketPath }, fsImpl = fs) {
	if (sawEndSentinel) return "exit";
	if (isGracefulShutdown(socketPath, fsImpl)) return "exit";
	return "reconnect";
}

/**
 * Split render bytes so a trailing end-sentinel (or a prefix of one — it can
 * arrive split across reads) is HELD BACK instead of written to the terminal:
 * printing it first and detecting it later flashed a raw `\x00{"omp":"end"}`
 * at the user on every ordinary quit. `out` is safe to print now; `held` is
 * either flushed by the next chunk (false start — real render bytes) or, at
 * close, compared against the full sentinel to classify the disconnect.
 */
function sentinelSplit(held, bytes) {
	const buf = held.length ? Buffer.concat([held, bytes]) : bytes;
	let k = Math.min(buf.length, END_SENTINEL_BYTES.length);
	while (k > 0 && !buf.subarray(buf.length - k).equals(END_SENTINEL_BYTES.subarray(0, k))) k--;
	return { out: buf.subarray(0, buf.length - k), held: buf.subarray(buf.length - k) };
}

// A NUL-prefixed control line longer than this is not a control line — flush it
// as render bytes instead of holding the stream hostage waiting for a newline.
const MAX_CONTROL_LINE = 4096;

/**
 * Generalizes sentinelSplit for VARIABLE-length control lines: the daemon's
 * clipboard-read request (`\x00{"omp":"clipboard-read",...}\n`) shares the
 * `\x00{"omp":"` prefix with the end sentinel but diverges after, so the
 * fixed-sentinel suffix match above can't hold it back. This scans for NUL,
 * holds from there until the `\n` (across chunk boundaries), then dispatches:
 * a parsed message `onControl` consumes is stripped from the render output;
 * a trailing end sentinel is held back for the close handler exactly like
 * sentinelSplit did; anything else (unparsable, unknown) is flushed verbatim
 * so an older/different daemon's bytes are never silently dropped.
 */
function controlSplit(held, bytes, onControl) {
	let buf = held.length ? Buffer.concat([held, bytes]) : bytes;
	const out = [];
	for (;;) {
		const nul = buf.indexOf(0);
		if (nul === -1) {
			out.push(buf);
			return { out: Buffer.concat(out), held: Buffer.alloc(0) };
		}
		out.push(buf.subarray(0, nul));
		const rest = buf.subarray(nul);
		const nl = rest.indexOf(0x0a);
		if (nl === -1) {
			if (rest.length > MAX_CONTROL_LINE) {
				out.push(rest);
				return { out: Buffer.concat(out), held: Buffer.alloc(0) };
			}
			return { out: Buffer.concat(out), held: rest };
		}
		const line = rest.subarray(0, nl + 1);
		let msg;
		try {
			msg = JSON.parse(line.subarray(1, nl).toString("utf8"));
		} catch {
			msg = undefined;
		}
		if (msg && onControl && onControl(msg)) {
			// consumed (e.g. clipboard-read) — stripped from render output
		} else if (line.equals(END_SENTINEL_BYTES) && rest.length === nl + 1) {
			return { out: Buffer.concat(out), held: line };
		} else {
			out.push(line);
		}
		buf = rest.subarray(nl + 1);
	}
}

// --- client-side clipboard reads (host asks, we read OUR OS clipboard) ---

// Images: a full-res PNG screenshot can be tens of MB.
const CLIP_MAX_BUFFER = 64 * 1024 * 1024;
const CLIP_TIMEOUT_MS = 2500;

/** Run a command, feed optional stdin, resolve raw stdout Buffer — null on any failure. */
function runCapture(cmd, args, input) {
	return new Promise(resolve => {
		let child;
		try {
			child = execFile(
				cmd,
				args,
				{ encoding: "buffer", maxBuffer: CLIP_MAX_BUFFER, timeout: CLIP_TIMEOUT_MS },
				(err, stdout) => resolve(err ? null : stdout),
			);
		} catch {
			resolve(null);
			return;
		}
		if (input !== undefined && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}

// Same AppleScript as clipboard.ts's MAC_FILE_URL_SCRIPT (duplicated — no shared
// module between the two runtimes): POSIX paths of file URLs on the pasteboard,
// one per line, empty output when there are none.
const MAC_FILE_URL_SCRIPT = [
	"on run",
	'\tset output to ""',
	"\ttry",
	"\t\tset theClip to the clipboard as «class furl»",
	"\t\tif class of theClip is list then",
	"\t\t\trepeat with anItem in theClip",
	"\t\t\t\ttry",
	"\t\t\t\t\tset output to output & POSIX path of anItem & linefeed",
	"\t\t\t\tend try",
	"\t\t\tend repeat",
	"\t\telse",
	"\t\t\ttry",
	"\t\t\t\tset output to POSIX path of theClip & linefeed",
	"\t\t\tend try",
	"\t\tend if",
	"\tend try",
	"\treturn output",
	"end run",
].join("\n");

/** macOS clipboard image → PNG bytes via AppleScript's «class PNGf» through a temp file (no pngpaste dependency). */
async function readMacImage() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-clip-"));
	const tmp = path.join(dir, "clip.png");
	const script = [
		"try",
		"\tset pngData to the clipboard as «class PNGf»",
		`\tset f to open for access POSIX file "${tmp}" with write permission`,
		"\twrite pngData to f",
		"\tclose access f",
		"end try",
	].join("\n");
	try {
		await runCapture("osascript", ["-"], script);
		return fs.readFileSync(tmp);
	} catch {
		return Buffer.alloc(0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Read this machine's clipboard for the daemon (kinds mirror clipboard.ts's
 * native readers). Never throws; empty Buffer means "nothing there / failed",
 * which the daemon maps back to today's empty-clipboard behavior.
 */
async function readClipboard(kind) {
	try {
		if (process.platform === "darwin") {
			if (kind === "text") return (await runCapture("pbpaste", [])) || Buffer.alloc(0);
			if (kind === "image") return await readMacImage();
			if (kind === "macFileUrls") return (await runCapture("osascript", ["-"], MAC_FILE_URL_SCRIPT)) || Buffer.alloc(0);
		} else if (process.platform === "linux") {
			// ponytail: wl-paste then xclip, same order as clipboard.ts; no Windows/WSL
			// branch — the bench client only runs on mac/linux dev boxes today.
			if (kind === "text") {
				return (
					(await runCapture("wl-paste", ["--type", "text/plain", "--no-newline"])) ||
					(await runCapture("xclip", ["-selection", "clipboard", "-o"])) ||
					Buffer.alloc(0)
				);
			}
			if (kind === "image") {
				return (
					(await runCapture("wl-paste", ["--type", "image/png"])) ||
					(await runCapture("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"])) ||
					Buffer.alloc(0)
				);
			}
		}
	} catch {
		// fall through — clipboard reads are best-effort
	}
	return Buffer.alloc(0);
}

/**
 * Handle one parsed control message from the render stream. Returns true when
 * the message was a clipboard-read request (so controlSplit strips it); the
 * reply — [4-byte BE id][result bytes], empty result on failure — goes back as
 * a FRAME_CLIPBOARD frame. A clipboard failure never crashes the client; the
 * daemon's timeout covers a reply that never makes it.
 */
function handleControl(msg, sock, read = readClipboard) {
	if (!msg || msg.omp !== "clipboard-read" || !Number.isInteger(msg.id)) return false;
	read(msg.kind)
		.catch(() => Buffer.alloc(0))
		.then(result => {
			const idBuf = Buffer.allocUnsafe(4);
			idBuf.writeUInt32BE(msg.id >>> 0, 0);
			if (!sock.destroyed) sock.write(frame(FRAME_CLIPBOARD, Buffer.concat([idBuf, result])));
		});
	return true;
}

module.exports = {
	decideAfterClose,
	sentinelSplit,
	controlSplit,
	handleControl,
	readClipboard,
	FRAME_CLIPBOARD,
	frame,
	isGracefulShutdown,
	isLockStale,
	isProcessAlive,
	gracefulMarkerPath,
	lockPath,
	lockPidFile,
	END_SENTINEL,
	END_SENTINEL_BYTES,
	LOCK_STALE_MS,
};

if (require.main === module) {
	main();
}

function main() {
	const socketPath = process.argv[2];
	if (!socketPath) {
		process.stderr.write("usage: node tui-client.cjs <socketPath>\n");
		process.exit(1);
	}

	const benchDir = __dirname;
	const ompp = path.join(benchDir, "ompp");
	const lock = lockPath(socketPath);

	// Learned from the daemon's session-id preamble; carried across reconnects
	// so a respawned daemon rehydrates the same session instead of a fresh one.
	let sessionId;
	let reconnectAttempts = 0;

	function restoreTerminal() {
		if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
		process.stdin.pause();
	}
	function cleanupAndExit(code) {
		restoreTerminal();
		process.exit(code);
	}

	function pingDaemon(timeoutMs) {
		return new Promise(resolve => {
			const probe = net.connect(socketPath);
			const timer = setTimeout(() => {
				probe.destroy();
				resolve(false);
			}, timeoutMs);
			probe.on("connect", () => {
				clearTimeout(timer);
				probe.end();
				resolve(true);
			});
			probe.on("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	}

	async function waitForDaemonAlive(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await pingDaemon(500)) return true;
			await new Promise(r => setTimeout(r, 500));
		}
		return false;
	}

	function writeLockPid() {
		try {
			fs.writeFileSync(lockPidFile(lock), String(process.pid));
		} catch {
			// best-effort — a missing pid file just falls back to age-based staleness
		}
	}
	function removeLock() {
		try {
			fs.rmSync(lock, { recursive: true, force: true });
		} catch {
			// already gone
		}
	}

	/** mkdir-lock acquire, stealing an abandoned lock (dead holder / too old). */
	function acquireOrStealLock() {
		try {
			fs.mkdirSync(lock);
			writeLockPid();
			return true;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
		}
		if (!isLockStale(lock)) return false; // a live spawn is genuinely in progress
		// ponytail: best-effort steal — if another client wins this race, mkdir
		// throws again and we just fall through to waiting like everyone else.
		removeLock();
		try {
			fs.mkdirSync(lock);
			writeLockPid();
			return true;
		} catch {
			return false;
		}
	}

	/** Respawn the daemon via the exact mkdir-lock path bench/ompp uses for first
	 * launch, so a client-triggered respawn and a fresh `ompp` invocation racing
	 * at the same time still only start one daemon. */
	async function respawnDaemon() {
		if (await pingDaemon(500)) return true; // a sibling client already brought it back
		const gotLock = acquireOrStealLock();
		if (gotLock) {
			const log = fs.openSync(DAEMON_LOG, "a");
			spawn("bash", [ompp, "--mode", "daemon"], {
				cwd: benchDir,
				env: { ...process.env, OMP_DAEMON_TUI: "1" },
				stdio: ["ignore", log, log],
				detached: true,
			}).unref();
			fs.closeSync(log);
		}
		const alive = await waitForDaemonAlive(gotLock ? 40000 : 60000);
		if (gotLock) removeLock();
		return alive;
	}

	function connect() {
		const sock = net.connect(socketPath);
		let gotPreamble = false;
		let preambleBuf = Buffer.alloc(0);
		let held = Buffer.alloc(0);
		// Armed on connect, cleared on close: the crash-loop counter only resets once
		// the connection has proven stable. Resetting on raw 'connect' would let a
		// daemon that accepts, hands over the preamble, then deterministically dies
		// (e.g. a rehydrate crash) defeat MAX_RECONNECT_ATTEMPTS and loop forever.
		let stableTimer;

		function emit(bytes) {
			if (!bytes.length) return;
			// controlSplit strips clipboard-read control lines (answered out of band
			// via FRAME_CLIPBOARD) and holds back the end sentinel, exactly like
			// sentinelSplit did for the sentinel alone.
			const split = controlSplit(held, bytes, msg => handleControl(msg, sock));
			held = split.held;
			if (split.out.length) process.stdout.write(split.out);
		}

		sock.on("connect", () => {
			stableTimer = setTimeout(() => {
				reconnectAttempts = 0;
			}, 5000);
			if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
			process.stdin.resume();
			// tell the host our real cwd and size up front (+ prior session id, if
			// reattaching), then resize on every change
			sock.write(cwdFrame(process.env.OMP_LAUNCH_CWD || process.cwd()));
			if (sessionId) sock.write(resumeFrame(sessionId));
			sock.write(resizeFrame(process.stdout.columns, process.stdout.rows));
		});

		const onResize = () => sock.write(resizeFrame(process.stdout.columns, process.stdout.rows));
		process.stdout.on("resize", onResize);
		const onStdinData = chunk => sock.write(frame(FRAME_INPUT, chunk));
		process.stdin.on("data", onStdinData);

		// host -> client: one `\n`-terminated JSON preamble carrying the session id,
		// then a raw byte stream (rendered TUI bytes) dumped straight to the terminal.
		sock.on("data", chunk => {
			if (gotPreamble) {
				emit(chunk);
				return;
			}
			preambleBuf = preambleBuf.length ? Buffer.concat([preambleBuf, chunk]) : chunk;
			const nl = preambleBuf.indexOf(0x0a);
			if (nl === -1) return; // preamble line not fully arrived yet
			gotPreamble = true;
			try {
				const msg = JSON.parse(preambleBuf.subarray(0, nl).toString("utf8"));
				if (msg && msg.omp === "session" && typeof msg.sessionId === "string") sessionId = msg.sessionId;
			} catch {
				// not a preamble (older/different daemon) — treat everything received
				// so far as render bytes instead of silently dropping it
				emit(preambleBuf);
				return;
			}
			emit(preambleBuf.subarray(nl + 1));
		});

		sock.on("close", () => {
			clearTimeout(stableTimer);
			process.stdout.removeListener("resize", onResize);
			process.stdin.removeListener("data", onStdinData);
			const sawEndSentinel = held.equals(END_SENTINEL_BYTES);
			// A partial hold that never completed was real render bytes — flush it.
			if (!sawEndSentinel && held.length) process.stdout.write(held);
			void handleDisconnect(sawEndSentinel);
		});
		sock.on("error", () => {}); // 'close' always follows; that's what drives reconnect

		async function handleDisconnect(sawEndSentinel) {
			if (decideAfterClose({ sawEndSentinel, socketPath }) === "exit") {
				cleanupAndExit(0);
				return;
			}

			reconnectAttempts += 1;
			if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
				process.stderr.write(
					`\nomp: daemon connection lost and did not recover after ${MAX_RECONNECT_ATTEMPTS} attempts.\n` +
						`See ${DAEMON_LOG} for details.\n`,
				);
				cleanupAndExit(1);
				return;
			}
			process.stdout.write(
				`\n(daemon connection lost — reconnecting, attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}…)\n`,
			);
			const alive = await respawnDaemon();
			if (!alive) {
				process.stderr.write(`\nomp: could not restart the daemon. See ${DAEMON_LOG} for details.\n`);
				cleanupAndExit(1);
				return;
			}
			connect();
		}
	}

	connect();

	process.on("SIGINT", () => {}); // Ctrl+C must reach the remote TUI, not kill the client
	process.on("exit", restoreTerminal);
	// A client whose terminal is gone must die, not haunt the socket path
	// forever respawning daemons it can no longer display (the reconnect loop
	// would otherwise keep a headless orphan alive indefinitely). Terminal
	// teardown surfaces as stdin EOF/error or stdout EIO — treat all as fatal.
	process.stdin.on("end", () => cleanupAndExit(0));
	process.stdin.on("error", () => cleanupAndExit(1));
	process.stdout.on("error", () => cleanupAndExit(1));
}
