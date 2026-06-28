/**
 * Daemon host (M1 + Phase A): one long-lived process serving sessions over a
 * Unix domain socket. The heavy module graph + model catalog load ONCE here;
 * each client connection gets its own AgentSession. N thin clients therefore
 * cost ~one shared host + a few MB each instead of ~380MB apiece.
 *
 * Two per-connection branches:
 *  - RPC (default): unmodified runRpcMode with the socket swapped in for
 *    stdin/stdout — the original M1 protocol.
 *  - Interactive TUI (Phase A, gated by OMP_DAEMON_TUI=1): the real native
 *    TUI runs IN the daemon against a SocketTerminal bound to that
 *    connection's socket. Rendered bytes stream to the client raw; client
 *    keystrokes/resize come back framed. "Server-side render, dumb-pipe
 *    client" — the client never runs its own TUI, just relays bytes.
 *
 * Per-connection session isolation is enforced via AsyncLocalStorage: each
 * connection gets its own SessionScope with scoped capability context, theme,
 * settings, clipboard, and cwd. Four concurrent TUI sessions are supported.
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import { $env, logger, postmortem, runWithNotificationsSuppressed, VERSION } from "@oh-my-pi/pi-utils";
import { APP_NAME, runWithDaemonSessionScope, runWithProjectDir } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../../config/settings";
import { runInteractiveMode } from "../../main";
import { AgentRegistry } from "../../registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../sdk";
import { resolveResumableSession } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { runRpcMode } from "../rpc/rpc-mode";
import { runWithSessionScope, type SessionScope } from "./session-scope";
import { SocketTerminal } from "./socket-terminal";

const DEFAULT_SOCKET_DIR = "/tmp/omp-daemon";
const DEFAULT_DAEMON_LINGER_MS = 3000;
/** Written just before a graceful shutdown (SIGINT/SIGTERM) closes the socket, so a
 * reconnecting client can tell "daemon intentionally stopped" apart from "daemon crashed"
 * — both look identical at the socket level (the fd just closes either way). */
export function gracefulShutdownMarkerPath(socketPath: string): string {
	return `${socketPath}.graceful`;
}
/**
 * Written as the last bytes of a TUI connection that ends deliberately (the
 * session itself finished — user quit, /new, etc.), right before `socket.end()`.
 * A `\x00` prefix keeps it distinguishable from real render bytes (a NUL byte
 * essentially never appears in terminal output) so bench/tui-client.cjs can
 * recognize "this connection ending is not a crash" and skip its reconnect.
 * Duplicated as a literal in tui-client.cjs (no shared module between the two
 * runtimes) — keep both in sync if this ever changes.
 */
export const TUI_SESSION_END_SENTINEL = `\x00${JSON.stringify({ omp: "end" })}\n`;

let connSeq = 0;
/**
 * Fresh per-connection scope so concurrent sessions never share Settings
 * overrides, AgentRegistry, or auto-QA consent. `settings` is seeded from the
 * daemon's persisted Settings instance (shared by reference — the copy-on-write
 * overrides layer, not this reference, is what keeps sessions isolated) and
 * `disabledProviders` is seeded from that instance's persisted list, so a new
 * session starts with the user's actual disabled-provider state instead of an
 * empty Set (#BLOCKER-1).
 */
export function newSessionScope(settings: Settings | undefined): SessionScope {
	connSeq += 1;
	return {
		sessionId: `conn-${connSeq}`,
		agentRegistry: new AgentRegistry(),
		settingsOverrides: new WeakMap(),
		settings: settings ?? null,
		disabledProviders: new Set(settings?.get("disabledProviders") ?? []),
		autoQaConsentState: { handler: null, persistentSettings: null, cachedConsent: null, consentInFlight: null },
		mcpManager: undefined,
		asyncJobManager: undefined,
		activeRules: [],
		activeSkills: [],
		preferredSearchProvider: "auto",
		excludedSearchProviders: new Set(),
		preferredImageProvider: "auto",
		theme: undefined,
		currentThemeName: undefined,
		currentSymbolPresetOverride: undefined,
		currentColorBlindMode: false,
		autoDarkTheme: "dark",
		autoLightTheme: "light",
		autoDetectedTheme: false,
		terminalReportedAppearance: undefined,
		hostUriHandlers: new Map(),
	};
}

