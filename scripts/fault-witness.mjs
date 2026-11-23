import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, id] = process.argv.slice(2);
const { HiveRpcClient, WitnessScheduleReader } = await import(pathToFileURL(resolve(runtime, "dist/rpc.js")));
const { TransactionStatusMonitor } = await import(pathToFileURL(resolve(runtime, "dist/tui.js")));
const response = result => ({ ok: true, status: 200, async json() { return { result }; } });
const block = block_id => ({ block_id, previous: "00".repeat(20), timestamp: "2026-10-25T00:00:00", witness: "alice",
  transaction_merkle_root: "00".repeat(20), witness_signature: "00".repeat(65), transactions: [] });

async function witness() {
  if (id === "size-endpoint" || id === "size-identity") {
    let calls = 0;
    const client = new HiveRpcClient("https://one.test", async () => { calls++; return response(block("first")); });
    await client.getBlock(1);
    await client.getBlockSize(1, undefined, { endpoint: id === "size-endpoint" ? "https://two.test" : client.endpoint,
      blockId: id === "size-identity" ? "replacement" : "first" });
    assert.equal(calls, 2, "a different identity must refetch");
  } else if (id === "late-block") {
    const pending = [];
    const client = new HiveRpcClient("https://one.test", () => new Promise(resolve => pending.push(resolve)));
    const first = client.getBlock(1), second = client.getBlock(2);
    pending[1](response(block("new"))); await second;
    pending[0](response(block("old"))); await first;
    assert.equal(client.sizePayload.blockId, "new", "the last-started read owns the slot");
  } else if (id === "retention-order") {
    const monitor = new TransactionStatusMonitor({});
    try {
      for (let number = 301; number >= 1; number--) monitor.retainedBlocks.set(number, { number });
      monitor.trimRetainedBlocks();
      assert.equal(monitor.retainedBlocks.has(1), false, "evict oldest, not newest");
      assert.equal(monitor.retainedBlocks.has(301), true);
    } finally { monitor.stop(); }
  } else if (id === "batch-order") {
    const client = new HiveRpcClient("https://one.test", async (_url, init) => {
      const requests = JSON.parse(init.body);
      return { ok: true, status: 200, async json() { return requests.map((r, i) => ({ id: r.id, result: { status: "unknown", block_num: i + 10 } })).reverse(); } };
    });
    const results = await client.findTransactions([{ id: "first" }, { id: "second" }]);
    assert.deepEqual(results.map(r => r.block_num), [10, 11], "batch identities survive response reordering");
  } else if (id === "schedule-backoff") {
    let calls = 0;
    const client = { endpoint: "https://one.test", async getWitnessSchedule() { calls++; throw new Error("offline"); } };
    const reader = new WitnessScheduleReader();
    try {
      reader.refresh(client); await reader.pending;
      reader.refresh(client); await reader.pending;
      assert.equal(calls, 1, "errors retain the 30-second backoff");
    } finally { reader.stop(); }
  } else if (id === "cancelled-schedule") {
    let finish;
    const reader = new WitnessScheduleReader();
    reader.refresh({ endpoint: "https://one.test", getWitnessSchedule() { return new Promise(resolve => { finish = resolve; }); } });
    const pending = reader.pending;
    reader.stop(); finish({ current_shuffled_witnesses: ["late"] }); await pending;
    assert.equal(reader.schedule, undefined, "a cancelled refresh cannot publish its late response");
  } else if (id === "visible-retention") {
    const monitor = new TransactionStatusMonitor({}, 0);
    try {
      monitor.cache.set("settled", { category: "irreversible", glyph: "I" });
      monitor.sync({ blocks: [{ number: 1, transactions: [{ id: "settled" }] }] }, () => {});
      assert.deepEqual(monitor.displayBlocks().map(b => b.number), [1], "completed visible blocks remain displayed");
    } finally { monitor.stop(); }
  } else throw new Error(`Unknown witness ${id}`);
}

try { await witness(); }
catch (error) {
  console.error(error);
  process.exitCode = error instanceof assert.AssertionError ? 42 : 1;
}
