import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, platform, release, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate as flush, setTimeout as sleep } from "node:timers/promises";
import { mock } from "node:test";
import { HiveRpcClient } from "../dist/rpc.js";
import { MetricsStore } from "../dist/metrics.js";
import { TerminalUi, TransactionStatusMonitor } from "../dist/tui.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const epoch = Date.parse("2026-10-24T12:00:00Z");
const stepMs = 10;
const repetitions = 7;
const mib = 1024 * 1024;
const statuses = ["within_irreversible_block", "within_reversible_block", "within_mempool", "unknown", "expired_irreversible", "too_old", "within_reversible_block"];
const categories = ["irreversible", "reversible", "mempool", "unknown", "expired", "old", "mismatch"];
const cases = [
  { name: "low", count: 3, blocks: 100, duration: 330000 },
  { name: "steady", count: 12, blocks: 100, duration: 330000 },
  { name: "burst", count: 240, blocks: 4, every: 30000, duration: 300000, latency: 800 },
  { name: "batch-rejected", count: 240, blocks: 4, every: 30000, duration: 300000, latency: 800, rejectBatch: true },
  { name: "retry", count: 12, blocks: 100, duration: 420000, retry: true },
  { name: "queue-cap", count: 700, blocks: 1, duration: 300000 },
  { name: "retention-cap", count: 2, blocks: 320, duration: 240000, initialHistory: true, window: 1200 },
  { name: "unavailable", count: 120, blocks: 1, duration: 30000, unavailable: true },
  { name: "shutdown", count: 120, blocks: 1, duration: 3000, latency: 800, stopAt: 1250 },
  ...["blocks", "round", "sizes"].map(view => ({ name: `steady-${view}`, count: 12, blocks: 100, duration: 330000, view })),
  { name: "view-switch", count: 12, blocks: 100, duration: 330000, switchViews: true },
  { name: "steady-monitor", count: 12, blocks: 100, duration: 330000, monitorOnly: true },
];