export interface DaemonHostOptions {
	socketPath?: string;
	sessionOptions: CreateAgentSessionOptions;
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

export interface DaemonIdleShutdownController {
	connectionOpened(): void;
	connectionClosed(): void;
	hasActiveClients(): boolean;
}

/**
 * SIGTERM is a deliberate `kill <daemon-pid>` and always wins. SIGINT/SIGHUP
 * can leak in from ONE client's terminal process group (Ctrl-C, terminal
 * window closed) — honoring them while other clients are attached would tear
 * down every session, so they defer to the idle-refcount path instead.
 */
export function shouldShutdownOnSignal(reason: postmortem.Reason, hasActiveClients: boolean): boolean {
	return reason === postmortem.Reason.SIGTERM || !hasActiveClients;
}

export function daemonLingerMs(): number {
	const raw = $env.OMP_DAEMON_LINGER_MS;
	if (raw === undefined) return DEFAULT_DAEMON_LINGER_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAEMON_LINGER_MS;
}

export function createDaemonIdleShutdown(lingerMs: number, shutdown: () => void): DaemonIdleShutdownController {
	let activeClients = 0;
	let sawClient = false;
	let shuttingDown = false;
	let shutdownTimer: NodeJS.Timeout | undefined;

	const clearShutdownTimer = () => {
		if (shutdownTimer) {
			clearTimeout(shutdownTimer);
			shutdownTimer = undefined;
		}
	};

	const armShutdown = () => {
		if (shuttingDown || shutdownTimer || !sawClient || activeClients !== 0) return;
		shutdownTimer = setTimeout(() => {
			shutdownTimer = undefined;
			if (shuttingDown || !sawClient || activeClients !== 0) return;
			shuttingDown = true;
			shutdown();
		}, lingerMs);
	};

	return {
		connectionOpened() {
			sawClient = true;
			activeClients += 1;
			clearShutdownTimer();
		},
		connectionClosed() {
			if (activeClients > 0) activeClients -= 1;
			armShutdown();
		},
		hasActiveClients() {
			return activeClients > 0;
		},
	};
}

export function defaultSocketPath(): string {
	const uid = process.getuid?.() ?? process.pid;
	return `${DEFAULT_SOCKET_DIR}/${APP_NAME}-${uid}.sock`;
}

/**
 * Determines whether a server error should be fatal. Before the server is listening,
 * errors (e.g. EADDRINUSE, bind failure) are fatal — the daemon can't operate.
 * After listening, runtime errors (e.g. EMFILE under fd churn) are logged but
 * non-fatal: the shared host must survive them to keep serving other sessions.
 */
export function isFatalServerError(hasListened: boolean): boolean {
	return !hasListened;
}

/**
 * Reopen a reconnecting client's prior session by id, so a respawned daemon
 * rehydrates the same on-disk (SQLite/jsonl) session instead of starting fresh.
 * Returns `undefined` (falls back to a new session) when the id can't be
 * resolved — e.g. a stale id from a session that was deleted meanwhile.
 */
async function reopenResumableSession(sessionId: string, cwd: string): Promise<SessionManager | undefined> {
	try {
		const match = await resolveResumableSession(sessionId, cwd);
		if (!match) {
			logger.warn("daemon: resume session not found", { sessionId });
			return undefined;
		}
		return await SessionManager.open(match.session.path);
	} catch (err) {
		logger.error("daemon: resume session failed", { sessionId, error: String(err) });
		return undefined;
	}
}

/** Bridge a socket's byte stream to the ReadableStream runRpcMode consumes. */
function socketToReadable(socket: net.Socket): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			socket.on("data", (chunk: Buffer) =>
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
			);
			const close = () => {
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			socket.on("end", close);
			socket.on("error", close);
		},
	});
}

