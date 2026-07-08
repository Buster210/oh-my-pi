/**
 * Server-side terminal transport for the daemon (Phase A, architecture A).
 *
 * The real native TUI runs IN the daemon against this transport. Its rendered
 * bytes go straight down the socket (host→client is a raw byte stream the thin
 * client dumps to its real terminal). Client→host is framed, because that
 * direction multiplexes two things over one socket: raw keyboard input and
 * out-of-band resize reports (the byte stream alone can't carry size).
 *
 * Frame (client→host): [1 byte type][4 byte BE length][payload].
 *   type 1 (INPUT):  payload = raw utf-8 keyboard bytes
 *   type 2 (RESIZE): payload = 8 bytes — uint32 BE cols, uint32 BE rows
 *   type 3 (CWD):    payload = utf-8 absolute path, the client's real cwd
 *   type 4 (RESUME): payload = utf-8 session id — a reconnecting client's
 *                     prior session, so the daemon rehydrates it from disk
 *                     instead of minting a fresh one (see daemon-host.ts).
 *
 * Host→client is otherwise a raw byte stream (rendered TUI bytes), except for
 * one line written before the TUI starts rendering: a `\n`-terminated JSON
 * preamble `{"omp":"session","sessionId":"..."}` carrying this connection's
 * session id, so a reconnecting client knows what to send back as RESUME.
 *
 * The client owns the real tty (raw mode, encoding, capability probes,
 * cursor/appearance queries) — every terminal-ownership method here is a
 * no-op or a static default. `SocketTerminal` only needs to satisfy the
 * `Terminal` contract enough for `TUI`/`InteractiveMode` to render.
 */
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";
import type { ClipboardKind } from "./session-scope";

export const FRAME_INPUT = 1;
export const FRAME_RESIZE = 2;
export const FRAME_CWD = 3;
export const FRAME_RESUME = 4;
/**
 * client→host: response to a host clipboard-read request. Payload =
 * [4-byte BE request id][raw result bytes]. Result bytes are the client's
 * local clipboard content (PNG for image, utf-8 for text/file-urls); an empty
 * result (payload length 4, no data) means "nothing on the clipboard". Keyed
 * by id so the right pending read resolves — see `requestClipboard`.
 */
export const FRAME_CLIPBOARD = 5;
const HEADER_BYTES = 5;
/**
 * Pre-attach input threshold. Input buffered before `start()` attaches the
 * handler stays in `#pendingInput`; once it crosses this, the socket is paused
 * so the kernel/TCP holds the rest losslessly (backpressure) instead of the
 * old silent drop — a large paste racing session init keeps its tail.
 */
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
/** Max frame payload bytes; reject and close socket if a frame header claims more. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MB
/**
 * Larger per-frame cap for clipboard responses only: a full-resolution PNG
 * screenshot routinely exceeds 8 MB, and the client sends it as one frame.
 * Still bounded so a hostile/garbled frame can't grow unbounded.
 */
const MAX_CLIPBOARD_FRAME_BYTES = 64 * 1024 * 1024; // 64 MB

