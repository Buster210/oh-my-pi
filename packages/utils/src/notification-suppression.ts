/**
 * Per-session notification suppression via AsyncLocalStorage.
 *
 * In a shared-host daemon, one RPC session must not silence desktop
 * notifications for every other concurrent session. This module provides an
 * ALS-based flag that `isNotificationSuppressed()` in `@oh-my-pi/pi-tui` checks
 * before falling back to the `PI_NOTIFICATIONS` env var.
 *
 * Today nobody wraps calls in `runWithNotificationsSuppressed`, so the ALS
 * store is always empty and the env-var path runs — identical to current
 * single-process behaviour.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const notificationSuppressionALS = new AsyncLocalStorage<{ suppressed: boolean }>();

/**
 * True when the current async context was wrapped by `runWithNotificationsSuppressed`.
 * Used by `isNotificationSuppressed()` in pi-tui as the first check, before the
 * env-var fallback.
 */
export function isNotificationsSuppressedBySession(): boolean {
	return notificationSuppressionALS.getStore()?.suppressed ?? false;
}

/**
 * Run `fn` with desktop notifications suppressed for the current async context.
 * The daemon will call this around each hosted RPC session so suppression is
 * scoped to that session's call tree.
 */
export function runWithNotificationsSuppressed<T>(fn: () => T): T {
	return notificationSuppressionALS.run({ suppressed: true }, fn);
}
