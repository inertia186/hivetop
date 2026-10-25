import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, cp, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const epoch = Date.parse("2026-10-25T12:00:00Z");
const views = ["blocks", "round", "txstatus", "sizes"];
const cases = [120, 600, 3600].flatMap(window => [0, 12].flatMap(transactions => views.map(view => ({ window, transactions, view }))));
const keyOf = c => `${c.window}/${c.transactions}/${c.view}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const percentile = (a, p) => [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1];

function block(number, transactions, timestamp = epoch + (number - 10000) * 3000) {
  return { number, timestamp: new Date(timestamp), witness: `w-${number % 21}`, transactionCount: transactions,
    transactions: Array.from({ length: transactions }, (_, i) => ({ id: `${number}-${i}`, expiration: new Date(timestamp + 3600000).toISOString().slice(0, -1), primaryOperationType: ["vote", "custom_json", "transfer"][i % 3] })),
    operationCount: transactions * 2, virtualOperationCount: number % 3, operationTypes: new Map(transactions ? [["vote", transactions], ["custom_json", transactions]] : []), sizeBytes: 1024 + number % 4096 };
}

async function replay(runtime, options, memory = false) {
  const { MetricsStore } = await import(pathToFileURL(resolve(runtime, "dist/metrics.js")));
  const { TerminalUi } = await import(pathToFileURL(resolve(runtime, "dist/tui.js")));
  global.gc();
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: epoch });
  const output = createHash("sha256"), state = createHash("sha256");
  const descriptors = ["columns", "rows"].map(key => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  const originalWrite = process.stdout.write;
  let bytes = 0, writes = 0, calls = 0, resets = 0, pauses = 0;
  process.stdout.write = chunk => { bytes += Buffer.byteLength(String(chunk)); writes++; output.update(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 160 });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 50 });
  const store = new MetricsStore(options.window);
  let head = block(10000, options.transactions);
  for (let n = 10000 - Math.floor(options.window / 3); n <= 10000; n++) store.record(n === head.number ? head : block(n, options.transactions), head.timestamp);
  const response = tx => ({ status: "within_irreversible_block", block_num: Number(tx.id.split("-")[0]) });
  const client = { endpoint: "https://fixture.test",
    async findTransaction(id) { calls++; return response({ id }); },
    async findTransactions(transactions) { calls++; return transactions.map(response); },
  };
  const ui = new TerminalUi({ node: client.endpoint, windowSeconds: options.window, view: options.view,
    transactionStatusClient: client, noColor: false, ascii: false,
    onQuit() {}, onPauseToggle() { pauses++; }, onReset() { resets++; store.record(head); },
  });
  const monitor = ui.txStatusMonitor, phases = { metricsMs: 0, syncMs: 0, trimMs: 0, drawMs: 0 };
  function instrument(object, method, key) {
    const fn = object[method].bind(object);
    object[method] = (...args) => { const at = performance.now(); try { return fn(...args); } finally { phases[key] += performance.now() - at; } };
  }
  instrument(store, "snapshot", "metricsMs"); instrument(monitor, "sync", "syncMs");
  instrument(monitor, "trimRetainedBlocks", "trimMs"); instrument(ui, "draw", "drawMs");
  const snapshot = () => {
    const result = store.snapshot();
    const cutoff = head.timestamp.getTime() - options.window * 1000;
    assert.ok(result.blocks.every(b => b.timestamp.getTime() >= cutoff));
    assert.equal(new Set(result.blocks.map(b => b.number)).size, result.blocks.length);
    assert.equal(result.blocks.length, Math.floor(options.window / 3) + 1);
    assert.ok(result.blocks.includes(head));
    state.update(JSON.stringify({ ...result, blocks: result.blocks.map(b => [b.number, b.witness, b.sizeBytes, b.timestamp.getTime()]) }));
    return result;
  };
  const render = type => {
    const round = Math.floor(head.number / 21), boundary = (round + 1) * 21;
    ui.render({ type, ...(type === "block" ? { block: head } : { nextBlock: head.number + 1 }), headBlock: head.number, lag: 0,
      dynamicGlobalProperties: { head_block_number: head.number, current_aslot: head.number, time: head.timestamp.toISOString().slice(0, -1) },
      witnessSchedule: { current_shuffled_witnesses: Array.from({ length: 21 }, (_, i) => `w-${i}`), future_shuffled_witnesses: Array.from({ length: 21 }, (_, i) => `w-${i}`), next_shuffle_block_num: boundary },
      witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [],
    }, snapshot());
  };
  const inputTimes = [], heapSamples = [];
  let peakHeap = process.memoryUsage().heapUsed, maxBlocks = 0;
  try {
    render("block");
    await flush();
    if (!memory) ui.healthTimer = setInterval(() => ui.draw(), 1000);
    const cpuStart = process.cpuUsage(), start = performance.now();
    const duration = memory ? options.window * 4 * 1000 : (options.durationMs ?? 60000);
    const step = memory ? 30000 : 250;
    for (let elapsed = step; elapsed <= duration; elapsed += step) {
      mock.timers.tick(step);
      await flush();
      if (memory || elapsed % 1000 === 0) {
        const desired = 10000 + Math.floor(elapsed / 3000);
        while (head.number < desired) { head = block(head.number + 1, options.transactions); store.record(head); }
        if (!memory && elapsed === 15000) { head = { ...head, witness: "replacement", sizeBytes: 9999 }; store.record(head); }
        if (!memory && elapsed === 20000) head.sizeBytes = 7777;
        render(elapsed % 3000 === 0 || memory ? "block" : "status");
        await flush();
        maxBlocks = Math.max(maxBlocks, store.blocks.length);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }
      if (!memory) {
        const inputStart = performance.now();
        ui.onKey(["j", "k", "?", "\u001b", "p", "p", "r", "g"][(elapsed / step - 1) % 8]);
        inputTimes.push(performance.now() - inputStart);
      } else if (elapsed % (options.window * 1000) === 0) {
        global.gc(); heapSamples.push(process.memoryUsage().heapUsed / 1024 ** 2);
      }
    }
    const cpu = process.cpuUsage(cpuStart);
    const result = { ...options, memory, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - start,
      cpuMsPerSimulatedMinute: (cpu.user + cpu.system) / 1000 / (duration / 60000), phases,
      inputP95Ms: inputTimes.length ? percentile(inputTimes, .95) : null, inputSamples: inputTimes.length,
      sampledPeakHeapMiB: peakHeap / 1024 ** 2, turnoverHeapMiB: heapSamples, maxBlocks,
      calls, resets, pauses, writes, bytes, outputSha256: output.copy().digest("hex"), stateSha256: state.copy().digest("hex"),
      retained: monitor.displayBlocks().map(b => b.number), queue: monitor.queue.map(tx => tx.id),
      statuses: [...monitor.cache].map(([id, value]) => [id, value.category]),
    };
    assert.ok(result.sampledPeakHeapMiB <= 128, "fixed 128 MiB sampled heap ceiling");
    if (memory) assert.ok(Math.max(...heapSamples.slice(1)) - Math.min(...heapSamples.slice(1)) <= 4, "post-GC growth across the final three turnovers must stay within 4 MiB");
    return result;
  } finally {
    ui.stop(); await flush(); mock.timers.reset(); process.stdout.write = originalWrite;
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else delete process.stdout[key]; }
  }
}

async function hashes(runtime) {
  const files = (await readdir(resolve(runtime, "dist"))).filter(p => p.endsWith(".js")).map(p => `dist/${p}`);
  return Object.fromEntries(await Promise.all(files.map(async p => [p, hash(await readFile(resolve(runtime, p)))])));
}

async function main() {
  assert.equal(process.version, "v24.16.0"); assert.equal(typeof global.gc, "function");
  const [baselineArg, outputArg, mode] = process.argv.slice(2);
  assert.ok(baselineArg && outputArg && (!mode || ["--baseline", "--controls", "--aa"].includes(mode)), "Usage: node --expose-gc scripts/window-baseline.mjs BASELINE_RUNTIME OUTPUT [--baseline|--controls|--aa]");
  const baseline = resolve(baselineArg), baselineOnly = mode === "--baseline";
  const controlsOnly = mode === "--controls", aaOnly = mode === "--aa";
  const selectedCases = controlsOnly ? cases.filter(c => c.window === 120 && c.transactions === 0).map(c => ({ ...c, durationMs: 600000 }))
    : aaOnly ? cases.filter(c => (c.window === 120 && c.transactions === 0 && c.view === "blocks") || (c.window === 3600 && c.transactions === 12 && c.view === "sizes")) : cases;
  const aaDirectory = aaOnly ? await mkdtemp(resolve(tmpdir(), "hivetop-window-aa-")) : undefined;
  try {
    if (aaDirectory) {
      await cp(resolve(baseline, "dist"), resolve(aaDirectory, "dist"), { recursive: true });
      await cp(resolve(baseline, "package.json"), resolve(aaDirectory, "package.json"));
    }
    const candidateRuntime = aaDirectory ?? root;
    const variants = baselineOnly ? [["baseline", baseline]] : [["baseline", baseline], ["candidate", candidateRuntime]];
    const initial = await hashes(candidateRuntime), baselineHashes = await hashes(baseline), samples = [];
    if (aaOnly) assert.deepEqual(initial, baselineHashes, "A/A runtime copies must be byte-identical");
    for (const [variant, runtime] of variants) {
      for (const options of selectedCases) await replay(runtime, options);
      console.error(`Warmup complete: ${variant}`);
    }
    for (let pair = 0; pair < (baselineOnly ? 1 : 7); pair++) {
      for (const [variant, runtime] of pair % 2 ? [...variants].reverse() : variants) {
        for (const options of selectedCases) samples.push({ pair: pair + 1, variant, ...await replay(runtime, options) });
      }
      console.error(`Paired pass ${pair + 1}/${baselineOnly ? 1 : 7} complete`);
    }
    const memory = [];
    if (!controlsOnly && !aaOnly) for (const [variant, runtime] of variants) memory.push({ variant, ...await replay(runtime, { window: 3600, transactions: 12, view: "txstatus" }, true) });
    if (!baselineOnly) {
      const behavior = ({ cpuMs, wallMs, cpuMsPerSimulatedMinute, phases, inputP95Ms, sampledPeakHeapMiB, turnoverHeapMiB, pair, variant, ...rest }) => rest;
      for (const row of samples.filter(r => r.variant === "candidate")) {
        const original = samples.find(r => r.variant === "baseline" && r.pair === row.pair && keyOf(r) === keyOf(row));
        assert.deepEqual(behavior(row), behavior(original), `Exact output, snapshots, status work and retention: ${keyOf(row)}`);
      }
      if (memory.length) assert.deepEqual(behavior(memory[1]), behavior(memory[0]), "Long-session state and output must match exactly");
    }
    assert.deepEqual(await hashes(candidateRuntime), initial); assert.deepEqual(await hashes(baseline), baselineHashes);
    const summary = [];
    for (const [variant] of variants) for (const options of selectedCases) {
      const rows = samples.filter(r => r.variant === variant && keyOf(r) === keyOf(options));
      summary.push({ variant, ...options, cpuMsPerSimulatedMinute: percentile(rows.map(r => r.cpuMsPerSimulatedMinute), .5),
        cpuMinMs: Math.min(...rows.map(r => r.cpuMsPerSimulatedMinute)), cpuMaxMs: Math.max(...rows.map(r => r.cpuMsPerSimulatedMinute)),
        inputP95Ms: percentile(rows.map(r => r.inputP95Ms), .5), phases: Object.fromEntries(Object.keys(rows[0].phases).map(key => [key, percentile(rows.map(r => r.phases[key]), .5)])) });
    }
    const report = { date: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      mode: mode ?? "--compare", sourceDiff: aaOnly ? "" : execFileSync("git", ["diff", "--", "src", "dist"], { cwd: root, encoding: "utf8" }), baselineHashes, candidateHashes: initial,
      runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
      protocol: { epoch, cases: selectedCases, dimensions: [160, 50], durationMs: controlsOnly ? 600000 : 60000, stepMs: 250,
        warmup: "one complete unmeasured replay of each case for each version", pairs: baselineOnly ? 1 : 7, heapCeilingMiB: 128, finalTurnoverGrowthCeilingMiB: 4,
        memory: controlsOnly || aaOnly ? "Not run in this diagnostic mode." : "Four complete hour-window turnovers; ten-block catch-up bursts each 30 seconds, one full render per burst, without the independent health draw timer. All produced blocks are recorded. Post-GC heap measured after each turnover.",
        note: "Full event-processing path from metrics.record/snapshot through render, transaction sync, callback draws, animation and input; no follower/network transport or real terminal painting. Performance includes harness checks, hashing, phase instrumentation and scheduling. Phase timings overlap: sync includes trim, draw includes nested callback work. All output goes through a hash sink. Each input p95 has 240 samples (2400 in controls mode). Memory uses the same process/module inventory across variants; RSS is not scored." },
      summary, samples, memory };
    await writeFile(resolve(outputArg), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.table(summary.map(({ variant, window, transactions, view, cpuMsPerSimulatedMinute, phases, inputP95Ms }) => ({ variant, window, transactions, view, cpuMs: Math.round(cpuMsPerSimulatedMinute), trimMs: Math.round(phases.trimMs), inputP95Ms: inputP95Ms.toFixed(3) })));
  } finally { if (aaDirectory) await rm(aaDirectory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