export async function runDaemonHost(options: DaemonHostOptions): Promise<void> {
	// Enable daemon contain mode before any async work: uncaught exceptions and
	// unhandled rejections must not exit the shared host. SIGINT/SIGTERM route
	// through the daemon shutdown handler registered below.
	postmortem.contain();

	const socketPath = options.socketPath ?? defaultSocketPath();
	await fs.mkdir(DEFAULT_SOCKET_DIR, { recursive: true });
	await fs.unlink(socketPath).catch(() => {});
	// Clear a stale marker from a *previous* graceful shutdown so it can't be
	// mistaken for this boot's outcome if this instance later crashes.
	await fs.unlink(gracefulShutdownMarkerPath(socketPath)).catch(() => {});

	// Phase A branch selector: simplest gate that lets a TUI client connect
	// without adding a new --mode value or CLI flag (the daemon is already
	// entered via `--mode daemon`). Off by default so the M1 RPC protocol
	// stays the default daemon behavior; set OMP_DAEMON_TUI=1 to serve the
	// real interactive TUI over the socket instead.
	const serveTui = $env.OMP_DAEMON_TUI === "1";
	let idleShutdown: DaemonIdleShutdownController;

	const server = net.createServer(socket => {
		idleShutdown.connectionOpened();
		socket.once("close", () => {
			idleShutdown.connectionClosed();
			logger.info("daemon: client disconnected", { mode: serveTui ? "tui" : "rpc" });
		});
		logger.info("daemon: client connected", { mode: serveTui ? "tui" : "rpc" });

		if (serveTui) {
			// A per-connection socket error (probe disconnect, client crash) must
			// never bubble up: unhandled it re-emits on the server whose error
			// handler process.exit(1)s the shared daemon, killing every session.
			socket.on("error", err => logger.warn("daemon: tui socket error", { error: String(err) }));
			// Distinct from the RPC branch's onExit below: the TUI client tells a
			// deliberate end apart from a crash by watching for this sentinel (see
			// TUI_SESSION_END_SENTINEL doc) — the RPC protocol has no such client.
			const onExit = () => {
				if (socket.writable) socket.end(TUI_SESSION_END_SENTINEL);
			};
			const scope = newSessionScope(options.sessionOptions.settings);
			// Assigned once the client cwd is known; until then dispatch runs bare,
			// which only covers the pre-session CWD/RESIZE handshake frames.
			let sessionContext: (<T>(fn: () => T) => T) | undefined;
			const terminal = new SocketTerminal(socket, 80, 24, fn => (sessionContext ? sessionContext(fn) : fn()));
			scope.terminalOut = data => terminal.writeEscape(data);
			void (async () => {
				// Wait for the client's real cwd (bench/tui-client.cjs sends it right
				// after connect, before the resize frame) so tool resolution and the
				// ~73 getProjectDir() readers both see the client's directory instead
				// of the daemon's own. A client that never sends one (older client)
				// falls back to today's default, so behavior there is unchanged.
				// A RESUME frame arrives in the same initial burst (or not at all for a
				// fresh, non-reconnecting client) — wait for both together so a normal
				// connect pays no extra latency beyond today's cwd handshake.
				const [clientCwd, resumeSessionId] = await Promise.all([
					terminal.waitForCwd(500),
					terminal.waitForResumeSessionId(500),
				]);
				const cwd = clientCwd ?? options.sessionOptions.cwd ?? process.cwd();
				logger.info("daemon: tui session cwd", { sessionId: scope.sessionId, cwd });
				const runScoped = <T>(fn: () => T): T => runWithProjectDir(cwd, fn);
				const withScope = <T>(fn: () => T): T =>
					runWithNotificationsSuppressed(() =>
						runWithDaemonSessionScope(() => runScoped(() => runWithSessionScope(scope, fn))),
					);
				sessionContext = withScope;
				await withScope(async () => {
					try {
						const sessionManager = resumeSessionId
							? await reopenResumableSession(resumeSessionId, cwd)
							: undefined;
						const { session, setToolUIContext, lspServers, mcpManager, eventBus } = await options.createSession({
							...options.sessionOptions,
							cwd,
							hasUI: true,
							...(sessionManager ? { sessionManager } : {}),
						});
						// Handshake: tell the client which session it's attached to, before any
						// TUI render bytes hit the socket, so a later reconnect can send it back
						// as FRAME_RESUME. One `\n`-terminated JSON line, then the socket is the
						// usual raw byte stream (see socket-terminal.ts header doc).
						if (socket.writable) {
							socket.write(
								`${JSON.stringify({ omp: "session", sessionId: session.sessionManager.getSessionId() })}\n`,
							);
						}
						await runInteractiveMode({
							session,
							version: VERSION,
							notifs: [],
							versionCheckPromise: Promise.resolve(undefined),
							initialMessages: [],
							setExtensionUIContext: setToolUIContext,
							lspServers,
							mcpManager,
							resuming: false,
							forceSetupWizard: false,
							showStartupSplash: false,
							eventBus,
							terminal,
							onExit,
						});
					} catch (err) {
						logger.error("daemon: tui session error", { error: String(err) });
						if (!socket.destroyed) socket.destroy();
					}
				});
			})();
			return;
		}

		// Per-connection teardown — lets the shared host survive one client leaving.
		const onExit = () => {
			if (!socket.destroyed) socket.end();
		};

		// Always enter runWithProjectDir with a resolved cwd (mirroring the TUI
		// branch's fallback chain) — never skip scoping. Skipping it left this
		// connection with no cwdScope store, so a `/move` on this session hit
		// dirs.ts's unguarded process.chdir() fallback and corrupted every other
		// concurrent session's OS cwd (#BLOCKER-2).
		const cwd = options.sessionOptions.cwd ?? process.cwd();
		const runScoped = <T>(fn: () => T): T => runWithProjectDir(cwd, fn);
		const input = socketToReadable(socket);
		const output = (data: string) => {
			if (!socket.destroyed) socket.write(data);
		};

		const scope = newSessionScope(options.sessionOptions.settings);
		void runWithNotificationsSuppressed(() =>
			runWithDaemonSessionScope(() =>
				runScoped(() =>
					runWithSessionScope(scope, async () => {
						try {
							const { session } = await options.createSession({ ...options.sessionOptions, hasUI: false });
							await runRpcMode(session, undefined, undefined, { input, output, onExit });
						} catch (err) {
							logger.error("daemon: session error", { error: String(err) });
							if (!socket.destroyed) socket.destroy();
						}
					}),
				),
			),
		);
	});

	let hasListened = false;
	server.on("error", err => {
		if (isFatalServerError(hasListened)) {
			logger.error("daemon: server listen failure", { error: String(err) });
			process.exit(1);
		} else {
			logger.error("daemon: server runtime error", { error: String(err) });
		}
	});

	await new Promise<void>(resolve => {
		server.listen(socketPath, () => {
			hasListened = true;
			logger.info("daemon: listening", { path: socketPath });
			process.stdout.write(`${JSON.stringify({ type: "daemon_ready", socketPath })}\n`);
			resolve();
		});
	});

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("daemon: shutting down");
		server.close();
		// Drain the registered per-session cleanup callbacks (ssh, sshfs, lsp,
		// language kernels, otel export, session teardown) before exiting. In
		// contain mode signals route straight here instead of postmortem's own
		// exit path, so nothing else will ever run them. Bounded: a stalled
		// callback (hung ssh socket, unreachable otel endpoint) must not block
		// the daemon's exit forever.
		void (async () => {
			await Promise.race([postmortem.cleanup(), Bun.sleep(5_000)]).catch(() => {});
			// Marker written (and left behind) before the socket goes away: a reconnecting
			// client that finds the daemon unreachable checks for this file to tell "I shut
			// down on purpose" apart from "I crashed" — see gracefulShutdownMarkerPath().
			await fs.writeFile(gracefulShutdownMarkerPath(socketPath), "").catch(() => {});
			await fs.unlink(socketPath).catch(() => {});
			process.exit(0);
		})();
	};
	idleShutdown = createDaemonIdleShutdown(daemonLingerMs(), () => {
		logger.info("daemon: idle linger elapsed with no clients");
		shutdown();
	});
	// Register the daemon shutdown handler with postmortem. In contain mode,
	// SIGINT/SIGTERM invoke this callback instead of the built-in exit path,
	// preventing duplicate shutdown attempts and ensuring a single coherent path.
	postmortem.setDaemonShutdown(reason => {
		if (!shouldShutdownOnSignal(reason, idleShutdown.hasActiveClients())) {
			logger.warn("daemon: ignoring signal while clients are connected", { reason });
			return;
		}
		shutdown();
	});

	// Keep the host alive until signalled.
	await new Promise<never>(() => {});
}