/** Encode a client→host frame. Used by the thin client. */
export function encodeFrame(type: number, payload: Buffer): Buffer {
	const header = Buffer.allocUnsafe(HEADER_BYTES);
	header[0] = type;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/** Encode a RESIZE frame carrying cols/rows. */
export function encodeResize(cols: number, rows: number): Buffer {
	const p = Buffer.allocUnsafe(8);
	p.writeUInt32BE(Math.max(1, cols | 0), 0);
	p.writeUInt32BE(Math.max(1, rows | 0), 4);
	return encodeFrame(FRAME_RESIZE, p);
}

export class SocketTerminal implements Terminal {
	#socket: Socket;
	#cols: number;
	#rows: number;
	#buf: Buffer = Buffer.alloc(0);
	/**
	 * Decodes FRAME_INPUT payloads. The client frames each raw stdin chunk on its
	 * own, and the OS splits a large paste at arbitrary BYTE offsets — routinely
	 * mid-UTF-8. Decoding each frame independently with `toString("utf8")` turns a
	 * multibyte scalar straddling a frame boundary into U+FFFD on both sides,
	 * corrupting large/non-ASCII pastes. A persistent decoder carries the partial
	 * trailing bytes into the next frame instead, exactly like a real TTY's stream.
	 */
	#inputDecoder = new StringDecoder("utf8");
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	/**
	 * Input received before `start()` attaches `#inputHandler`. The TUI attaches
	 * it only after a multi-await init chain (main.ts → interactive-mode init →
	 * ui.start()), but the socket parses frames from byte one — so a fast first
	 * keystroke would be dropped, matching a real TTY that buffers pre-attach
	 * bytes at the kernel/stream layer. Queue here, flush in order on start().
	 */
	#pendingInput: string[] = [];
	#pendingInputBytes = 0;
	/** True while the socket is paused for pre-attach input backpressure. */
	#inputPaused = false;
	#clipboardSeq = 0;
	/** Pending client clipboard reads, keyed by request id (see `requestClipboard`). */
	#pendingClipboard = new Map<number, (result: Buffer | null) => void>();
	#writeQueue: string[] = [];
	#waitingForDrain = false;
	#cwd?: string;
	#resolveCwd?: (cwd: string | undefined) => void;
	#cwdPromise: Promise<string | undefined>;
	#resumeSessionId?: string;
	#resolveResumeSessionId?: (id: string | undefined) => void;
	#resumeSessionIdPromise: Promise<string | undefined>;

	/**
	 * Socket `data` events fire in the connection's async context, created
	 * before the daemon enters its per-session AsyncLocalStorage scopes — so
	 * without `runInScope`, every live keystroke (and the whole agent turn its
	 * submit chains into) resolves session-scoped singletons to the module
	 * globals instead of this session's instances. The host passes a wrapper
	 * that re-enters its composed scopes around each dispatch.
	 */
	constructor(socket: Socket, initialCols = 80, initialRows = 24, runInScope: <T>(fn: () => T) => T = fn => fn()) {
		this.#socket = socket;
		this.#cols = Math.max(1, initialCols);
		this.#rows = Math.max(1, initialRows);
		this.#cwdPromise = new Promise(resolve => {
			this.#resolveCwd = resolve;
		});
		this.#resumeSessionIdPromise = new Promise(resolve => {
			this.#resolveResumeSessionId = resolve;
		});
		socket.on("data", chunk => runInScope(() => this.#ingest(chunk as Buffer)));
	}

	/** Shared timeout-race body: wait for `promise`, falling back to `getCurrent()` after `timeoutMs`. */
	async #waitFor<T>(promise: Promise<T>, getCurrent: () => T, timeoutMs: number): Promise<T> {
		let timer: NodeJS.Timeout;
		const timeout = new Promise<T>(resolve => {
			timer = setTimeout(() => resolve(getCurrent()), timeoutMs);
		});
		const result = await Promise.race([promise, timeout]);
		clearTimeout(timer!);
		return result;
	}

	/** Wait up to `timeoutMs` for the client's FRAME_CWD. Resolves `undefined` on timeout — a client that never sends one still works. */
	async waitForCwd(timeoutMs: number): Promise<string | undefined> {
		return this.#waitFor(this.#cwdPromise, () => this.#cwd, timeoutMs);
	}

	/** Wait up to `timeoutMs` for the client's FRAME_RESUME. Resolves `undefined` on timeout — a fresh (non-reconnecting) client never sends one. */
	async waitForResumeSessionId(timeoutMs: number): Promise<string | undefined> {
		return this.#waitFor(this.#resumeSessionIdPromise, () => this.#resumeSessionId, timeoutMs);
	}

	#ingest(chunk: Buffer): void {
		this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
		while (this.#buf.length >= HEADER_BYTES) {
			const type = this.#buf[0];
			const len = this.#buf.readUInt32BE(1);
			const cap = type === FRAME_CLIPBOARD ? MAX_CLIPBOARD_FRAME_BYTES : MAX_FRAME_BYTES;
			if (len > cap) {
				this.#socket.destroy();
				return;
			}
			if (this.#buf.length < HEADER_BYTES + len) break;
			const payload = this.#buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
			this.#buf = this.#buf.subarray(HEADER_BYTES + len);
			if (type === FRAME_INPUT) {
				const data = this.#inputDecoder.write(payload);
				if (data.length === 0) continue;
				if (this.#inputHandler) {
					this.#inputHandler(data);
				} else {
					this.#pendingInput.push(data);
					this.#pendingInputBytes += payload.length;
					// Backpressure instead of dropping: once buffered pre-attach input
					// crosses the cap, pause the socket so the kernel/TCP holds the rest
					// losslessly until start() flushes and resumes. Lossless replaces
					// the old silent truncation of a large paste racing session init.
					if (this.#pendingInputBytes >= MAX_PENDING_INPUT_BYTES && !this.#inputPaused) {
						this.#inputPaused = true;
						this.#socket.pause();
					}
				}
			} else if (type === FRAME_CLIPBOARD && payload.length >= 4) {
				const id = payload.readUInt32BE(0);
				const resolve = this.#pendingClipboard.get(id);
				if (resolve) {
					this.#pendingClipboard.delete(id);
					resolve(payload.subarray(4));
				}
			} else if (type === FRAME_RESIZE && payload.length >= 8) {
				this.#cols = Math.max(1, payload.readUInt32BE(0));
				this.#rows = Math.max(1, payload.readUInt32BE(4));
				this.#resizeHandler?.();
			} else if (type === FRAME_CWD) {
				this.#cwd = payload.toString("utf8");
				this.#resolveCwd?.(this.#cwd);
				this.#resolveCwd = undefined;
			} else if (type === FRAME_RESUME) {
				this.#resumeSessionId = payload.toString("utf8");
				this.#resolveResumeSessionId?.(this.#resumeSessionId);
				this.#resolveResumeSessionId = undefined;
			}
		}
	}

	// --- Terminal ---
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		// Flush any input that arrived before the handler attached, in order.
		if (this.#pendingInput.length) {
			const pending = this.#pendingInput;
			this.#pendingInput = [];
			this.#pendingInputBytes = 0;
			for (const data of pending) onInput(data);
		}
		// Release any backpressure pause: the handler is attached now, so the
		// kernel-buffered tail flows in and dispatches live.
		if (this.#inputPaused) {
			this.#inputPaused = false;
			this.#socket.resume();
		}
	}

	/**
	 * Ask the connected client to read ITS OWN local OS clipboard and stream the
	 * bytes back over a {@link FRAME_CLIPBOARD} frame, keyed by request id so the
	 * right caller resolves. Isolates per session: the daemon HOST's clipboard is
	 * never touched, so nothing leaks across sessions.
	 *
	 * The request goes host→client as a NUL-prefixed JSON control line (`\x00` +
	 * JSON + `\n`) — same convention as the session/end sentinels; NUL never
	 * appears in terminal render bytes, so the client can pick it out of the raw
	 * host→client stream and tell it apart from real output.
	 *
	 * Resolves `null` on timeout or when the socket is dead — an old client that
	 * doesn't understand the request simply never answers, so callers fall back
	 * to an empty read (today's daemon behavior), never a hang.
	 */
	async requestClipboard(kind: ClipboardKind, timeoutMs: number): Promise<Buffer | null> {
		if (!this.#socket.writable) return null;
		const id = ++this.#clipboardSeq;
		const result = new Promise<Buffer | null>(resolve => {
			const timer = setTimeout(() => {
				this.#pendingClipboard.delete(id);
				resolve(null);
			}, timeoutMs);
			this.#pendingClipboard.set(id, payload => {
				clearTimeout(timer);
				resolve(payload);
			});
		});
		this.write(`\x00${JSON.stringify({ omp: "clipboard-read", kind, id })}\n`);
		return result;
	}

	stop(): void {
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
	}

	// The client drains its own stdin before exiting; nothing to drain here.
	async drainInput(): Promise<void> {}

	write(data: string): void {
		if (!this.#socket.writable) return;
		if (this.#waitingForDrain || this.#writeQueue.length) {
			this.#writeQueue.push(data);
			return;
		}
		if (this.#socket.write(data) === false) {
			// socket.write() returned false - the data is buffered internally.
			// Set flag to queue subsequent writes; we'll resume on 'drain'.
			this.#waitingForDrain = true;
			this.#socket.once("drain", () => this.#resumeWrites());
		}
	}

	#resumeWrites(): void {
		this.#waitingForDrain = false;
		while (this.#writeQueue.length) {
			if (!this.#socket.writable) {
				// Socket became unwritable; drop remaining queued writes.
				this.#writeQueue.length = 0;
				return;
			}
			if (this.#socket.write(this.#writeQueue.shift()!) === false) {
				this.#waitingForDrain = true;
				this.#socket.once("drain", () => this.#resumeWrites());
				return;
			}
		}
	}

	get columns(): number {
		return this.#cols;
	}
	get rows(): number {
		return this.#rows;
	}

	// The client's real terminal owns the kitty keyboard protocol negotiation;
	// the host never probes/enables it over the byte pipe.
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	readonly keyboardEnhancementEnterSequence: string | null = null;
	readonly keyboardEnhancementExitSequence: string | null = null;

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}
	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	/** Raw escape-sequence passthrough (OSC 52 clipboard, title save/restore) — same socket-write path as `write`. */
	writeEscape(data: string): void {
		this.write(data);
	}
	setProgress(): void {
		// ponytail: no OSC 9;4 progress relay over the socket yet — add if a thin
		// client wants taskbar progress; today it only mirrors the render bytes.
	}

	// Appearance (dark/light) detection requires an OSC 11 round-trip with the
	// real terminal, which only the client can do. No injected terminal reports
	// appearance today; callers already treat `undefined` as "unknown".
	onAppearanceChange(): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}