function fixture(options) {
  const blocks = [];
  const transactions = new Map();
  for (let index = 0; index < options.blocks; index++) {
    const at = options.initialHistory ? 0 : index * (options.every ?? 3000);
    const block = {
      number: 1000 + (options.initialHistory ? index : Math.floor(at / 3000)),
      timestamp: new Date(epoch + (options.initialHistory ? (index - options.blocks + 1) * 3000 : at)),
      witness: `witness-${index % 21}`, transactionCount: options.count,
      operationCount: options.count, virtualOperationCount: 0,
      operationTypes: new Map([["vote", options.count]]), sizeBytes: 1024,
      transactions: [],
    };
    for (let tx = 0; tx < options.count; tx++) {
      const serial = transactions.size;
      const id = `${block.number}-${tx}`;
      const ref = { id, expiration: new Date(epoch + 3600000 + (serial % 17) * 3000).toISOString().slice(0, -1),
        primaryOperationType: ["vote", "custom_json", "transfer"][serial % 3] };
      block.transactions.push(ref);
      transactions.set(id, { at, serial, block: block.number, category: categories[serial % categories.length] });
    }
    blocks.push({ at, block });
  }
  return { blocks, transactions };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function peakRate(requests, operations = false) {
  let left = 0, count = 0, peak = 0;
  for (let right = 0; right < requests.length; right++) {
    count += operations ? requests[right].operations : 1;
    while (requests[right].at - requests[left].at >= 1000) {
      count -= operations ? requests[left].operations : 1;
      left++;
    }
    peak = Math.max(peak, count);
  }
  return peak;
}

async function replay(options, realTime = false) {
  const { blocks, transactions } = fixture(options);
  const completed = new Map(), awaitingDisplay = new Set(), attempts = new Map();
  const requests = [], warnings = new Set();
  let active = 0, peakActive = 0, failures = 0, aborted = 0, outputBytes = 0, writes = 0;
  let maxUnresolved = 0, unresolvedAtArrivalEnd = 0, peakQueue = 0, peakRetained = 0;
  let stopped = false, completionsAtStop, head = 999, nextBlock = 0;
  const originalWrite = process.stdout.write;
  const dimensions = ["columns", "rows"].map(key => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  const startTime = realTime ? Date.now() : epoch;
  const elapsed = () => Date.now() - startTime;
  if (!realTime) mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: epoch });
  process.stdout.write = chunk => { writes++; outputBytes += Buffer.byteLength(String(chunk)); return true; };
  for (const [key, value] of [["columns", 160], ["rows", 50]]) Object.defineProperty(process.stdout, key, { configurable: true, value });

  const client = new HiveRpcClient("https://fixture.invalid", async (_url, init) => {
    const input = JSON.parse(init.body);
    const calls = Array.isArray(input) ? input : [input];
    for (const call of calls) {
      assert.equal(call.method, "transaction_status_api.find_transaction");
      assert.ok(transactions.has(call.params.transaction_id));
      attempts.set(call.params.transaction_id, (attempts.get(call.params.transaction_id) ?? 0) + 1);
    }
    requests.push({ at: elapsed(), operations: calls.length, batch: Array.isArray(input) });
    peakActive = Math.max(peakActive, ++active);
    let released = false;
    const finish = () => { if (!released) { released = true; active--; } };
    // Delay the body too: HiveRpcClient must keep its deadline active through json().
    return { ok: true, status: 200, json: () => new Promise((resolveBody, rejectBody) => {
      const cancel = () => { clearTimeout(timer); aborted++; finish(); rejectBody(init.signal.reason); };
      const timer = setTimeout(() => {
        init.signal.removeEventListener("abort", cancel);
        finish();
        if (options.rejectBatch && Array.isArray(input)) {
          failures++;
          resolveBody({ error: { message: "batch unsupported" } });
          return;
        }
        const payload = calls.map(call => {
          const id = call.params.transaction_id;
          const tx = transactions.get(id);
          if (options.unavailable || (options.retry && tx.serial % 17 === 0 && attempts.get(id) === 1)) {
            failures++;
            return { id: call.id, error: { message: options.unavailable ? "method not found" : "temporary fixture error" } };
          }
          awaitingDisplay.add(id);
          return { id: call.id, result: { status: statuses[tx.serial % statuses.length],
            block_num: tx.category === "mismatch" ? tx.block + 1 : tx.block } };
        });
        resolveBody(Array.isArray(input) ? payload.reverse() : payload[0]);
      }, options.latency ?? 100);
      init.signal.addEventListener("abort", cancel, { once: true });
      if (init.signal.aborted) cancel();
    }) };
  });
  const metrics = new MetricsStore(options.window ?? 120);
  const ui = options.monitorOnly ? undefined : new TerminalUi({ node: client.endpoint,
    windowSeconds: options.window ?? 120, transactionStatusClient: client, view: options.view ?? "txstatus",
    noColor: false, ascii: false, onQuit() {}, onPauseToggle() {}, onReset() {} });
  const monitor = ui?.txStatusMonitor ?? new TransactionStatusMonitor(client);
  const observe = () => {
    for (const id of awaitingDisplay) {
      const status = monitor.statusFor(id);
      if (["pending", "checking"].includes(status.category)) continue;
      assert.equal(status.category, transactions.get(id).category, `${options.name}: ${id} identity/status`);
      if (!completed.has(id)) completed.set(id, elapsed());
      awaitingDisplay.delete(id);
    }
    if (monitor.diagnostic()) warnings.add(monitor.diagnostic());
  };
  // Keep the real callback path, including draw(), but observe before a later sync evicts cached results.
  const draw = ui?.draw.bind(ui);
  if (ui) ui.draw = () => { observe(); draw(); };
  if (ui) ui.healthTimer = setInterval(() => ui.draw(), 1000);
  const deliver = at => {
    if (stopped) return;
    let newest;
    while (nextBlock < blocks.length && blocks[nextBlock].at <= at) {
      newest = blocks[nextBlock++].block;
      metrics.record(newest);
      head = newest.number;
    }
    if (!newest && !options.initialHistory && at % 3000 === 0) {
      newest = { number: ++head, timestamp: new Date(epoch + at), witness: "witness-0",
        transactions: [], transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map(), sizeBytes: 1024 };
      metrics.record(newest);
    }
    const snapshot = metrics.snapshot();
    if (ui) {
      const props = { head_block_number: head, current_aslot: head, last_irreversible_block_num: head - 21,
        time: new Date(epoch + at).toISOString() };
      ui.render({ type: newest ? "block" : "status", block: newest, headBlock: head, nextBlock: head + 1, lag: 0,
        dynamicGlobalProperties: props, witnessSchedule: { current_shuffled_witnesses: Array.from({ length: 21 }, (_, i) => `witness-${i}`),
          next_shuffle_block_num: (Math.floor(head / 21) + 1) * 21 },
        witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [] }, snapshot);
      if (options.switchViews && at > 0 && at % 15000 === 0) ui.onKey("v");
      if (options.switchViews && at % 30000 === 5000) ui.onKey("\r");
      if (options.switchViews && at % 30000 === 7000) ui.onKey("\x1b");
    } else monitor.sync(snapshot, observe);
    observe();
    const offered = [...transactions.values()].filter(tx => tx.at <= at).length;
    maxUnresolved = Math.max(maxUnresolved, offered - completed.size);
    peakQueue = Math.max(peakQueue, monitor.queue.length);
    peakRetained = Math.max(peakRetained, monitor.retainedBlocks.size);
    if (at <= blocks.at(-1).at) unresolvedAtArrivalEnd = offered - completed.size;
  };
  global.gc();
  const memoryBefore = process.memoryUsage();
  let peakHeap = memoryBefore.heapUsed, peakRss = memoryBefore.rss;
  const cpuStart = process.cpuUsage(), wallStart = performance.now();
  try {
    deliver(0);
    await flush();
    for (let at = stepMs; at <= options.duration; at += stepMs) {
      if (realTime) await sleep(Math.max(0, wallStart + at - performance.now()));
      else mock.timers.tick(stepMs);
      await flush();
      observe();
      if (options.stopAt === at) {
        ui ? ui.stop() : monitor.stop();
        stopped = true;
        completionsAtStop = completed.size;
        await flush();
      }
      if (at % 1000 === 0) {
        deliver(at);
        const memory = process.memoryUsage();
        peakHeap = Math.max(peakHeap, memory.heapUsed);
        peakRss = Math.max(peakRss, memory.rss);
      }
    }
    const cpu = process.cpuUsage(cpuStart), wallMs = performance.now() - wallStart;
    const unresolved = [...transactions].filter(([id]) => !completed.has(id));
    const lost = unresolved.filter(([id]) => !monitor.queue.some(item => item.id === id) &&
      !monitor.checking.has(id) && !monitor.displayBlocks().some(block => block.transactions.some(tx => tx.id === id)));
    const latency = [...completed].map(([id, at]) => at - transactions.get(id).at);
    const totals = { offered: transactions.size, completed: completed.size, unresolved: unresolved.length, noLongerRetained: lost.length };
    assert.equal(totals.completed + totals.unresolved, totals.offered);
    assert.ok(peakQueue <= 500);
    assert.ok(peakRetained <= 300);
    if (stopped) assert.equal(completed.size, completionsAtStop, "no completions after shutdown");
    const result = { name: options.name, ...totals,
      coverage: completed.size / transactions.size, latencyP50Ms: percentile(latency, .5), latencyP95Ms: percentile(latency, .95),
      latencyMaxMs: percentile(latency, 1), unresolvedMaxAgeMs: unresolved.length ? Math.max(...unresolved.map(([, tx]) => options.duration - tx.at)) : 0,
      maxUnresolved, unresolvedAtArrivalEnd, peakQueue, peakRetained,
      httpRequests: requests.length, rpcOperations: requests.reduce((sum, request) => sum + request.operations, 0),
      batchRequests: requests.filter(request => request.batch).length, failures, aborted,
      repeatedOperations: [...attempts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      peakHttpPerSecond: peakRate(requests), peakRpcPerSecond: peakRate(requests, true), peakInFlightHttp: peakActive,
      cpuMs: (cpu.user + cpu.system) / 1000, replayWallMs: wallMs,
      heapBeforeMiB: memoryBefore.heapUsed / mib, sampledPeakHeapMiB: peakHeap / mib,
      sampledPeakHeapGrowthMiB: (peakHeap - memoryBefore.heapUsed) / mib, sampledPeakRssMiB: peakRss / mib,
      writes, outputBytes, warnings: [...warnings], completionTimes: Object.fromEntries(completed) };
    ui ? ui.stop() : monitor.stop();
    stopped = true;
    await flush();
    assert.equal(active, 0, "all HTTP bodies settled or cancelled at shutdown");
    return result;
  } finally {
    if (!stopped) ui ? ui.stop() : monitor.stop();
    await flush();
    if (!realTime) mock.timers.reset();
    process.stdout.write = originalWrite;
    for (const [key, descriptor] of dimensions) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else delete process.stdout[key];
    }
  }
}

