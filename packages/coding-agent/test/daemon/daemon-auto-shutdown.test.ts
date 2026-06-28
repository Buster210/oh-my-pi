import { afterEach, expect, test, vi } from "bun:test";
import {
	createDaemonIdleShutdown,
	isFatalServerError,
	shouldShutdownOnSignal,
} from "@oh-my-pi/pi-coding-agent/modes/daemon/daemon-host";
import { postmortem } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.useRealTimers();
});

test("daemon idle shutdown waits for linger before exiting", () => {
	vi.useFakeTimers();
	const shutdown = vi.fn();
	const controller = createDaemonIdleShutdown(1000, shutdown);

	controller.connectionOpened();
	controller.connectionClosed();

	vi.advanceTimersByTime(999);
	expect(shutdown).not.toHaveBeenCalled();

	vi.advanceTimersByTime(1);
	expect(shutdown).toHaveBeenCalledTimes(1);
});

test("daemon idle shutdown cancels when a client reconnects during linger", () => {
	vi.useFakeTimers();
	const shutdown = vi.fn();
	const controller = createDaemonIdleShutdown(1000, shutdown);

	controller.connectionOpened();
	controller.connectionClosed();

	vi.advanceTimersByTime(500);
	controller.connectionOpened();
	vi.advanceTimersByTime(500);
	expect(shutdown).not.toHaveBeenCalled();

	controller.connectionClosed();
	vi.advanceTimersByTime(1000);
	expect(shutdown).toHaveBeenCalledTimes(1);
});

test("daemon idle shutdown does not exit before the first client connects", () => {
	vi.useFakeTimers();
	const shutdown = vi.fn();
	createDaemonIdleShutdown(1000, shutdown);

	vi.advanceTimersByTime(10_000);
	expect(shutdown).not.toHaveBeenCalled();
});

test("hasActiveClients tracks the open/close refcount", () => {
	const controller = createDaemonIdleShutdown(1000, vi.fn());

	expect(controller.hasActiveClients()).toBe(false);
	controller.connectionOpened();
	controller.connectionOpened();
	expect(controller.hasActiveClients()).toBe(true);
	controller.connectionClosed();
	expect(controller.hasActiveClients()).toBe(true);
	controller.connectionClosed();
	expect(controller.hasActiveClients()).toBe(false);
});

test("terminal signals never shut down a daemon with clients attached", () => {
	// Regression: SIGINT/SIGHUP leaking from one client's terminal pgrp killed
	// the shared daemon (and thus every other instance). SIGTERM stays a
	// deliberate kill and always wins.
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGINT, true)).toBe(false);
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGHUP, true)).toBe(false);
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGTERM, true)).toBe(true);
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGINT, false)).toBe(true);
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGHUP, false)).toBe(true);
	expect(shouldShutdownOnSignal(postmortem.Reason.SIGTERM, false)).toBe(true);
});

test("server error before listen is fatal, after listen is non-fatal", () => {
	// Regression: runtime server errors (e.g. EMFILE under fd churn) killed the
	// whole shared host, dropping every live session. Errors during the listen
	// phase (bind failure, EADDRINUSE) are still fatal — the daemon cannot
	// operate without a listening socket.
	expect(isFatalServerError(false)).toBe(true); // pre-listen: fatal
	expect(isFatalServerError(true)).toBe(false); // post-listen: survive
});
