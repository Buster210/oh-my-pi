import { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import {
	deleteRowByKeySync,
	deleteRowByRowIdSync,
	executeReadQuerySync,
	getRowByKeySync,
	getRowByRowIdSync,
	getTableSchemaSync,
	insertRowSync,
	listTablesSync,
	queryRowsSync,
	resolveTableRowLookupSync,
	updateRowByKeySync,
	updateRowByRowIdSync,
} from "./sqlite-reader";
import type { SqliteWorkerRequest, SqliteWorkerResponse } from "./sqlite-reader-protocol";

if (!parentPort) throw new Error("sqlite-reader-worker: missing parentPort");

const inbox = consumeWorkerInbox();
const port = parentPort;

function openDatabase(path: string, writable: boolean): Database {
	const db = writable
		? new Database(path, { create: false, strict: true })
		: new Database(path, { readonly: true, strict: true });
	db.run("PRAGMA busy_timeout = 3000");
	if (writable) {
		// ponytail: WAL is enabled unconditionally — NOT gated to daemon mode —
		// deliberately. The root cause (#BLOCKER-8) is this reader/writer pool
		// dispatching reads and writes to two concurrent worker threads against
		// the same file (SQLITE_WORKER_POOL_MAX=2 in sqlite-reader.ts), which
		// applies to every mode, not just the shared-host daemon: a standalone
		// single-process session already fires concurrent read+write requests
		// (e.g. a background stats write racing a history read) onto this same
		// pool. Gating WAL to daemon-only would leave standalone sessions
		// exposed to the identical SQLITE_BUSY race this fix closes. WAL is the
		// standard, safe SQLite mode for concurrent multi-connection read+write
		// on one file and is transparent to any other reader (sqlite3 CLI,
		// another bun:sqlite handle) that opens the same path.
		// Trade-off, stated explicitly per review: this is NOT a no-op for
		// non-daemon usage — it changes the on-disk journal_mode (adds -wal/-shm
		// sidecar files, sticky until explicitly reset) for every mode that
		// writes through this worker. Accepted because the alternative (leaving
		// single-process mode with the same SQLITE_BUSY exposure) is worse.
		db.run("PRAGMA journal_mode = WAL");
	}
	return db;
}

function respond(message: SqliteWorkerResponse): void {
	port.postMessage(message);
}

function handleRequest(request: SqliteWorkerRequest): void {
	let db: Database | null = null;
	const ok = (result: unknown) => respond({ type: "result", id: request.id, result });
	try {
		switch (request.type) {
			case "listTables":
				db = openDatabase(request.path, false);
				ok(listTablesSync(db, { probeCap: request.probeCap }));
				return;
			case "getTableSchema":
				db = openDatabase(request.path, false);
				ok(getTableSchemaSync(db, request.table));
				return;
			case "resolveTableRowLookup":
				db = openDatabase(request.path, false);
				ok(resolveTableRowLookupSync(db, request.table));
				return;
			case "queryRows":
				db = openDatabase(request.path, false);
				ok(queryRowsSync(db, request.table, request.opts));
				return;
			case "getRowByKey":
				db = openDatabase(request.path, false);
				ok(getRowByKeySync(db, request.table, request.lookup, request.key));
				return;
			case "getRowByRowId":
				db = openDatabase(request.path, false);
				ok(getRowByRowIdSync(db, request.table, request.key));
				return;
			case "executeReadQuery":
				db = openDatabase(request.path, false);
				ok(executeReadQuerySync(db, request.sql));
				return;
			case "insertRow":
				db = openDatabase(request.path, true);
				ok(insertRowSync(db, request.table, request.data));
				return;
			case "updateRowByKey":
				db = openDatabase(request.path, true);
				ok(updateRowByKeySync(db, request.table, request.lookup, request.key, request.data));
				return;
			case "updateRowByRowId":
				db = openDatabase(request.path, true);
				ok(updateRowByRowIdSync(db, request.table, request.key, request.data));
				return;
			case "deleteRowByKey":
				db = openDatabase(request.path, true);
				ok(deleteRowByKeySync(db, request.table, request.lookup, request.key));
				return;
			case "deleteRowByRowId":
				db = openDatabase(request.path, true);
				ok(deleteRowByRowIdSync(db, request.table, request.key));
				return;
		}
	} catch (error) {
		respond({
			type: "error",
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
			code:
				error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
					? (error as Error & { code: string }).code
					: undefined,
		});
	} finally {
		db?.close();
	}
}

if (inbox) {
	inbox.bind(data => handleRequest(data as SqliteWorkerRequest));
} else {
	port.on("message", data => handleRequest(data as SqliteWorkerRequest));
}