function verify(result) {
  if (result.name === "unavailable") {
    assert.equal(result.completed, 0);
    assert.ok(result.warnings.includes("transaction_status_api unavailable"));
  } else if (result.name === "retention-cap") {
    assert.equal(result.noLongerRetained, 40, "320 two-transaction blocks exceed the 300-block cap by 40 transactions");
    assert.equal(result.completed, 600);
  } else if (result.name === "shutdown") {
    assert.ok(result.aborted > 0 && result.unresolved > 0);
  } else assert.equal(result.completed, result.offered, `${result.name}: every offered transaction must complete`);
  if (result.name === "batch-rejected") assert.ok(result.batchRequests > 0 && result.repeatedOperations > 0);
  if (result.name === "retry") assert.ok(result.failures > 0 && result.repeatedOperations > 0);
}

async function main() {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node >=24");
  assert.equal(typeof global.gc, "function", "Run node --expose-gc scripts/txstatus-baseline.mjs");
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--verify") || (args.length === 2 && args[0] === "--output"),
    "Usage: node --expose-gc scripts/txstatus-baseline.mjs [--verify | --output result.json]");
  const verifyOnly = args[0] === "--verify";
  const rateExample = [{ at: 0, operations: 8 }, { at: 250, operations: 1 }, { at: 1000, operations: 4 }];
  assert.equal(peakRate(rateExample), 2);
  assert.equal(peakRate(rateExample, true), 9);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), .95), 95);
  const calibration = [];
  for (const retry of [false, true]) {
    const options = { name: `calibration-${retry ? "retry" : "single"}`, count: 16, blocks: 1,
      duration: 7000, latency: 100, retry, monitorOnly: true };
    process.stderr.write(`Calibrating ${options.name}: simulated time.\n`);
    const simulated = await replay(options);
    process.stderr.write(`Calibrating ${options.name}: real time.\n`);
    const real = await replay(options, true);
    assert.equal(simulated.completed, 16);
    assert.equal(real.completed, 16);
    assert.equal(real.httpRequests, simulated.httpRequests);
    assert.equal(real.rpcOperations, simulated.rpcOperations);
    const maxCompletionDeltaMs = Math.max(...Object.keys(simulated.completionTimes).map(id => Math.abs(real.completionTimes[id] - simulated.completionTimes[id])));
    assert.ok(maxCompletionDeltaMs < 250, `real-time calibration diverged by ${maxCompletionDeltaMs} ms`);
    calibration.push({ name: options.name, transactions: 16, maxCompletionDeltaMs, httpRequests: real.httpRequests,
      rpcOperations: real.rpcOperations, simulatedP95Ms: simulated.latencyP95Ms, realP95Ms: real.latencyP95Ms });
  }
  process.stderr.write("Real-time calibration passed. Warming up and verifying workloads.\n");
  for (const options of cases) verify(await replay(options));
  if (verifyOnly) { console.log(`Verified ${cases.length} workloads and two real-time calibrations.`); return; }
  const samples = [];
  const deterministic = new Map();
  for (let run = 0; run < repetitions; run++) {
    for (const options of run % 2 ? [...cases].reverse() : cases) {
      const result = await replay(options);
      verify(result);
      delete result.completionTimes;
      const countsAndLatency = Object.fromEntries(Object.entries(result).filter(([key]) =>
        !/^(cpuMs|replayWallMs|heapBeforeMiB|sampledPeak)/.test(key)));
      if (deterministic.has(options.name)) assert.deepEqual(countsAndLatency, deterministic.get(options.name), "replay must be deterministic");
      else deterministic.set(options.name, countsAndLatency);
      samples.push({ run: run + 1, ...result });
    }
    process.stderr.write(`Baseline repetition ${run + 1}/${repetitions} complete.\n`);
  }
  const paths = ["scripts/txstatus-baseline.mjs", "package-lock.json", "src/tui.ts", "src/rpc.ts", "src/metrics.ts", "src/schedule.ts",
    "dist/tui.js", "dist/rpc.js", "dist/metrics.js", "dist/schedule.js"];
  const sha256 = data => createHash("sha256").update(data).digest("hex");
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(resolve(root, path)))])));
  const summary = cases.map(({ name }) => {
    const rows = samples.filter(sample => sample.name === name);
    const summary = { name };
    for (const key of Object.keys(rows[0])) if (typeof rows[0][key] === "number" && key !== "run") {
      const values = rows.map(row => row[key]);
      summary[key] = { median: percentile(values, .5), min: Math.min(...values), max: Math.max(...values) };
    }
    return summary;
  });
  const report = { schema: 1, recordedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceDiff: execFileSync("git", ["diff", "--", "src", "dist"], { cwd: root, encoding: "utf8" }), hashes,
    environment: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model },
    protocol: { repetitions, warmup: "one complete replay per case", stepMs, epoch, dimensions: [160, 50], color: true,
      defaultView: "txstatus", windowSeconds: 120, pollMs: 1000, rpcLatencyMs: 100,
      note: "Latency and request rates use simulated time in 10 ms steps. CPU and sampled memory include the replay harness and an in-memory output sink; no live HTTP, terminal painting, or follower RPC. Sizes are premeasured. Monitor limits are unmodified production defaults. RSS shares a process across cases. Real-time calibration covers singles and retries; exact ordering at simultaneous batch/window boundaries can differ under real timers." },
    fixtureSha256: sha256(JSON.stringify({ epoch, stepMs, statuses, categories, cases })), cases, calibration, summary, samples };
  const output = resolve(args[0] === "--output" ? args[1] : "benchmarks/txstatus-baseline.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${samples.length} samples to ${output}`);
  console.table(summary.map(row => ({ case: row.name, offered: row.offered.median, completed: row.completed.median,
    "p95 ms": row.latencyP95Ms?.median ?? "n/a", HTTP: row.httpRequests.median, RPC: row.rpcOperations.median,
    "peak HTTP/s": row.peakHttpPerSecond.median, "in flight": row.peakInFlightHttp.median, "CPU ms": Math.round(row.cpuMs.median) })));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
