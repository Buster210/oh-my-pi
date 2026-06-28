import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/tools/renderers";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	__sqliteWorkerPoolForTests,
	executeReadQuery,
	insertRow,
	listTables,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	renderTable,
	renderTableList,
} from "@oh-my-pi/pi-coding-agent/tools/sqlite-reader";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
};

type SessionLike = ConstructorParameters<typeof ReadTool>[0];

function getText(result: ToolTextResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<SessionLike> = {}): SessionLike {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as SessionLike;
}

/**
 * Builds the fixture database once in memory and serializes it to bytes. Tests
 * stamp these bytes onto disk with a single `writeFile` (one fsync) instead of
 * re-running the table creation and ~13 autocommit inserts (≈14 fsyncs) per
 * test — the original per-test on-disk build dominated the suite's wall time.
 */
function buildFixtureBytes(): Uint8Array {
	const db = new Database(":memory:");
	try {
		db.run(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				email TEXT NOT NULL,
				status TEXT NOT NULL,
				created INTEGER NOT NULL
			);
			CREATE TABLE slugs (
				slug TEXT PRIMARY KEY,
				title TEXT NOT NULL
			);
			CREATE TABLE notes (
				body TEXT NOT NULL
			);
			CREATE TABLE composite (
				team_id INTEGER NOT NULL,
				user_id INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (team_id, user_id)
			);
			CREATE TABLE wide_rows (
				id INTEGER PRIMARY KEY,
				payload TEXT NOT NULL
			);
		`);

		const insertUser = db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)");
		const insertSlug = db.prepare("INSERT INTO slugs (slug, title) VALUES (?, ?)");
		const insertNote = db.prepare("INSERT INTO notes (body) VALUES (?)");
		const seed = db.transaction(() => {
			insertUser.run("Alice", "alice@example.com", "active", 1);
			insertUser.run("Bob", "bob@example.com", "inactive", 2);
			insertUser.run("Carol", "carol@example.com", "active", 3);
			insertUser.run("Dave", "dave@example.com", "inactive", 4);
			insertUser.run("Eve", "eve@example.com", "active", 5);
			insertUser.run("Frank", "frank@example.com", "active", 6);

			insertSlug.run("welcome", "Welcome");
			insertSlug.run("about", "About");

			insertNote.run("First note");
			insertNote.run("Second note");
			insertNote.run("Third; note");

			db.prepare("INSERT INTO composite (team_id, user_id, value) VALUES (?, ?, ?)").run(1, 2, "pair");
			db.prepare("INSERT INTO wide_rows (id, payload) VALUES (?, ?)").run(1, "x".repeat(320));
		});
		seed();

		return db.serialize();
	} finally {
		db.close();
	}
}

function readUserEmail(dbPath: string, id: number): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(id);
		return row?.email ?? null;
	} finally {
		db.close();
	}
}

function readUserCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM users").get()?.count ?? 0;
	} finally {
		db.close();
	}
}

function readUserByEmail(dbPath: string, email: string): { name: string; email: string } | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare<{ name: string; email: string }, [string]>("SELECT name, email FROM users WHERE email = ?")
			.get(email);
	} finally {
		db.close();
	}
}

describe("SQLite tool support", () => {
	let tmpDir: string;
	let sqlitePath: string;
	let sqliteDbPath: string;
	let invalidDbPath: string;
	let fixtureBytes: Uint8Array;
	let readTool: ReadTool;
	let writeTool: WriteTool;
	let originalEditVariant: string | undefined;

	// The shared fixture is only ever read by most tests; the few tests that
	// mutate a database stamp their own fresh copy via `stampFreshDb`, so the
	// shared file stays pristine and can be created exactly once.
	async function stampFreshDb(name: string): Promise<string> {
		const dbPath = path.join(tmpDir, name);
		await fs.writeFile(dbPath, fixtureBytes);
		return dbPath;
	}

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-tool-test-"));
		sqlitePath = path.join(tmpDir, "app.sqlite");
		sqliteDbPath = path.join(tmpDir, "app.db");
		invalidDbPath = path.join(tmpDir, "thumbs.db");
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		fixtureBytes = buildFixtureBytes();
		await fs.writeFile(sqlitePath, fixtureBytes);
		await fs.writeFile(sqliteDbPath, fixtureBytes);
		await fs.writeFile(invalidDbPath, "not sqlite\nstill text\n");

		const session = createSession(tmpDir);
		readTool = new ReadTool(session);
		writeTool = new WriteTool(session);
	});

	afterAll(async () => {
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		await removeWithRetries(tmpDir);
	});

	it("parses SQLite path candidates at the extension boundary", () => {
		expect(parseSqlitePathCandidates("data/app.db:users?limit=5")).toEqual([
			{
				sqlitePath: "data/app.db",
				subPath: "users",
				queryString: "limit=5",
			},
		]);
		expect(parseSqlitePathCandidates("data/app.sqlite")).toEqual([
			{
				sqlitePath: "data/app.sqlite",
				subPath: "",
				queryString: "",
			},
		]);
	});

	it("parses SQLite selectors for row, query, and raw modes", () => {
		expect(parseSqliteSelector("users:42", "")).toEqual({ kind: "row", table: "users", key: "42" });
		expect(parseSqliteSelector("users", "limit=2&offset=3&order=created:desc")).toEqual({
			kind: "query",
			table: "users",
			limit: 2,
			offset: 3,
			order: "created:desc",
			where: undefined,
		});
		expect(parseSqliteSelector("", "q=SELECT+1")).toEqual({ kind: "raw", sql: "SELECT 1" });
	});

	it("lists tables for a .sqlite database and excludes sqlite internal tables", async () => {
		const result = await readTool.execute("sqlite-list", { path: sqlitePath });
		const text = getText(result);

		expect(text).toContain("users (6 rows)");
		expect(text).toContain("slugs (2 rows)");
		expect(text).toContain("notes (3 rows)");
		expect(text).not.toContain("sqlite_sequence");
	});

	it("lists tables for a .db database when the magic bytes match SQLite", async () => {
		const result = await readTool.execute("sqlite-db-list", { path: sqliteDbPath });
		expect(getText(result)).toContain("users (6 rows)");
	});

	it("falls through to plain file reading for non-SQLite .db files", async () => {
		const result = await readTool.execute("sqlite-invalid-db", { path: invalidDbPath });
		expect(getText(result)).toContain("not sqlite");
	});

	it("shows table schema and sample rows", async () => {
		const result = await readTool.execute("sqlite-schema", { path: `${sqlitePath}:users` });
		const text = getText(result);

		expect(text).toContain("CREATE TABLE users");
		expect(text).toContain("Sample rows:");
		expect(text).toContain("Alice");
	});

	it("returns a row by integer primary key", async () => {
		const result = await readTool.execute("sqlite-row-int", { path: `${sqlitePath}:users:2` });
		const text = getText(result);

		expect(text).toContain("id: 2");
		expect(text).toContain("name: Bob");
		expect(text).toContain("email: bob@example.com");
	});

	it("returns a row by text primary key", async () => {
		const result = await readTool.execute("sqlite-row-text", { path: `${sqlitePath}:slugs:welcome` });
		const text = getText(result);

		expect(text).toContain("slug: welcome");
		expect(text).toContain("title: Welcome");
	});

	it("falls back to ROWID lookups for tables without a declared primary key", async () => {
		const result = await readTool.execute("sqlite-row-rowid", { path: `${sqlitePath}:notes:1` });
		expect(getText(result)).toContain("body: First note");
	});

	it("errors on composite primary key row lookups", async () => {
		await expect(readTool.execute("sqlite-row-composite", { path: `${sqlitePath}:composite:1` })).rejects.toThrow(
			/composite primary key/i,
		);
	});

	it("supports pagination and includes a continuation hint", async () => {
		const result = await readTool.execute("sqlite-page", { path: `${sqlitePath}:users?limit=2&offset=1` });
		const text = getText(result);

		expect(text).toContain("Bob");
		expect(text).toContain("Carol");
		expect(text).not.toContain("Alice");
		expect(text).toContain("append :users?limit=2&offset=3 to the database path to continue");
	});

	it("supports where and order via the path selector", async () => {
		const result = await readTool.execute("sqlite-sel-query", {
			path: `${sqlitePath}:users?where=status='active'&order=created:desc&limit=2`,
		});
		const text = getText(result);

		expect(text).toContain("Frank");
		expect(text).toContain("Eve");
		expect(text).not.toContain("Bob");
	});

	it("rejects where= clauses that try to bypass pagination", () => {
		expect(() => parseSqliteSelector("users", "where=1=1 LIMIT 1000000 --&limit=2&offset=0")).toThrow(
			/comments or statement terminators/i,
		);
		expect(() => parseSqliteSelector("users", "where=status='active' LIMIT 1")).toThrow(/LIMIT\/OFFSET\/UNION/i);
		expect(() => parseSqliteSelector("users", "where=1=1; DROP TABLE users")).toThrow(
			/comments or statement terminators/i,
		);
	});

	it("allows semicolons inside quoted SQLite where string literals", async () => {
		const result = await readTool.execute("sqlite-sel-semicolon-literal", {
			path: `${sqlitePath}:notes?where=body LIKE '%;%'&limit=5`,
		});
		const text = getText(result);

		expect(text).toContain("Third; note");
	});

	it("rejects SQLite where clauses that try to override pagination control syntax", async () => {
		await expect(
			readTool.execute("sqlite-where-pagination-bypass", {
				path: `${sqlitePath}:users?where=1=1 LIMIT 1000000 --&limit=2&offset=0`,
			}),
		).rejects.toThrow(/comments or statement terminators/i);
	});

	it("rejects mutating raw queries on the readonly connection", async () => {
		await expect(
			readTool.execute("sqlite-raw-write", {
				path: `${sqlitePath}?q=INSERT+INTO+users+(name,email,status,created)+VALUES+('X','x@example.com','active',7)`,
			}),
		).rejects.toThrow(/readonly/i);
	});

	it("caps raw ?q= queries at the row limit and surfaces a LIMIT hint", async () => {
		// Dedicated database: this is the only test that needs >1000 rows, and it
		// must not pollute the shared fixture. A single transaction = one commit.
		const capDbPath = path.join(tmpDir, "rawcap.sqlite");
		const db = new Database(capDbPath);
		try {
			db.run("CREATE TABLE big (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			const insert = db.prepare("INSERT INTO big (value) VALUES (?)");
			const fill = db.transaction(() => {
				for (let i = 1; i <= 1200; i++) {
					insert.run(`val_${i}_end`);
				}
			});
			fill();
		} finally {
			db.close();
		}

		const result = await readTool.execute("sqlite-raw-row-cap", { path: `${capDbPath}?q=SELECT * FROM big` });
		const text = getText(result);

		expect(text).toContain("val_1000_end");
		expect(text).not.toContain("val_1001_end");
		expect(text).toContain("Output capped at 1000 rows");
	});

	it("rejects table names that do not exist instead of interpolating them", async () => {
		await expect(
			readTool.execute("sqlite-injection-table", { path: `${sqlitePath}:users;DROP TABLE users;` }),
		).rejects.toThrow(/not found/i);
	});

	it("truncates wide rows to the configured table width", () => {
		const rendered = renderTable(["id", "payload"], [{ id: 1, payload: "x".repeat(320) }], {
			totalCount: 1,
			offset: 0,
			limit: 20,
			table: "wide_rows",
			dbPath: sqlitePath,
		});

		for (const line of rendered.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("falls back to vertical row blocks when the column count exceeds the horizontal budget (#3107)", () => {
		const columns = ["_id", ...Array.from({ length: 32 }, (_, i) => `col_${i + 1}`)];
		const row: Record<string, unknown> = { _id: 7 };
		for (let i = 1; i <= 32; i++) row[`col_${i}`] = `value_${i}`;

		const rendered = renderTable(columns, [row], {
			totalCount: 1,
			offset: 0,
			limit: 20,
			table: "wide_columns",
			dbPath: sqlitePath,
		});

		// Horizontal layout would shrink every column to width 1 and chop the
		// right edge — i.e., the line would look like `| … | … | … | …` (>=2
		// ellipses chained by ` | `). Vertical mode renders one `col: value`
		// per line, so that signature must NOT be present.
		expect(rendered).not.toMatch(/…(?: \| …){2,}/);

		// Each declared column must appear with its real value on its own line.
		expect(rendered).toContain("── Row 1 ──");
		expect(rendered).toContain("_id   : 7");
		expect(rendered).toContain("col_1 : value_1");
		expect(rendered).toContain("col_32: value_32");

		for (const line of rendered.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("inserts rows through the write tool with JSON5 content", async () => {
		const dbPath = await stampFreshDb("write-insert.sqlite");
		await writeTool.execute("sqlite-write-insert", {
			path: `${dbPath}:users`,
			content: "{ name: 'Grace', email: 'grace@example.com', status: 'active', created: 7 }",
		});

		expect(readUserByEmail(dbPath, "grace@example.com")).toEqual({
			name: "Grace",
			email: "grace@example.com",
		});
	});

	it("updates rows through the write tool by primary key", async () => {
		const dbPath = await stampFreshDb("write-update.sqlite");
		await writeTool.execute("sqlite-write-update", {
			path: `${dbPath}:users:2`,
			content: "{ email: 'bob+new@example.com' }",
		});

		expect(readUserEmail(dbPath, 2)).toBe("bob+new@example.com");
	});

	it("deletes rows through the write tool with empty content", async () => {
		const dbPath = await stampFreshDb("write-delete.sqlite");
		await writeTool.execute("sqlite-write-delete", {
			path: `${dbPath}:users:2`,
			content: "   ",
		});

		expect(readUserCount(dbPath)).toBe(5);
		expect(readUserEmail(dbPath, 2)).toBeNull();
	});

	it("enforces plan mode for SQLite writes", async () => {
		const planSession = createSession(tmpDir, {
			getPlanModeState: () => ({
				enabled: true,
				planFilePath: path.join(tmpDir, "plan.md"),
			}),
		});
		const planWriteTool = new WriteTool(planSession);

		await expect(
			planWriteTool.execute("sqlite-plan-mode", {
				path: `${sqlitePath}:users:1`,
				content: "{ email: 'blocked@example.com' }",
			}),
		).rejects.toThrow(/Plan mode/i);
	});

	it("rejects writes to non-existent tables", async () => {
		await expect(
			writeTool.execute("sqlite-write-missing-table", {
				path: `${sqlitePath}:missing`,
				content: "{ value: 1 }",
			}),
		).rejects.toThrow(/not found/i);
	});

	it("rejects writes to non-existent databases", async () => {
		await expect(
			writeTool.execute("sqlite-write-missing-db", {
				path: path.join(tmpDir, "missing.sqlite:users"),
				content: "{ name: 'Nope' }",
			}),
		).rejects.toThrow(/not found/i);
	});

	it("rejects unknown columns in write content", async () => {
		await expect(
			writeTool.execute("sqlite-write-bad-column", {
				path: `${sqlitePath}:users`,
				content: "{ bogus: 1 }",
			}),
		).rejects.toThrow(/no column named 'bogus'/i);
	});

	// BLOCKER #8: reads and writes against the same file are dispatched to a
	// 2-slot worker-thread pool (SQLITE_WORKER_POOL_MAX in sqlite-reader.ts) —
	// a read landing on one worker thread while a write is in-flight on the
	// other, against the same on-disk file, is exactly the condition that
	// throws SQLITE_BUSY without WAL. Fires 20 concurrent read+write pairs
	// against a fresh copy so at least one genuinely overlaps in the pool.
	it("BLOCKER #8: concurrent read + write against the same DB does not throw SQLITE_BUSY", async () => {
		const dbPath = await stampFreshDb("write-concurrent.sqlite");

		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			ops.push(executeReadQuery(dbPath, "SELECT COUNT(*) AS count FROM users"));
			ops.push(insertRow(dbPath, "notes", { body: `concurrent note ${i}` }));
		}

		await expect(Promise.all(ops)).resolves.toBeDefined();

		const finalCount = await executeReadQuery(dbPath, "SELECT COUNT(*) AS count FROM notes");
		expect(finalCount.rows[0]?.count).toBe(3 + 20);
	});
});

describe("SQLite table listing row counts", () => {
	let countsTmpDir: string;
	let basePath: string;
	let analyzedPath: string;

	async function buildCountsDbFile(name: string, analyze: boolean): Promise<string> {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
			db.run("CREATE TABLE small (id INTEGER PRIMARY KEY)");
			const bigStmt = db.prepare("INSERT INTO big (v) VALUES (?)");
			for (let i = 0; i < 10; i++) bigStmt.run("x");
			const smallStmt = db.prepare("INSERT INTO small DEFAULT VALUES");
			for (let i = 0; i < 2; i++) smallStmt.run();
			if (analyze) db.run("ANALYZE");
			const dbPath = path.join(countsTmpDir, name);
			await fs.writeFile(dbPath, db.serialize());
			return dbPath;
		} finally {
			db.close();
		}
	}

	beforeAll(async () => {
		countsTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-counts-"));
		basePath = await buildCountsDbFile("counts-base.sqlite", false);
		analyzedPath = await buildCountsDbFile("counts-analyzed.sqlite", true);
	});

	afterAll(async () => {
		await removeWithRetries(countsTmpDir);
	});

	it("counts small tables exactly", async () => {
		const rendered = renderTableList(await listTables(basePath, { probeCap: 100 }));
		expect(rendered).toContain("big (10 rows)");
		expect(rendered).toContain("small (2 rows)");
	});

	it("reports the planner estimate for tables larger than the probe cap", async () => {
		// probeCap=5: big (estimate 10) exceeds it and is reported as an estimate
		// without scanning; small (estimate 2) is counted exactly.
		const rendered = renderTableList(await listTables(analyzedPath, { probeCap: 5 }));
		expect(rendered).toContain("big (~10 rows)");
		expect(rendered).toContain("small (2 rows)");
	});

	it("reports a lower bound when an unanalyzed table exceeds the probe cap", async () => {
		// No ANALYZE, so no estimate exists; the bounded probe stops at the cap
		// and reports a lower bound instead of scanning the whole table.
		const rendered = renderTableList(await listTables(basePath, { probeCap: 3 }));
		expect(rendered).toContain("big (3+ rows)");
		expect(rendered).toContain("small (2 rows)");
	});

	it("times out a runaway raw query and keeps serving later sqlite calls", async () => {
		const slowSql = `
			WITH RECURSIVE spin(n) AS (
				SELECT 1
				UNION ALL
				SELECT n + 1 FROM spin WHERE n < 100000000
			)
			SELECT COUNT(*) AS count FROM spin
		`;

		await expect(executeReadQuery(basePath, slowSql, { timeoutMs: 1 })).rejects.toThrow(/timed out/i);
		expect(renderTableList(await listTables(basePath, { probeCap: 100 }))).toContain("big (10 rows)");
	});
});
describe("SQLite worker-pool robustness", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-pool-"));
		dbPath = path.join(tmpDir, "pool-test.sqlite");
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
			const stmt = db.prepare("INSERT INTO t (v) VALUES (?)");
			for (let i = 0; i < 5; i++) stmt.run(`row-${i}`);
			await fs.writeFile(dbPath, db.serialize());
		} finally {
			db.close();
		}
	});

	afterAll(async () => {
		await removeWithRetries(tmpDir);
	});

	it("Fix A (timeout path): a timed-out request recycles its slot; later requests succeed", async () => {
		await expect(listTables(dbPath)).resolves.toBeDefined();

		// Timeout recycle path — distinct from the close/messageerror handlers below.
		const slowSql = `
			WITH RECURSIVE spin(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM spin WHERE n < 100000000
			)
			SELECT COUNT(*) AS count FROM spin
		`;
		await expect(executeReadQuery(dbPath, slowSql, { timeoutMs: 1 })).rejects.toThrow(/timed out/i);

		const tables = await listTables(dbPath);
		expect(tables.length).toBeGreaterThan(0);
	});

	it("Fix A (close path): a worker 'close' event recycles the slot and rejects the in-flight request", async () => {
		await expect(listTables(dbPath)).resolves.toBeDefined();
		const slot = __sqliteWorkerPoolForTests[0];
		expect(slot).toBeDefined();

		// Slow query keeps the slot busy; long timeout prevents the timeout path from firing first.
		const slowSql = `
			WITH RECURSIVE spin(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM spin WHERE n < 100000000
			)
			SELECT COUNT(*) AS count FROM spin
		`;
		const inFlight = executeReadQuery(dbPath, slowSql, { timeoutMs: 60_000 });

		// Simulate Bun's worker "close" event — the codepath timeout/abort tests never touch.
		slot.worker.dispatchEvent(new Event("close"));

		await expect(inFlight).rejects.toThrow(/closed unexpectedly/i);
		expect(__sqliteWorkerPoolForTests.includes(slot)).toBe(false);

		const tables = await listTables(dbPath);
		expect(tables.length).toBeGreaterThan(0);
	});

	it("Fix B: aborting a queued read rejects promptly and frees the slot", async () => {
		await expect(listTables(dbPath)).resolves.toBeDefined();

		const controller = new AbortController();
		controller.abort();

		await expect(executeReadQuery(dbPath, "SELECT 1 AS n", { signal: controller.signal })).rejects.toThrow(
			/aborted/i,
		);

		// Verify the slot is still usable.
		const tables = await listTables(dbPath);
		expect(tables.length).toBeGreaterThan(0);
	});

	it("Fix B: aborting a running read terminates worker and frees the slot", async () => {
		// Warm the pool.
		await expect(listTables(dbPath)).resolves.toBeDefined();

		const controller = new AbortController();
		const slowSql = `
			WITH RECURSIVE spin(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM spin WHERE n < 100000000
			)
			SELECT COUNT(*) AS count FROM spin
		`;
		// Start a slow query. Since the pool is warm, it will be dispatched
		// immediately (state = "running") rather than queued.
		const slowPromise = executeReadQuery(dbPath, slowSql, { signal: controller.signal, timeoutMs: 60_000 });
		// Abort without waiting — the query is dispatched synchronously.
		controller.abort();

		await expect(slowPromise).rejects.toThrow(/aborted/i);

		// Verify the slot is recycled: a new request should succeed.
		const tables = await listTables(dbPath);
		expect(tables.length).toBeGreaterThan(0);
	});
});
