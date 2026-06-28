import { describe, expect, it } from "bun:test";
import { getProjectDir, getWorktreesDir, runWithProjectDir, setWorktreesDir } from "@oh-my-pi/pi-utils/dirs";

describe("getProjectDir (per-session ALS scope)", () => {
	it("returns the module-global cwd outside any scope (standalone unchanged)", () => {
		const outside = getProjectDir();
		expect(outside).toBe(getProjectDir());
	});

	it("returns the scoped cwd inside runWithProjectDir, without touching the global", () => {
		const before = getProjectDir();
		const inside = runWithProjectDir("/tmp", () => getProjectDir());
		expect(inside).toBe("/tmp");
		// leaks nothing back out — the module global is untouched
		expect(getProjectDir()).toBe(before);
	});

	it("survives async boundaries within the wrapped context", async () => {
		const seen = await runWithProjectDir("/tmp", async () => {
			await new Promise(r => setTimeout(r, 1));
			return getProjectDir();
		});
		expect(seen).toBe("/tmp");
	});

	it("keeps concurrent sessions isolated", async () => {
		// Two daemon-style sessions with different cwds interleaved: one must
		// never observe the other's scoped cwd (the whole point of scoping
		// getProjectDir() for the shared-host daemon).
		const [a, b] = await Promise.all([
			runWithProjectDir("/tmp/session-a", async () => {
				await new Promise(r => setTimeout(r, 2));
				return getProjectDir();
			}),
			runWithProjectDir("/tmp/session-b", async () => {
				await new Promise(r => setTimeout(r, 1));
				return getProjectDir();
			}),
		]);
		expect(a).toBe("/tmp/session-a");
		expect(b).toBe("/tmp/session-b");
	});
});

describe("getWorktreesDir/setWorktreesDir (rides the same ALS scope)", () => {
	it("keeps concurrent sessions' worktree.base isolated, and the outside global untouched", async () => {
		const before = getWorktreesDir();

		const [a, b] = await Promise.all([
			runWithProjectDir("/tmp/session-a", async () => {
				setWorktreesDir("/tmp/wt-a");
				await new Promise(r => setTimeout(r, 2));
				return getWorktreesDir();
			}),
			runWithProjectDir("/tmp/session-b", async () => {
				setWorktreesDir("/tmp/wt-b");
				await new Promise(r => setTimeout(r, 1));
				return getWorktreesDir();
			}),
		]);

		expect(a).toBe("/tmp/wt-a");
		expect(b).toBe("/tmp/wt-b");
		// Neither scoped write leaked to the module global.
		expect(getWorktreesDir()).toBe(before);
	});
});
