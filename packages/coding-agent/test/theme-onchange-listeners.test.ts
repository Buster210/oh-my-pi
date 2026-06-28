import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	getThemeByName,
	onThemeChange,
	setThemeInstance,
	type Theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Contract: onThemeChange() supports multiple concurrent listeners. In a
 * single-tenant CLI there's normally only one (interactive-mode.ts), but the
 * daemon runs many TUI sessions in one process, each registering its own via
 * runInteractiveMode — a single-slot callback (the pre-fix shape) meant only
 * the most-recently-registered session's TUI ever heard about a theme change.
 */
describe("theme onThemeChange — multiple listeners", () => {
	let dark: Theme;

	beforeAll(async () => {
		const t = await getThemeByName("dark");
		if (!t) throw new Error("Expected dark theme to exist");
		dark = t;
	});

	afterEach(() => {
		setThemeInstance(dark);
	});

	it("notifies every registered listener, not just the last one", () => {
		let calledA = 0;
		let calledB = 0;
		const unsubA = onThemeChange(() => calledA++);
		const unsubB = onThemeChange(() => calledB++);

		setThemeInstance(dark);

		expect(calledA).toBe(1);
		expect(calledB).toBe(1);

		unsubA();
		unsubB();
	});

	it("unsubscribing one listener leaves the others notified", () => {
		let calledA = 0;
		let calledB = 0;
		const unsubA = onThemeChange(() => calledA++);
		const unsubB = onThemeChange(() => calledB++);

		unsubA();
		setThemeInstance(dark);

		expect(calledA).toBe(0);
		expect(calledB).toBe(1);

		unsubB();
	});
});
