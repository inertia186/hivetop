import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { TransactionStatusMonitor } from "../dist/tui.js";

assert.ok(global.gc, "Run with --expose-gc");
const source = new URL("../dist/tui.js", import.meta.url);
const sourceHash = createHash("sha256").update(await readFile(source)).digest("hex");
const percentile = (a, p) => [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1];
const settled = { category: "irreversible", glyph: "I", status: "within_irreversible_block" };
const ids = blocks => new Set(blocks.flatMap(b => b.transactions.map(t => t.id)));

function replay(count, turnover, instrumented = false) {
  let calls = 0;
  const monitor = new TransactionStatusMonitor({ endpoint: "https://fixture.test", async findTransaction() { calls++; throw new Error("unexpected RPC"); } });
  let serial = 0;
  const makeBlock = () => {
    const number = ++serial;
    return { number, transactions: Array.from({ length: count / 100 }, (_, n) => ({ id: `${number}-${n}`, expiration: "2026-10-25T12:00:00", primaryOperationType: "vote" })) };
  };
  let blocks = Array.from({ length: 100 }, makeBlock);
  const seed = blocks => { for (const b of blocks) for (const t of b.transactions) monitor.cache.set(t.id, settled); };
  seed(blocks);
  monitor.sync({ blocks }, () => {});
  const scans = { cacheHas: 0, cacheKeys: 0, retainedValues: 0 };
  if (instrumented) {
    const has = monitor.cache.has.bind(monitor.cache), keys = monitor.cache.keys.bind(monitor.cache), values = monitor.retainedBlocks.values.bind(monitor.retainedBlocks);
    monitor.cache.has = id => { scans.cacheHas++; return has(id); };
    monitor.cache.keys = function* () { for (const id of keys()) { scans.cacheKeys++; yield id; } };
    monitor.retainedBlocks.values = function* () { for (const block of values()) { scans.retainedValues++; yield block; } };
  }
  const times = [];
  let measuredScans;
  let peakHeap = process.memoryUsage().heapUsed;
  try {
    for (let step = 0; step < (instrumented ? 1 : 200); step++) {
      const previous = ids(blocks);
      if (turnover) { blocks = [...blocks.slice(10), ...Array.from({ length: 10 }, makeBlock)]; seed(blocks.slice(-10)); }
      const expectedCache = new Set([...previous, ...ids(blocks)]);
      const at = performance.now();
      monitor.sync({ blocks }, () => {});
      times.push(performance.now() - at);
      measuredScans = { ...scans };
      // Completed off-screen blocks are removed this sync; their cache entries
      // disappear on the next sync. Assert that bounded, existing behavior.
      assert.deepEqual(new Set(monitor.cache.keys()), expectedCache);
      assert.deepEqual(monitor.displayBlocks().map(b => b.number), blocks.map(b => b.number).sort((a, b) => b - a));
      assert.equal(monitor.queue.length, 0);
      assert.equal(monitor.checking.size, 0);
      assert.equal(monitor.inFlight, 0);
      assert.equal(calls, 0);
      for (const id of ids(blocks)) assert.equal(monitor.statusFor(id), settled);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    return { p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), peakHeap, calls, scans: measuredScans, samples: times };
  } finally { monitor.stop(); }
}

const report = { date: new Date().toISOString(), node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHash, cases: [], violations: [] };
for (const count of [100, 1000, 10000]) for (const turnover of [false, true]) {
  replay(count, turnover); // Complete unmeasured warmup.
  const trials = [];
  for (let n = 0; n < 7; n++) {
    global.gc();
    const result = replay(count, turnover);
    global.gc(); result.postGcHeap = process.memoryUsage().heapUsed;
    trials.push(result);
  }
  const last = trials.slice(-3).map(t => t.postGcHeap);
  if (Math.max(...last) - Math.min(...last) >= 4 * 1024 * 1024) report.violations.push({ count, turnover, guard: "post-GC growth" });
  if (trials.some(t => t.peakHeap >= 128 * 1024 * 1024)) report.violations.push({ count, turnover, guard: "sampled heap" });
  // Instrument once outside timed trials; snapshot counters before assertions.
  const instrumented = replay(count, turnover, true);
  const summary = { count, turnover, p95Ms: percentile(trials.map(t => t.p95Ms), 0.5), trials, instrumented };
  report.cases.push(summary);
  console.log(`${count} IDs, ${turnover ? "turnover" : "settled"}: median trial p95 ${summary.p95Ms.toFixed(3)} ms`);
}
assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), sourceHash);
await writeFile(process.argv[2] ?? "benchmarks/cache-baseline.json", JSON.stringify(report, null, 2) + "\n");
if (report.violations.length) { console.error(report.violations); process.exitCode = 1; }
