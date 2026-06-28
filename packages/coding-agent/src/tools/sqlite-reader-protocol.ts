export const SQLITE_READER_WORKER_ARG = "__omp_worker_sqlite_reader";

export interface SqliteWorkerCallOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type SqliteWorkerRequestBase =
	| { type: "listTables"; path: string; probeCap?: number }
	| { type: "getTableSchema"; path: string; table: string }
	| { type: "resolveTableRowLookup"; path: string; table: string }
	| {
			type: "queryRows";
			path: string;
			table: string;
			opts: { limit: number; offset: number; order?: string; where?: string };
	  }
	| {
			type: "getRowByKey";
			path: string;
			table: string;
			lookup: { column: string; type?: string };
			key: string;
	  }
	| { type: "getRowByRowId"; path: string; table: string; key: string }
	| { type: "executeReadQuery"; path: string; sql: string }
	| { type: "insertRow"; path: string; table: string; data: Record<string, unknown> }
	| {
			type: "updateRowByKey";
			path: string;
			table: string;
			lookup: { column: string; type?: string };
			key: string;
			data: Record<string, unknown>;
	  }
	| { type: "updateRowByRowId"; path: string; table: string; key: string; data: Record<string, unknown> }
	| {
			type: "deleteRowByKey";
			path: string;
			table: string;
			lookup: { column: string; type?: string };
			key: string;
	  }
	| { type: "deleteRowByRowId"; path: string; table: string; key: string };

export type SqliteWorkerRequest = SqliteWorkerRequestBase & { id: string };

export type SqliteWorkerResponse =
	| { type: "result"; id: string; result: unknown }
	| { type: "error"; id: string; error: string; code?: string };
