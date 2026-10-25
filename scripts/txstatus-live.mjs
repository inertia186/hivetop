import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, cpus, loadavg, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { BlockFollower } from "../dist/follower.js";
import { MetricsStore } from "../dist/metrics.js";
import { HiveRpcClient } from "../dist/rpc.js";
import { TerminalUi } from "../dist/tui.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const statusMethod = "transaction_status_api.find_transaction";
const defaults = { endpoint: "https://api.hive.blog", warmupMs: 120000, intervalMs: 60000,
  intervals: 7, drainMs: 120000, windowSeconds: 120, pollMs: 1000, rpcTimeoutMs: 10000 };
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const countBy = (rows, field) => rows.reduce((counts, row) => { const key = row[field] ?? "unresolved"; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});

function peakRate(requests, operations = false) {
  let left = 0, count = 0, peak = 0;
  for (let right = 0; right < requests.length; right++) {
    count += operations ? requests[right].operations : 1;
    while (requests[right].atMs - requests[left].atMs >= 1000) {
      count -= operations ? requests[left].operations : 1;
      left++;
    }
    peak = Math.max(peak, count);
  }
  return peak;
}

function cohortSummary(transactions, endMs) {
  const completed = transactions.filter(tx => tx.completedAtMs !== undefined);
  const unresolved = transactions.filter(tx => tx.completedAtMs === undefined);
  const latency = completed.map(tx => tx.completedAtMs - tx.observedAtMs);
  return { offered: transactions.length, completed: completed.length, unresolved: unresolved.length,
    coverage: transactions.length ? completed.length / transactions.length : null,
    latencyP50Ms: percentile(latency, .5), latencyP95Ms: percentile(latency, .95), latencyMaxMs: percentile(latency, 1),
    unresolvedMaxAgeMs: unresolved.length ? Math.max(...unresolved.map(tx => endMs - tx.observedAtMs)) : 0,
    categories: countBy(completed, "category"), unresolvedStates: countBy(unresolved, "stateAtCutoff") };
}

function requestSummary(requests) {
  const latency = requests.filter(request => request.endedAtMs !== undefined && !request.error).map(request => request.endedAtMs - request.atMs);
  return { httpRequests: requests.length, rpcOperations: requests.reduce((sum, request) => sum + request.operations, 0),
    batches: requests.filter(request => request.batch).length, httpOrTransportErrors: requests.filter(request => request.error && !request.aborted).length,
    aborted: requests.filter(request => request.aborted).length, rpcErrors: requests.reduce((sum, request) => sum + (request.rpcErrors?.length ?? 0), 0),
    peakHttpPerSecond: peakRate(requests), peakRpcPerSecond: peakRate(requests, true),
    peakAllHttpInFlightAtStart: Math.max(0, ...requests.map(request => request.inFlight)),
    peakStatusHttpInFlightAtStart: Math.max(0, ...requests.map(request => request.statusInFlight ?? 0)),
    rpcP50Ms: percentile(latency, .5), rpcP95Ms: percentile(latency, .95), methods: countBy(requests, "method") };
}

function resourceSummary(samples, from, to) {
  const first = samples.find(sample => sample.atMs >= from);
  const last = samples.find(sample => sample.atMs >= to) ?? samples.at(-1);
  if (!first || !last || last.atMs <= first.atMs) return null;
  const rows = samples.filter(sample => sample.atMs >= first.atMs && sample.atMs <= last.atMs);
  const cpuMs = (last.cpuUserUs + last.cpuSystemUs - first.cpuUserUs - first.cpuSystemUs) / 1000;
  const wallMs = last.atMs - first.atMs;
  return { fromMs: first.atMs, toMs: last.atMs, cpuMs, wallMs, cpuPercentOfOneCore: 100 * cpuMs / wallMs,
    peakHeapMiB: Math.max(...rows.map(row => row.heapUsed)) / 1024 ** 2, peakRssMiB: Math.max(...rows.map(row => row.rss)) / 1024 ** 2,
    peakQueue: Math.max(...rows.map(row => row.queued)), peakUnresolved: Math.max(...rows.map(row => row.unresolved)),
    outputBytes: last.outputBytes - first.outputBytes, writes: last.writes - first.writes };
}

