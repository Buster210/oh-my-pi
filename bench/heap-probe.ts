// Preload probe: after boot settles, dump the memory split of THIS live session
// process, then exit. Non-invasive — loaded via --preload, touches no source.
// Splits phys_footprint into JS objects (heapUsed) vs external buffers vs
// arrayBuffers, so we know whether the lever is JS state or big buffers.
const DELAY = Number(process.env.HEAP_PROBE_MS || 15000);
setTimeout(() => {
	const m = process.memoryUsage();
	const mb = (n: number) => (n / 1048576).toFixed(1);
	const out = [
		`rss=${mb(m.rss)}MB`,
		`heapTotal=${mb(m.heapTotal)}MB`,
		`heapUsed=${mb(m.heapUsed)}MB`,
		`external=${mb(m.external)}MB`,
		`arrayBuffers=${mb(m.arrayBuffers)}MB`,
	].join("  ");
	try {
		require("node:fs").writeFileSync(process.env.HEAP_PROBE_OUT || "/tmp/omp-heap-probe.txt", out + "\n");
	} catch {}
}, DELAY);
