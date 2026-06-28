import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getConfigRootDir,
	getProjectDir,
	runWithDaemonSessionScope,
	setAgentDir,
	setProfile,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";

describe("setProfile / setAgentDir daemon-session guard", () => {
	let savedOmpProfile: string | undefined;
	let savedPiProfile: string | undefined;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		savedOmpProfile = process.env.OMP_PROFILE;
		savedPiProfile = process.env.PI_PROFILE;
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (savedOmpProfile !== undefined) process.env.OMP_PROFILE = savedOmpProfile;
		else delete process.env.OMP_PROFILE;
		if (savedPiProfile !== undefined) process.env.PI_PROFILE = savedPiProfile;
		else delete process.env.PI_PROFILE;
		if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		else delete process.env.PI_CODING_AGENT_DIR;
		__resetDirsFromEnvForTests();
	});

	it("throws when called inside a daemon session scope", async () => {
		await runWithDaemonSessionScope(async () => {
			expect(() => setProfile("work")).toThrow("not available in shared-daemon sessions");
			expect(() => setAgentDir("/custom/agent")).toThrow("not available in shared-daemon sessions");
		});
	});

	it("works normally outside any daemon session scope (standalone unchanged)", () => {
		setProfile("work");
		expect(getActiveProfile()).toBe("work");
		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
	});

	it("isolates concurrent sessions: both sessions blocked, global untouched", async () => {
		const rootBefore = getConfigRootDir();

		const [a, b] = await Promise.all([
			runWithDaemonSessionScope(async () => {
				try {
					setProfile("session-a-profile");
					return "should-not-reach";
				} catch (e) {
					return (e as Error).message;
				}
			}),
			runWithDaemonSessionScope(async () => {
				try {
					setProfile("session-b-profile");
					return "should-not-reach";
				} catch (e) {
					return (e as Error).message;
				}
			}),
		]);

		expect(a).toContain("not available in shared-daemon sessions");
		expect(b).toContain("not available in shared-daemon sessions");
		expect(getConfigRootDir()).toBe(rootBefore);
	});
});

// BLOCKER #2: an RPC/ACP daemon connection with no handshake cwd used to skip
// `runWithProjectDir` entirely, leaving the session inside `daemonSessionScope`
// but with no `cwdScope` store. `/move` then called `setProjectDir()`, which
// (pre-fix) fell straight through to the module-global `process.chdir()` —
// corrupting every other concurrent session's OS cwd. `setProjectDir` now
// refuses that fallback and throws instead, mirroring the `setProfile`/
// `setAgentDir` guard above.
describe("setProjectDir daemon-session guard (no cwdScope store)", () => {
	it("throws when called inside a daemon session scope with no runWithProjectDir wrapper", async () => {
		const cwdBefore = getProjectDir();

		await runWithDaemonSessionScope(async () => {
			expect(() => setProjectDir("/tmp/should-not-apply")).toThrow("daemon session");
		});

		// The module-global cwd is untouched — the corruption path never fired.
		expect(getProjectDir()).toBe(cwdBefore);
	});
});
