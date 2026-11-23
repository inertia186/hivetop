import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// RPC bodies take a fixed 100 ms in this accounting model; no live traffic.
const baseline = resolve(process.argv[2]);
const output = process.argv[3];
const candidate = fileURLToPath(new URL("../", import.meta.url));
const cases = ["empty", "transactions", "headers", "large", "cold", "oversized"];
const fixture = name => ({
  block_id: "ab".repeat(20), previous: "00".repeat(20), timestamp: "2026-10-25T00:00:00", witness: "alice",
  transaction_merkle_root: "00".repeat(20), witness_signature: "00".repeat(65),
  extensions: name === "headers" ? [[0, {}], [1, "1.28.0"], [2, { hf_version: "1.28.0", hf_time: "2026-10-25T00:00:00" }]] : [],
  transactions: ["empty", "headers"].includes(name) ? [] : Array.from({ length: name === "transactions" ? 128 : 1 }, () => ({
    operations: [["custom_json", { json: name === "oversized" ? "x".repeat(600000) : name === "large" ? "x".repeat(500000) : "{}" }]], signatures: ["00".repeat(65)], extensions: [],
  })),
});

async function replay(runtime, name) {
  const { HiveRpcClient } = await import(pathToFileURL(resolve(runtime, "dist/rpc.js")));
  const block = fixture(name), requests = [];
  const client = new HiveRpcClient("https://fixture.test", async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request.method);
    const result = request.method === "condenser_api.get_block" ? structuredClone(block)
      : "00".repeat(10 + (request.params[0].operations.length < 128 ? 1 : 2) + 2 + request.params[0].operations.length * 2);
    return { ok: true, status: 200, async json() { return { result }; } };
  });
  const followTimes = [], sizes = [], additionalCalls = [];
  let retainedStringBytes = 0;
  const started = performance.now();
  // Cold traces need more samples: 100 complete measurements take under 1 ms.
  const count = name === "cold" ? 10000 : 100;
  for (let n = 1; n <= count; n++) {
    if (name !== "cold") {
      const at = performance.now();
      await client.getBlock(n);
      followTimes.push(performance.now() - at);
      const retained = client.sizePayload?.json.length * 2 || 0;
      retainedStringBytes = Math.max(retainedStringBytes, retained);
      assert.ok(retained <= 1048576);
    }
    const before = requests.length;
    sizes.push(await client.getBlockSize(n, undefined, { endpoint: client.endpoint, blockId: block.block_id }));
    additionalCalls.push(requests.length - before);
  }
  return { name, sizes, additionalCalls, totalCalls: requests.length, modeledSizeMs: additionalCalls.map(n => n * 100),
    elapsedMs: performance.now() - started, retainedStringBytes,
    followP95Ms: followTimes.length ? followTimes.sort((a, b) => a - b)[94] : 0 };
}

const report = { baseline, candidate, node: process.version, date: new Date().toISOString(),
  fixture: { modeledRpcMs: 100, pairs: 7, measurementsPerTrace: 100, coldMeasurementsPerTrace: 10000, maxRetainedStringBytes: 1048576, followerP95CeilingMs: 5 }, pairs: [] };
for (const name of cases) {
  await replay(baseline, name); await replay(candidate, name);
  for (let pair = 0; pair < 7; pair++) {
    const results = {};
    for (const [label, runtime] of pair % 2 ? [["candidate", candidate], ["baseline", baseline]] : [["baseline", baseline], ["candidate", candidate]]) {
      results[label] = await replay(runtime, name);
    }
    assert.deepEqual(results.candidate.sizes, results.baseline.sizes);
    const expected = name === "empty" || name === "headers" ? 1 : 2;
    assert.ok(results.baseline.additionalCalls.every(n => n === expected));
    const target = ["cold", "oversized"].includes(name) ? expected : expected - 1;
    assert.ok(results.candidate.additionalCalls.every(n => n === target));
    assert.ok(results.candidate.followP95Ms < 5);
    report.pairs.push({ name, pair, ...results });
  }
}
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
for (const name of cases) {
  const rows = report.pairs.filter(r => r.name === name);
  const median = values => values.sort((a, b) => a - b)[3];
  console.log(`${name}: extra calls ${rows[0].baseline.additionalCalls[0]} -> ${rows[0].candidate.additionalCalls[0]}, total calls ${rows[0].baseline.totalCalls} -> ${rows[0].candidate.totalCalls}; elapsed median ${median(rows.map(r => r.baseline.elapsedMs)).toFixed(2)} -> ${median(rows.map(r => r.candidate.elapsedMs)).toFixed(2)} ms; follow p95 ${median(rows.map(r => r.candidate.followP95Ms)).toFixed(3)} ms`);
}
