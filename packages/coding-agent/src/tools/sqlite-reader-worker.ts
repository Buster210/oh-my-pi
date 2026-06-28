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
