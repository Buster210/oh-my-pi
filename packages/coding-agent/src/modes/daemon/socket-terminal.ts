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
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";

export const FRAME_INPUT = 1;
export const FRAME_RESIZE = 2;
export const FRAME_CWD = 3;
export const FRAME_RESUME = 4;
const HEADER_BYTES = 5;
/** Cap on input buffered before `start()` attaches the handler (see `#pendingInput`). */
const MAX_PENDING_INPUT_BYTES = 256 * 1024;

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
			if (this.#buf.length < HEADER_BYTES + len) break;
			const payload = this.#buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
			this.#buf = this.#buf.subarray(HEADER_BYTES + len);
			if (type === FRAME_INPUT) {
				const data = payload.toString("utf8");
				if (this.#inputHandler) {
					this.#inputHandler(data);
				} else if (this.#pendingInputBytes < MAX_PENDING_INPUT_BYTES) {
					// ponytail: bounded so a client streaming pre-attach input can't
					// grow this unbounded; the real window is sub-second, so the cap
					// never bites in practice — it just caps a stuck/hostile init.
					this.#pendingInput.push(data);
					this.#pendingInputBytes += payload.length;
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
	}

	stop(): void {
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
	}

	// The client drains its own stdin before exiting; nothing to drain here.
	async drainInput(): Promise<void> {}

	write(data: string): void {
		// `writable`, not `!destroyed`: after the peer half-closes (FIN — e.g. a
		// liveness probe that connects and immediately ends) there is a window
		// where the socket is not yet destroyed but writing throws writeAfterFIN
		// ("socket has been ended by the other party") — an uncaught exception
		// that kills the whole shared daemon.
		if (this.#socket.writable) this.#socket.write(data);
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
