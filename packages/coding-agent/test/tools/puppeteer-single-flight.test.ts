/** Regression guard: concurrent first-load calls must dedup to a single Bun.write + import. */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { loadPuppeteer, resetPuppeteerModuleForTests } from "../../src/tools/browser/launch";

describe("puppeteer first-load single-flight", () => {
	afterEach(() => {
		resetPuppeteerModuleForTests();
	});

	it("dedups concurrent first-load calls to a single load attempt", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0 as never);
		try {
			// import("puppeteer-core") rejects in the test env — expected; we assert
			// dedup of the load, not the import succeeding.
			await Promise.allSettled([loadPuppeteer(), loadPuppeteer()]);
			expect(writeSpy).toHaveBeenCalledTimes(1);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("clears the in-flight guard after failure so a later call retries", async () => {
		let calls = 0;
		const writeSpy = spyOn(Bun, "write").mockImplementation((() => {
			calls++;
			return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(0);
		}) as never);
		try {
			await loadPuppeteer().catch(() => null); // attempt 1: write rejects → load fails
			await loadPuppeteer().catch(() => null); // guard cleared → attempt 2 runs write again
			// Without the finally-clear, attempt 2 would return the cached rejected
			// promise and never call write again (count would stay 1).
			expect(writeSpy).toHaveBeenCalledTimes(2);
		} finally {
			writeSpy.mockRestore();
		}
	});
});