async function capture(config, fetchImpl = fetch, quiet = false) {
  const startedAt = new Date().toISOString(), started = performance.now(), cpuStarted = process.cpuUsage();
  const intakeMs = config.warmupMs + config.intervals * config.intervalMs;
  const followerAbort = new AbortController(), stop = new AbortController();
  const requests = [], samples = [], blocks = [], events = [];
  const transactions = new Map(), awaitingDisplay = new Set();
  let active = 0, activeStatus = 0, outputBytes = 0, writes = 0, declaredTransactions = 0;
  let cutoffMs, actualIntakeEndMs, interrupted = false, lastWarning;
  const elapsed = () => performance.now() - started;
  const phase = at => at < config.warmupMs ? "warmup" : at < intakeMs ? Math.floor((at - config.warmupMs) / config.intervalMs) + 1 : "drain";
  const originalWrite = process.stdout.write;
  const dimensions = ["columns", "rows"].map(key => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  const client = new HiveRpcClient(config.endpoint, async (url, init) => {
    const input = JSON.parse(init.body), calls = Array.isArray(input) ? input : [input];
    const isStatus = calls.every(call => call.method === statusMethod);
    const record = { atMs: elapsed(), method: calls[0].method, operations: calls.length, batch: Array.isArray(input),
      inFlight: ++active, statusInFlight: isStatus ? ++activeStatus : activeStatus };
    requests.push(record);
    for (const call of calls) if (isStatus) {
      const tx = transactions.get(call.params.transaction_id);
      if (tx) { tx.attempts++; tx.firstRequestAtMs ??= record.atMs; }
    }
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      record.endedAtMs = elapsed();
      if (error) { record.error = String(error.message ?? error); record.aborted = Boolean(init.signal?.aborted); }
      active--;
      if (isStatus) activeStatus--;
    };
    try {
      const response = await fetchImpl(url, init);
      record.httpStatus = response.status;
      if (!response.ok) { finish(new Error(`HTTP ${response.status}`)); await response.body?.cancel(); }
      return { ok: response.ok, status: response.status, headers: response.headers, json: async () => {
        try {
          const payload = await response.json();
          const responses = Array.isArray(payload) ? payload : [payload];
          record.rpcErrors = responses.filter(row => row?.error).map(row => ({ code: row.error.code, message: String(row.error.message).slice(0, 500) }));
          if (isStatus) for (const call of calls) {
            const result = responses.find(row => row?.id === call.id)?.result;
            if (result) awaitingDisplay.add(call.params.transaction_id);
          }
          finish();
          return payload;
        } catch (error) { finish(error); throw error; }
      } };
    } catch (error) { finish(error); throw error; }
  }, config.rpcTimeoutMs);
  const metrics = new MetricsStore(config.windowSeconds);
  const ui = new TerminalUi({ node: config.endpoint, windowSeconds: config.windowSeconds, transactionStatusClient: client,
    view: "txstatus", noColor: false, ascii: false, onQuit() { stop.abort(); }, onPauseToggle() {}, onReset() {} });
  const monitor = ui.txStatusMonitor;
  const observe = () => {
    if (cutoffMs !== undefined) return;
    for (const id of awaitingDisplay) {
      const entry = monitor.statusFor(id);
      if (["pending", "checking"].includes(entry.category)) continue;
      const tx = transactions.get(id);
      if (tx && tx.completedAtMs === undefined) Object.assign(tx, { completedAtMs: elapsed(), category: entry.category,
        reportedStatus: entry.status, reportedBlock: entry.blockNum });
      awaitingDisplay.delete(id);
    }
    const warning = monitor.diagnostic();
    if (warning !== lastWarning) { events.push({ atMs: elapsed(), kind: "status-diagnostic", message: warning ?? "cleared" }); lastWarning = warning; }
  };
  const draw = ui.draw.bind(ui);
  ui.draw = () => { observe(); draw(); };
  const sample = () => {
    observe();
    const cpu = process.cpuUsage(cpuStarted), memory = process.memoryUsage();
    samples.push({ atMs: elapsed(), cpuUserUs: cpu.user, cpuSystemUs: cpu.system, heapUsed: memory.heapUsed, rss: memory.rss,
      active, activeStatus, queued: monitor.queue.length, checking: monitor.checking.size, retained: monitor.retainedBlocks.size,
      unresolved: [...transactions.values()].filter(tx => tx.completedAtMs === undefined).length, outputBytes, writes });
  };
  const interrupt = () => { interrupted = true; followerAbort.abort(); stop.abort(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.stdout.write = chunk => { writes++; outputBytes += Buffer.byteLength(String(chunk)); return true; };
  for (const [key, value] of [["columns", 160], ["rows", 50]]) Object.defineProperty(process.stdout, key, { configurable: true, value });
  const endIntake = setTimeout(() => followerAbort.abort(), intakeMs);
  const sampling = setInterval(sample, 1000);
  const progress = quiet ? undefined : setInterval(() => {
    const at = elapsed(), measured = [...transactions.values()].filter(tx => typeof tx.cohort === "number");
    process.stderr.write(`${Math.round(at / 1000)}s ${phase(at)}: ${measured.filter(tx => tx.completedAtMs !== undefined).length}/${measured.length} measured transactions complete; queue ${monitor.queue.length}\n`);
  }, 30000);
  // Same draw/monitor timers as start(), without taking over stdin or painting a real terminal.
  ui.healthTimer = setInterval(() => ui.draw(), 1000);
  sample();
  try {
    const follower = new BlockFollower(client, { pollMs: config.pollMs, retryMs: Math.max(1000, config.pollMs) });
    for await (const event of follower.follow(followerAbort.signal)) {
      const at = elapsed();
      if (at >= intakeMs) break;
      if (event.type === "block") {
        const block = event.block;
        declaredTransactions += block.transactionCount;
        blocks.push({ atMs: at, number: block.number, timestamp: block.timestamp.toISOString(), transactions: block.transactionCount,
          transactionIds: block.transactions.length, lag: event.lag });
        for (const tx of block.transactions) {
          if (!transactions.has(tx.id)) transactions.set(tx.id, { id: tx.id, observedAtMs: at, cohort: phase(at),
            block: block.number, expiration: tx.expiration, operation: tx.primaryOperationType, attempts: 0 });
          else if (transactions.get(tx.id).block !== block.number) events.push({ atMs: at, kind: "reobserved-transaction", id: tx.id, block: block.number });
        }
        metrics.record(block);
      } else if (["retry", "gap"].includes(event.type)) events.push({ atMs: at, kind: event.type, message: event.message, block: event.blockNumber });
      ui.render(event, metrics.snapshot());
    }
    actualIntakeEndMs = elapsed();
    followerAbort.abort();
    if (!quiet) process.stderr.write("Intake ended; draining the existing status queue for the bounded interval.\n");
    await sleep(config.drainMs, undefined, { signal: stop.signal }).catch(error => { if (error.name !== "AbortError") throw error; });
    sample();
    cutoffMs = elapsed();
    const retained = new Set(monitor.displayBlocks().flatMap(block => block.transactions.map(tx => tx.id)));
    for (const tx of transactions.values()) if (tx.completedAtMs === undefined) tx.stateAtCutoff = monitor.checking.has(tx.id) ? "checking"
      : monitor.queued.has(tx.id) ? "queued" : retained.has(tx.id) ? "retained-not-queued" : "not-retained";
  } finally {
    followerAbort.abort();
    clearTimeout(endIntake);
    clearInterval(sampling);
    clearInterval(progress);
    ui.stop();
    for (let attempt = 0; active > 0 && attempt < 100; attempt++) await sleep(10);
    process.stdout.write = originalWrite;
    for (const [key, descriptor] of dimensions) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else delete process.stdout[key];
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  assert.equal(active, 0, "all requests must settle or abort at shutdown");
  const rows = [...transactions.values()], measured = rows.filter(tx => typeof tx.cohort === "number");
  const measuredRequests = requests.filter(request => request.atMs >= config.warmupMs && request.atMs < intakeMs);
  const windows = Array.from({ length: config.intervals }, (_, index) => {
    const from = config.warmupMs + index * config.intervalMs, to = from + config.intervalMs;
    const network = requests.filter(request => request.atMs >= from && request.atMs < to);
    return { window: index + 1, arrivalCohort: cohortSummary(rows.filter(tx => tx.cohort === index + 1), cutoffMs),
      requests: requestSummary(network), statusRequests: requestSummary(network.filter(request => request.method === statusMethod)),
      resources: resourceSummary(samples, from, to) };
  });
  const summary = cohortSummary(measured, cutoffMs);
  assert.equal(summary.offered, summary.completed + summary.unresolved);
  assert.equal(windows.reduce((sum, window) => sum + window.arrivalCohort.offered, 0), summary.offered);
  return { startedAt, endedAt: new Date().toISOString(), actualIntakeEndMs, cutoffMs, interrupted, config,
    summary, requestsSummary: requestSummary(measuredRequests), statusRequestsSummary: requestSummary(measuredRequests.filter(request => request.method === statusMethod)),
    resources: resourceSummary(samples, config.warmupMs, intakeMs), windows,
    declaredTransactions, uniqueObservedTransactions: rows.length, blocks, transactions: rows, requests, samples, events };
}

async function verify() {
  const summary = cohortSummary([{ observedAtMs: 0, completedAtMs: 100, category: "unknown" },
    { observedAtMs: 50, completedAtMs: 250, category: "irreversible" }, { observedAtMs: 100, stateAtCutoff: "not-retained" }], 1000);
  assert.equal(summary.coverage, 2 / 3);
  assert.equal(summary.latencyP95Ms, 200);
  assert.equal(summary.unresolvedMaxAgeMs, 900);
  assert.equal(summary.categories.unknown, 1);
  assert.equal(peakRate([{ atMs: 0, operations: 8 }, { atMs: 250, operations: 1 }, { atMs: 1000, operations: 4 }]), 2);
  const fixtureStarted = performance.now();
  const fakeFetch = async (_url, init) => {
    const call = JSON.parse(init.body);
    let result;
    if (call.method === "condenser_api.get_dynamic_global_properties") result = { head_block_number: 1000 + Math.floor((performance.now() - fixtureStarted) / 300), time: new Date().toISOString().slice(0, -1) };
    else if (call.method === "condenser_api.get_block") result = { timestamp: new Date().toISOString().slice(0, -1), witness: "alice",
      transaction_ids: [String(call.params[0])], transactions: [{ expiration: "2099-01-01T00:00:00", operations: [["vote", {}]] }] };
    else if (call.method === statusMethod) result = { status: "within_reversible_block", block_num: Number(call.params.transaction_id) };
    else if (call.method.endsWith("get_ops_in_block") || call.method.endsWith("get_witnesses_by_vote")) result = [];
    else if (call.method.endsWith("get_hardfork_version")) result = "1.0";
    else result = {};
    return { ok: true, status: 200, json: async () => ({ id: call.id, result }) };
  };
  const report = await capture({ ...defaults, warmupMs: 0, intervalMs: 500, intervals: 2, drainMs: 1500, pollMs: 100 }, fakeFetch, true);
  assert.ok(report.summary.offered > 0);
  assert.equal(report.summary.completed, report.summary.offered);
  assert.ok(report.statusRequestsSummary.httpRequests > 0);
  assert.equal(report.requestsSummary.httpOrTransportErrors, 0);
  console.log("Live capture accounting, request instrumentation, follower integration, and shutdown checks passed without network access.");
}

async function main() {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node >=24");
  const args = process.argv.slice(2);
  assert.ok(!args.length || (args.length === 1 && args[0] === "--verify") || (args.length === 2 && args[0] === "--output"),
    "Usage: node scripts/txstatus-live.mjs [--verify | --output result.json]");
  if (args[0] === "--verify") return verify();
  const environment = { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, loadavg: loadavg() };
  const paths = ["scripts/txstatus-live.mjs", "src/tui.ts", "src/rpc.ts", "src/follower.ts", "src/metrics.ts", "src/schedule.ts",
    "dist/tui.js", "dist/rpc.js", "dist/follower.js", "dist/metrics.js", "dist/schedule.js"];
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceDiff = execFileSync("git", ["diff", "--", "src", "dist"], { cwd: root, encoding: "utf8" });
  const output = resolve(args[0] === "--output" ? args[1] : `benchmarks/txstatus-live-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await access(output).then(() => { throw new Error(`Output already exists: ${output}`); }, error => { if (error.code !== "ENOENT") throw error; });
  process.stderr.write(`Live capture on ${defaults.endpoint}: 120s warmup, 7 × 60s measurement, 120s drain.\n`);
  const report = { schema: 1, environment, sourceCommit, sourceDiff, hashes, ...await capture(defaults),
    measurementNotes: "Monotonic-clock latency from first followed observation to displayable cached result, including checking dwell. Arrival cohorts include completions through the final cutoff; unresolved work stays in the denominator. Resource and request windows are wall-clock intervals and include requests for older cohorts. Pinned endpoint, normal production monitor/follower, 160x50 color transaction view, in-memory output sink. CPU and memory include instrumentation; terminal paint and TTY write costs are excluded. Drain stops the follower and lets the existing status queue run against its frozen final snapshot." };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(`Saved live baseline to ${output}`);
  console.log(JSON.stringify({ summary: report.summary, statusRequests: report.statusRequestsSummary, resources: report.resources }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
