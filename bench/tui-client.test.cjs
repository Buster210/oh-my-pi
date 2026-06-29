// Sanity coverage for the reconnect decision logic in tui-client.cjs — the parts
// that were wrong in review: exit-vs-reconnect ordering, marker read-without-
// consume, and stale-lock takeover. Run: node --test bench/tui-client.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const {
	decideAfterClose,
	sentinelSplit,
	isGracefulShutdown,
	isLockStale,
	gracefulMarkerPath,
	lockPidFile,
	END_SENTINEL_BYTES,
} = require("./tui-client.cjs");

function tmpPath(name) {
	return path.join(os.tmpdir(), `tui-client-test-${process.pid}-${Math.floor(performance.now() * 1000)}-${name}`);
}

test("decideAfterClose: end sentinel means deliberate exit, no reconnect", () => {
	const socketPath = tmpPath("sock-a");
	assert.equal(decideAfterClose({ sawEndSentinel: true, socketPath }), "exit");
});

test("decideAfterClose: graceful marker present means deliberate exit, no reconnect", () => {
	const socketPath = tmpPath("sock-b");
	fs.writeFileSync(gracefulMarkerPath(socketPath), "");
	assert.equal(decideAfterClose({ sawEndSentinel: false, socketPath }), "exit");
	fs.unlinkSync(gracefulMarkerPath(socketPath));
});

test("decideAfterClose: no sentinel, no marker => reconnect (never a pingDaemon-alive shortcut)", () => {
	// This is the regression the review caught: an unexpected drop must attempt
	// reattach+resume even if the daemon already looks reachable again (a sibling
	// client's respawn racing this client's own crash detection is not proof this
	// session ended on purpose).
	const socketPath = tmpPath("sock-c");
	assert.equal(decideAfterClose({ sawEndSentinel: false, socketPath }), "reconnect");
});

test("graceful marker: read-without-consume — two independent readers both see it", () => {
	const socketPath = tmpPath("sock-d");
	fs.writeFileSync(gracefulMarkerPath(socketPath), "");
	assert.equal(isGracefulShutdown(socketPath), true, "reader 1");
	assert.equal(isGracefulShutdown(socketPath), true, "reader 2 — must still see it, not ENOENT");
	assert.equal(fs.existsSync(gracefulMarkerPath(socketPath)), true, "marker itself untouched by reads");
	fs.unlinkSync(gracefulMarkerPath(socketPath));
});

test("graceful marker: absent means crash, not graceful", () => {
	const socketPath = tmpPath("sock-e");
	assert.equal(isGracefulShutdown(socketPath), false);
});

test("lock staleness: fresh lock held by a live pid is not stale", () => {
	const lockDir = tmpPath("lock-live");
	fs.mkdirSync(lockDir);
	fs.writeFileSync(lockPidFile(lockDir), String(process.pid)); // this test process — definitely alive
	assert.equal(isLockStale(lockDir), false);
	fs.rmSync(lockDir, { recursive: true, force: true });
});

test("lock staleness: dead holder pid => stale, safe to steal", () => {
	const lockDir = tmpPath("lock-dead");
	fs.mkdirSync(lockDir);
	// A pid essentially guaranteed not to be running (PID 1 space collision aside,
	// a process this large won't exist in a test sandbox).
	fs.writeFileSync(lockPidFile(lockDir), "999999");
	assert.equal(isLockStale(lockDir), true);
	fs.rmSync(lockDir, { recursive: true, force: true });
});

test("lock staleness: no pid file, fresh mkdir => not stale (mid-write race)", () => {
	const lockDir = tmpPath("lock-fresh-nopid");
	fs.mkdirSync(lockDir);
	assert.equal(isLockStale(lockDir), false);
	fs.rmSync(lockDir, { recursive: true, force: true });
});

test("sentinelSplit: plain render bytes pass through, nothing held", () => {
	const { out, held } = sentinelSplit(Buffer.alloc(0), Buffer.from("hello world"));
	assert.equal(out.toString(), "hello world");
	assert.equal(held.length, 0);
});

test("sentinelSplit: full sentinel is held back, never printed", () => {
	const { out, held } = sentinelSplit(Buffer.alloc(0), Buffer.concat([Buffer.from("render"), END_SENTINEL_BYTES]));
	assert.equal(out.toString(), "render");
	assert.ok(held.equals(END_SENTINEL_BYTES));
});

test("sentinelSplit: sentinel split across two chunks is reassembled in held", () => {
	const cut = 4;
	const first = sentinelSplit(Buffer.alloc(0), END_SENTINEL_BYTES.subarray(0, cut));
	assert.equal(first.out.length, 0, "prefix must be withheld");
	const second = sentinelSplit(first.held, END_SENTINEL_BYTES.subarray(cut));
	assert.equal(second.out.length, 0);
	assert.ok(second.held.equals(END_SENTINEL_BYTES));
});

test("sentinelSplit: false start (NUL then ordinary bytes) is flushed as render bytes", () => {
	const first = sentinelSplit(Buffer.alloc(0), Buffer.from("\x00{"));
	assert.equal(first.out.length, 0);
	const second = sentinelSplit(first.held, Buffer.from("not the sentinel"));
	assert.equal(second.out.toString(), "\x00{not the sentinel");
	assert.equal(second.held.length, 0);
});

test("lock staleness: no pid file, old mtime => stale (orphaned before pid write)", () => {
	const lockDir = tmpPath("lock-old-nopid");
	fs.mkdirSync(lockDir);
	const old = Date.now() - 120000;
	fs.utimesSync(lockDir, old / 1000, old / 1000);
	assert.equal(isLockStale(lockDir), true);
	fs.rmSync(lockDir, { recursive: true, force: true });
});
