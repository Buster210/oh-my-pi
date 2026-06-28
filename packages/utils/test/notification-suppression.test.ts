import { describe, expect, it } from "bun:test";
import {
	isNotificationsSuppressedBySession,
	runWithNotificationsSuppressed,
} from "@oh-my-pi/pi-utils/notification-suppression";

describe("notification-suppression (per-session ALS)", () => {
	it("defaults to not suppressed when no session context is active", () => {
		expect(isNotificationsSuppressedBySession()).toBe(false);
	});

	it("suppresses only inside the wrapped call tree", () => {
		expect(isNotificationsSuppressedBySession()).toBe(false);
		const inside = runWithNotificationsSuppressed(() => isNotificationsSuppressedBySession());
		expect(inside).toBe(true);
		// leaks nothing back out
		expect(isNotificationsSuppressedBySession()).toBe(false);
	});

	it("survives async boundaries within the wrapped context", async () => {
		const seen = await runWithNotificationsSuppressed(async () => {
			await new Promise(r => setTimeout(r, 1));
			return isNotificationsSuppressedBySession();
		});
		expect(seen).toBe(true);
		expect(isNotificationsSuppressedBySession()).toBe(false);
	});

	it("keeps concurrent sessions isolated", async () => {
		// One suppressed session and one plain session interleaved: the plain
		// one must never observe the other's suppression (the whole point of
		// making this per-session for the shared-host daemon).
		const [suppressed, plain] = await Promise.all([
			runWithNotificationsSuppressed(async () => {
				await new Promise(r => setTimeout(r, 2));
				return isNotificationsSuppressedBySession();
			}),
			(async () => {
				await new Promise(r => setTimeout(r, 1));
				return isNotificationsSuppressedBySession();
			})(),
		]);
		expect(suppressed).toBe(true);
		expect(plain).toBe(false);
	});
});
