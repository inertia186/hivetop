import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  blockSizeChartLines,
  clampedScrollStart,
  formatFeedAge,
  formatMaintenanceCountdown,
  headerSummary,
  formatMissedBlockRows,
  formatMvests,
  formatParticipation,
  formatProducedStatusCell,
  formatProducedStatus,
  formatRankedWitness,
  formatRankedWitnessCell,
  formatRoundProducedStatus,
  formatTransactionStatusCell,
  formatTransactionStatusMap,
  justifiedCellWidths,
  mergeTransactionStatusEntries,
  mergeRetractingPredictions,
  rememberScheduleSignature,
  parseHiveUtcTime,
  priceFeedFreshness,
  propertyRows,
  revealPredictedRows,
  roundScheduleWarning,
  schedulePredictionsExpired,
  scrollingRoundRows,
  scheduledRoundRows,
  shouldPersistObservedRoundRow,
  splitReplacementPredictions,
  stabilizeObservedRoundRows,
  TerminalUi,
  TransactionStatusMonitor,
} from "../dist/tui.js";

test("headerSummary keeps normal live status stable", () => {
  assert.equal(
    headerSummary(
      {
        type: "status",
        headBlock: 101,
        nextBlock: 102,
        lag: 0,
        dynamicGlobalProperties: { head_block_number: 101, last_irreversible_block_num: 101, time: "2026-06-16T20:00:00" },
        witnessRanks: {},
        witnessFeedUpdates: {},
        witnessVersions: {},
        missedBlocks: [],
      },
      "txstatus",
    ),
    "view txstatus  |  head 101",
  );
});

test("block-size charts preserve time gaps and peaks, support filtering, and fit their row budget", () => {
  const blocks = [
    { ...blockRecord(4), timestamp: new Date("2026-10-06T00:00:12Z"), sizeBytes: 1024, witness: "bob" },
    { ...blockRecord(1), timestamp: new Date("2026-10-06T00:00:03Z"), sizeBytes: 256, witness: "alice" },
  ];
  const lines = blockSizeChartLines(blocks, 12, 10, 22);
  assert.equal(lines.length, 10);
  assert.equal(stripAnsi(lines[7]), "         |███      ███");
  assert.match(lines[1], /Latest 1.0 KiB \| Mean 640 B/);
  assert.match(lines[2], /Min 256 B \| Peak 1.0 KiB \| 2\/2 blocks/);
  const merged = blockSizeChartLines(blocks, 12, 10, 11, true);
  assert.equal(stripAnsi(merged[3]), " 1.0 KiB |#"); // One column keeps the larger sample.
  const filtered = blockSizeChartLines(blocks, 12, 10, 30, true, "alice");
  assert.match(filtered[1], /Latest 256 B \| Mean 256 B/);
  assert.match(filtered[9], /00:00:00.*00:00:12/); // Filtering keeps the same time axis.
  assert.equal(blockSizeChartLines(blocks, 12, 3, 22).length, 3);
  assert.match(blockSizeChartLines([], 12, 10, 22)[1], /Waiting/);
  const boundary = { ...blockRecord(0), timestamp: new Date("2026-10-06T00:00:00Z"), sizeBytes: 8192 };
  assert.ok(blockSizeChartLines([...blocks, boundary], 12, 10, 22)[3].endsWith(" ".repeat(12)));
  assert.equal(/[^\x00-\x7f]/.test(filtered.join("\n")), false);
  assert.match(lines[7], /\x1b\[38;5;252m██\x1b\[38;5;244m█/);
  const equalBlocks = [{ ...blocks[0], sizeBytes: 256 }, { ...blocks[1], timestamp: new Date("2026-10-06T00:00:09Z") }];
  const shaded = blockSizeChartLines(equalBlocks, 12, 10, 22);
  assert.match(shaded[7], /\x1b\[38;5;252m██\x1b\[38;5;244m█\x1b\[38;5;252m██\x1b\[38;5;244m█/);
  const plain = blockSizeChartLines(equalBlocks, 12, 10, 22, false, "", true);
  assert.deepEqual(shaded.map(stripAnsi), plain);
  assert.equal(plain.some((line) => line.includes("\x1b")), false);
  assert.equal(merged.some((line) => line.includes("38;5;244")), false);
});

test("size measurements run only in their view, cancel on leaving, cache results, and back off on errors", async () => {
  await sleep(1); // Let earlier test reports flush before intercepting terminal output.
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output = String(chunk); return true; };
  const requests = [];
  const ui = new TerminalUi({ node: "test", windowSeconds: 120, onQuit() {}, onPauseToggle() {}, onReset() {},
    transactionStatusClient: { getBlockSize(number, signal) {
      return new Promise((resolve, reject) => requests.push({ number, signal, resolve, reject }));
    } } });
  const block = { ...blockRecord(104), timestamp: new Date() };
  const event = { type: "block", block, headBlock: 104, lag: 0,
    dynamicGlobalProperties: { head_block_number: 104, time: block.timestamp.toISOString() },
    witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [] };
  const snapshot = { blocks: [block], blockRate: 0, transactionRate: 0, operationRate: 0, virtualOperationRate: 0, operationTypes: [], witnesses: [] };
  const openSizes = () => { ui.onKey("v"); ui.onKey("v"); ui.onKey("v"); };
  try {
    ui.render(event, snapshot);
    assert.equal(requests.length, 0);
    openSizes();
    assert.equal(requests.length, 1);
    ui.onKey("v");
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve(128);
    await sleep(1);
    assert.equal(block.sizeBytes, undefined);
    openSizes();
    requests[1].resolve(256);
    await sleep(1);
    assert.equal(block.sizeBytes, 256);
    ui.render(event, snapshot);
    assert.equal(requests.length, 2);
    assert.match(output, /Latest 256 B/);
    const newer = { ...blockRecord(105), timestamp: new Date() };
    ui.render({ ...event, block: newer }, { ...snapshot, blocks: [newer, block] });
    assert.equal(requests.length, 2); // Backfilling waits at least one second after success.
    ui.sizeRetryAt = 0;
    ui.render({ ...event, block: newer }, { ...snapshot, blocks: [newer, block] });
    requests[2].reject(new Error("Serialization API unavailable"));
    await sleep(1);
    assert.match(output, /Size RPC: Serialization API unavailable/);
    ui.render(event, { ...snapshot, blocks: [newer, block] });
    assert.equal(requests.length, 3);
    assert.equal(block.sizeBytes, 256);
    ui.sizeRetryAt = 0;
    ui.render(event, { ...snapshot, blocks: [newer, block] });
    assert.equal(requests.length, 4);
    ui.stop();
    assert.equal(requests[3].signal.aborted, true);
    const stoppedOutput = output;
    requests[3].resolve(512);
    await sleep(1);
    assert.equal(output, stoppedOutput);
  } finally { ui.stop(); process.stdout.write = originalWrite; }
});

test("headerSummary includes only useful deltas and issues", () => {
  assert.equal(
    headerSummary(
      {
        type: "gap",
        blockNumber: 100,
        retryInMs: 1000,
        dynamicGlobalProperties: { head_block_number: 105, last_irreversible_block_num: 103, time: "2026-06-16T20:00:00" },
        witnessRanks: {},
        witnessFeedUpdates: {},
        witnessVersions: {},
        missedBlocks: [],
      },
      "blocks",
    ),
    "view blocks  |  head 105  |  LIB 103  |  missing 100; retry 1000ms",
  );
});

test("propertyRows only shows LIB while it differs from Head", () => {
  const props = {
    head_block_number: 107,
    last_irreversible_block_num: 107,
    current_witness: "alice",
    time: "2026-06-16T22:45:00",
  };

  assert.equal(propertyRows(props).some(([label]) => label === "LIB"), false);
  assert.deepEqual(propertyRows({ ...props, last_irreversible_block_num: 106 }).find(([label]) => label === "LIB"), ["LIB", "106"]);
});

test("propertyRows expresses total vesting shares as MVESTS while keeping the source label", () => {
  const rows = propertyRows(
    {
      head_block_number: 107,
      last_irreversible_block_num: 107,
      total_vesting_shares: "456789012345.000000 VESTS",
      time: "2026-06-16T22:45:00",
    },
  );

  assert.deepEqual(rows.find(([label]) => label === "Vest Shares"), ["Vest Shares", "456,789.012 MVESTS"]);
});

test("formatMvests leaves non-VESTS values alone", () => {
  assert.equal(formatMvests("123.000 HIVE"), "123.000 HIVE");
  assert.equal(formatMvests(undefined), "-");
});

test("formatMaintenanceCountdown summarizes Hive UTC maintenance times", () => {
  assert.equal(formatMaintenanceCountdown("2026-06-16T21:02:03", "2026-06-16T20:00:00"), "1h2m");
  assert.equal(formatMaintenanceCountdown("2026-06-16T20:00:00", "2026-06-16T20:00:01"), "due");
  assert.equal(formatMaintenanceCountdown(undefined, "2026-06-16T20:00:00"), "-");
});

test("propertyRows expresses participation count as a percentage of 128", () => {
  const rows = propertyRows(
    {
      head_block_number: 107,
      participation_count: 127,
      time: "2026-06-16T22:45:00",
    },
  );

  assert.deepEqual(rows.find(([label]) => label === "Participation"), ["Participation", "99.22%"]);
});

test("formatParticipation handles full and missing participation", () => {
  assert.equal(formatParticipation(128), "100.00%");
  assert.equal(formatParticipation(undefined), "-");
});

test("formatRankedWitness prefixes witnesses with their vote rank", () => {
  const ranks = { alice: 1, bob: 2 };

  assert.equal(formatRankedWitness("alice", ranks), "#1 alice");
  assert.equal(formatRankedWitness("bob", ranks), "#2 bob");
  assert.equal(formatRankedWitness("carol", ranks), "#- carol");
});

test("priceFeedFreshness classifies witness feed update age", () => {
  const now = new Date("2026-06-16T12:00:00Z");

  assert.equal(priceFeedFreshness("2026-06-16T06:00:00", now), "fresh");
  assert.equal(priceFeedFreshness("2026-06-16T05:59:59", now), "stale");
  assert.equal(priceFeedFreshness("2026-06-15T12:00:00", now), "expired");
  assert.equal(priceFeedFreshness(undefined, now), "unknown");
});

test("parseHiveUtcTime treats naive Hive timestamps as UTC", () => {
  assert.equal(parseHiveUtcTime("2026-06-16T12:00:00")?.toISOString(), "2026-06-16T12:00:00.000Z");
  assert.equal(parseHiveUtcTime("2026-06-16T12:00:00Z")?.toISOString(), "2026-06-16T12:00:00.000Z");
  assert.equal(parseHiveUtcTime("not a date"), undefined);
});

test("formatRankedWitness colors witnesses by feed freshness", () => {
  const ranks = { fresh: 1, stale: 2, expired: 3 };
  const now = new Date("2026-06-16T12:00:00Z");

  assert.equal(formatRankedWitness("fresh", ranks, { fresh: "2026-06-16T06:00:00" }, now), "\x1b[1;32m#1 fresh\x1b[0m");
  assert.equal(formatRankedWitness("stale", ranks, { stale: "2026-06-16T05:59:59" }, now), "\x1b[1;33m#2 stale\x1b[0m");
  assert.equal(formatRankedWitness("expired", ranks, { expired: "2026-06-15T12:00:00" }, now), "\x1b[1;31m#3 expired\x1b[0m");
});

test("formatRankedWitness inverts witnesses on the majority version", () => {
  const ranks = { alice: 1, bob: 2 };
  const now = new Date("2026-06-16T12:00:00Z");

  assert.equal(formatRankedWitness("alice", ranks, {}, now, { alice: "1.28.3" }, "1.28.3"), "\x1b[1;7m#1 alice\x1b[0m");
  assert.equal(
    formatRankedWitness("bob", ranks, { bob: "2026-06-16T06:00:00" }, now, { bob: "1.28.3" }, "1.28.3"),
    "\x1b[1;32;7m#2 bob\x1b[0m",
  );
});

test("formatRankedWitnessCell styles the full padded witness column", () => {
  const now = new Date("2026-06-16T12:00:00Z");

  assert.equal(
    formatRankedWitnessCell("alice", { alice: 1 }, { alice: "2026-06-16T06:00:00" }, now, { alice: "1.28.3" }, "1.28.3", 12),
    "\x1b[1;32;7m#1 alice    \x1b[0m",
  );
});

test("formatProducedStatus summarizes produced row state", () => {
  assert.equal(formatProducedStatus({ blockNumber: 1, scheduledWitness: "alice" }), "-");
  assert.equal(formatProducedStatus({ blockNumber: 1, scheduledWitness: "settling", settling: true }), "?");
  assert.equal(formatProducedStatus({ blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" }), "√");
  assert.equal(formatProducedStatus({ blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" }), "x");
});

test("formatRoundProducedStatus spins only for the next predicted block", () => {
  assert.equal(formatRoundProducedStatus({ blockNumber: 11, scheduledWitness: "alice" }, 10, 0), "|");
  assert.equal(formatRoundProducedStatus({ blockNumber: 11, scheduledWitness: "alice" }, 10, 1), "/");
  assert.equal(formatRoundProducedStatus({ blockNumber: 12, scheduledWitness: "alice" }, 10, 0), "-");
  assert.equal(formatRoundProducedStatus({ blockNumber: 11, scheduledWitness: "alice", producedWitness: "alice" }, 10, 0), "√");
});

test("formatRoundProducedStatus treats unbacked mismatches as provisional", () => {
  assert.equal(formatRoundProducedStatus({ blockNumber: 11, scheduledWitness: "alice", producedWitness: "bob" }, 10, 0), "?");
  assert.equal(
    formatRoundProducedStatus(
      { blockNumber: 11, scheduledWitness: "alice", producedWitness: "bob" },
      10,
      0,
      [{ witness: "alice", detectedAtBlock: 11, detectedAt: "2026-06-17T14:57:15" }],
    ),
    "x",
  );
});

test("formatProducedStatusCell colors semantic status glyphs", () => {
  assert.equal(formatProducedStatusCell("√", 3), "\x1b[1;32m√  \x1b[0m");
  assert.equal(formatProducedStatusCell("x", 3), "\x1b[1;31mx  \x1b[0m");
  assert.equal(formatProducedStatusCell("?", 3), "\x1b[1;33m?  \x1b[0m");
  assert.equal(formatProducedStatusCell("-", 3), "-  ");
  assert.equal(formatProducedStatusCell("|", 3), "|  ");
});

test("formatTransactionStatusCell colors transaction status categories", () => {
  assert.equal(formatTransactionStatusCell({ category: "checking", glyph: "*" }), "\x1b[1;36m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "irreversible", glyph: "I" }), "\x1b[1;32m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "reversible", glyph: "R" }), "\x1b[1;37m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "pending", glyph: "." }), "\x1b[1;33m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "unknown", glyph: "?" }), "\x1b[1;33m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "old", glyph: "T" }), "\x1b[1;31m█\x1b[0m");
  assert.equal(formatTransactionStatusCell({ category: "mismatch", glyph: "!" }), "\x1b[1;31m█\x1b[0m");
});

test("justifiedCellWidths distributes available status map columns", () => {
  assert.deepEqual(justifiedCellWidths(3, 10), [4, 3, 3]);
  assert.deepEqual(justifiedCellWidths(4, 4), [1, 1, 1, 1]);
  assert.deepEqual(justifiedCellWidths(0, 10), []);
});

test("formatTransactionStatusMap stretches transaction cells to the requested width", () => {
  const block = blockRecord(101, [{ id: "tx-1" }, { id: "tx-2" }, { id: "tx-3" }]);
  const monitor = {
    statusFor(transactionId) {
      if (transactionId === "tx-1") return { category: "irreversible", glyph: "I" };
      if (transactionId === "tx-2") return { category: "reversible", glyph: "R" };
      return { category: "pending", glyph: "." };
    },
  };

  const rendered = formatTransactionStatusMap(block, monitor, 10);
  assert.equal(stripAnsi(rendered), "██████████");
  assert.equal(rendered, "\x1b[1;32m████\x1b[0m\x1b[1;37m███\x1b[0m\x1b[1;33m███\x1b[0m");
});

test("formatTransactionStatusMap buckets overflow transactions without a marker", () => {
  const block = blockRecord(101, Array.from({ length: 12 }, (_, index) => ({ id: `tx-${index}` })));
  const monitor = {
    statusFor(transactionId) {
      if (transactionId === "tx-5") return { category: "mismatch", glyph: "!" };
      return { category: "irreversible", glyph: "I" };
    },
  };
  const rendered = formatTransactionStatusMap(block, monitor, 4);

  assert.equal(stripAnsi(rendered), "████");
  assert.equal(rendered.includes("+"), false);
  assert.equal(rendered.includes("\x1b[1;31m█\x1b[0m"), true);
});

test("mergeTransactionStatusEntries keeps the most important bucket state", () => {
  assert.equal(
    mergeTransactionStatusEntries([
      { category: "irreversible", glyph: "I" },
      { category: "pending", glyph: "." },
      { category: "reversible", glyph: "R" },
    ]).category,
    "pending",
  );
  assert.equal(
    mergeTransactionStatusEntries([
      { category: "mismatch", glyph: "!" },
      { category: "checking", glyph: "*" },
    ]).category,
    "checking",
  );
});

test("TransactionStatusMonitor checks window transactions and caches results", async () => {
  const calls = [];
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId, expiration) {
        calls.push({ transactionId, expiration });
        return { status: "within_irreversible_block", block_num: 101 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );
  let redraws = 0;
  const snapshot = {
    blocks: [
      blockRecord(101, [
        { id: "tx-1", expiration: "2026-06-16T20:01:00" },
      ]),
    ],
  };

  monitor.sync(snapshot, () => {
    redraws += 1;
  });
  await sleep(0);
  monitor.sync(snapshot, () => {
    redraws += 1;
  });
  await sleep(0);

  assert.deepEqual(calls, [{ transactionId: "tx-1", expiration: "2026-06-16T20:01:00" }]);
  assert.deepEqual(monitor.statusFor("tx-1"), {
    category: "irreversible",
    glyph: "I",
    status: "within_irreversible_block",
    blockNum: 101,
  });
  assert.equal(redraws, 1);
  monitor.stop();
});

test("TransactionStatusMonitor marks in-flight transactions as checking", async () => {
  let resolveStatus;
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        await new Promise((resolve) => {
          resolveStatus = resolve;
        });
        return { status: "within_irreversible_block", block_num: 101 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );

  monitor.sync({ blocks: [blockRecord(101, [{ id: "tx-1", expiration: "2026-06-16T20:01:00" }])] }, () => {});
  assert.deepEqual(monitor.statusFor("tx-1"), { category: "checking", glyph: "*" });
  resolveStatus();
  await sleep(0);

  assert.equal(monitor.statusFor("tx-1").category, "irreversible");
  monitor.stop();
});

test("TransactionStatusMonitor keeps completed checks visually active for dwell time", async () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        return { status: "within_irreversible_block", block_num: 101 };
      },
    },
    1,
    500,
    0,
    300,
    5,
  );

  monitor.sync({ blocks: [blockRecord(101, [{ id: "tx-1", expiration: "2026-06-16T20:01:00" }])] }, () => {});
  await sleep(0);

  assert.equal(monitor.statusFor("tx-1").category, "checking");
  await sleep(10);
  assert.equal(monitor.statusFor("tx-1").category, "irreversible");
  monitor.stop();
});

test("TransactionStatusMonitor flags status block mismatches", async () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        return { status: "within_reversible_block", block_num: 999 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );

  monitor.sync({ blocks: [blockRecord(101, [{ id: "tx-1" }])] }, () => {});
  await sleep(0);

  assert.equal(monitor.statusFor("tx-1").category, "mismatch");
  assert.equal(monitor.statusFor("tx-1").glyph, "!");
  monitor.stop();
});

test("TransactionStatusMonitor checks transactions by declared expiration order", async () => {
  const calls = [];
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        calls.push(transactionId);
        await sleep(0);
        return { status: "within_reversible_block", block_num: transactionId === "newer-earliest" ? 102 : 101 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );

  monitor.sync(
    {
      blocks: [
        blockRecord(102, [
          { id: "newer-later", expiration: "2026-06-16T20:05:00" },
          { id: "newer-earliest", expiration: "2026-06-16T20:01:00" },
        ]),
        blockRecord(101, [
          { id: "older-middle", expiration: "2026-06-16T20:03:00" },
        ]),
      ],
    },
    () => {},
  );
  await sleep(0);
  await sleep(0);
  await sleep(0);
  await sleep(0);

  assert.deepEqual(calls, ["newer-earliest", "older-middle", "newer-later"]);
  monitor.stop();
});

test("TransactionStatusMonitor groups work without batching while the visible window is current", async () => {
  const singles = [];
  const batches = [];
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        singles.push(transactionId);
        return { status: "within_reversible_block", block_num: transactionId === "vote-1" || transactionId === "vote-2" ? 101 : 102 };
      },
      async findTransactions(transactions) {
        batches.push(transactions.map((transaction) => transaction.id));
        return transactions.map((transaction) => ({
          status: "within_reversible_block",
          block_num: transaction.id === "vote-1" || transaction.id === "vote-2" ? 101 : 102,
        }));
      },
    },
    1,
    500,
    0,
    300,
    0,
    8,
  );

  monitor.sync(
    {
      blocks: [
        blockRecord(102, [{ id: "custom-1", expiration: "2026-06-16T20:01:00", primaryOperationType: "custom_json" }]),
        blockRecord(101, [
          { id: "vote-1", expiration: "2026-06-16T20:05:00", primaryOperationType: "vote" },
          { id: "vote-2", expiration: "2026-06-16T20:06:00", primaryOperationType: "vote" },
        ]),
      ],
    },
    () => {},
  );
  await sleep(0);
  await sleep(0);

  assert.deepEqual(batches, []);
  assert.deepEqual(singles.slice(0, 2), ["vote-1", "vote-2"]);
  monitor.stop();
});

test("TransactionStatusMonitor uses batch only after retained blocks fall behind the visible window", { timeout: 1000 }, async (context) => {
  const batches = [];
  let batchReady;
  const batched = new Promise((resolve) => { batchReady = resolve; });
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        return { status: "within_reversible_block", block_num: transactionId.startsWith("vote-") ? 101 : 102 };
      },
      async findTransactions(transactions) {
        batches.push(transactions.map((transaction) => transaction.id));
        batchReady();
        return transactions.map((transaction) => ({
          status: "within_reversible_block",
          block_num: transaction.id.startsWith("vote-") ? 101 : 102,
        }));
      },
    },
    2,
    500,
    1,
    300,
    0,
    8,
  );
  context.after(() => monitor.stop());

  monitor.sync(
    {
      blocks: [
        blockRecord(101, [
          { id: "vote-1", expiration: "2026-06-16T20:05:00", primaryOperationType: "vote" },
          { id: "vote-2", expiration: "2026-06-16T20:06:00", primaryOperationType: "vote" },
          { id: "vote-3", expiration: "2026-06-16T20:07:00", primaryOperationType: "vote" },
        ]),
      ],
    },
    () => {},
  );
  monitor.sync({ blocks: [blockRecord(102, [])] }, () => {});
  await batched;

  assert.deepEqual(batches[0], ["vote-2", "vote-3"]);
});

test("TransactionStatusMonitor falls back to single requests when escalated batch is unsupported", async () => {
  const singles = [];
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        singles.push(transactionId);
        return { status: "within_reversible_block", block_num: 101 };
      },
      async findTransactions() {
        throw new Error("batch unsupported");
      },
    },
    2,
    500,
    1,
    300,
    0,
    8,
  );

  monitor.sync(
    {
      blocks: [
        blockRecord(101, [
          { id: "tx-1", expiration: "2026-06-16T20:01:00", primaryOperationType: "vote" },
          { id: "tx-2", expiration: "2026-06-16T20:02:00", primaryOperationType: "vote" },
          { id: "tx-3", expiration: "2026-06-16T20:03:00", primaryOperationType: "vote" },
        ]),
      ],
    },
    () => {},
  );
  monitor.sync({ blocks: [blockRecord(102, [])] }, () => {});
  await waitFor(() => singles.length === 3 && monitor.diagnostic());

  assert.deepEqual(singles, ["tx-1", "tx-2", "tx-3"]);
  assert.match(monitor.diagnostic(), /batch unsupported/);
  monitor.stop();
});

test("TransactionStatusMonitor stops batching after retained offscreen work completes", async () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        return { status: "within_reversible_block", block_num: transactionId.startsWith("tx-") ? 101 : 102 };
      },
      async findTransactions(transactions) {
        return transactions.map((transaction) => ({
          status: "within_reversible_block",
          block_num: transaction.id.startsWith("tx-") ? 101 : 102,
        }));
      },
    },
    2,
    500,
    1,
    300,
    0,
    8,
  );

  monitor.sync(
    {
      blocks: [
        blockRecord(101, [
          { id: "tx-1", expiration: "2026-06-16T20:01:00", primaryOperationType: "vote" },
          { id: "tx-2", expiration: "2026-06-16T20:02:00", primaryOperationType: "vote" },
          { id: "tx-3", expiration: "2026-06-16T20:03:00", primaryOperationType: "vote" },
        ]),
      ],
    },
    () => {},
  );
  monitor.sync({ blocks: [blockRecord(102, [])] }, () => {});

  assert.match(monitor.budgetLine(), /batch\/s/);
  await sleep(5);

  assert.match(monitor.budgetLine(), /request\/s/);
  monitor.stop();
});

test("TransactionStatusMonitor keeps evicted pending blocks visible", async () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        await new Promise(() => {});
        return { status: "within_reversible_block", block_num: 101 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );

  monitor.sync({ blocks: [blockRecord(101, [{ id: "tx-1", expiration: "2026-06-16T20:01:00" }])] }, () => {});
  monitor.sync({ blocks: [blockRecord(102, [])] }, () => {});

  assert.deepEqual(monitor.displayBlocks().map((block) => block.number), [102, 101]);
  monitor.stop();
});

test("TransactionStatusMonitor drops evicted blocks after their transactions are checked", async () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        return { status: "within_reversible_block", block_num: 101 };
      },
    },
    1,
    500,
    0,
    300,
    0,
  );

  monitor.sync({ blocks: [blockRecord(101, [{ id: "tx-1", expiration: "2026-06-16T20:01:00" }])] }, () => {});
  await sleep(0);
  monitor.sync({ blocks: [blockRecord(102, [])] }, () => {});

  assert.deepEqual(monitor.displayBlocks().map((block) => block.number), [102]);
  monitor.stop();
});

test("TransactionStatusMonitor requeues transactions dropped by the queue cap", async () => {
  const calls = [];
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction(transactionId) {
        calls.push(transactionId);
        return { status: "within_reversible_block", block_num: 101 };
      },
    },
    1,
    1,
    0,
    300,
    0,
  );
  const snapshot = {
    blocks: [
      blockRecord(101, [
        { id: "tx-1", expiration: "2026-06-16T20:01:00" },
        { id: "tx-2", expiration: "2026-06-16T20:02:00" },
      ]),
    ],
  };

  monitor.sync(snapshot, () => {});
  await sleep(0);
  monitor.sync(snapshot, () => {});
  await sleep(0);

  assert.deepEqual(calls, ["tx-1", "tx-2"]);
  monitor.stop();
});

test("TransactionStatusMonitor exposes RPC budget and backlog", () => {
  const monitor = new TransactionStatusMonitor(
    {
      async findTransaction() {
        return { status: "within_reversible_block", block_num: 101 };
      },
    },
    4,
    500,
    250,
    300,
    0,
  );

  monitor.sync(
    {
      blocks: [
        blockRecord(101, [
          { id: "tx-1", expiration: "2026-06-16T20:01:00" },
          { id: "tx-2", expiration: "2026-06-16T20:02:00" },
          { id: "tx-3", expiration: "2026-06-16T20:03:00" },
        ]),
      ],
    },
    () => {},
  );

  assert.match(monitor.budgetLine(), /^status RPC budget 4 request\/s  backlog [123](  group [^ ]+:\d+)?  eta 1s$/);
  monitor.stop();
});

test("roundScheduleWarning highlights unverifiable schedule entries", () => {
  assert.equal(roundScheduleWarning([{ blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" }]), undefined);
  assert.equal(
    roundScheduleWarning([{ blockNumber: 1, scheduledWitness: "settling", settling: true }]),
    "schedule settling: waiting for a verifiable schedule fit",
  );
  assert.equal(
    roundScheduleWarning([{ blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" }]),
    "schedule provisional: unmatched witness has no producer_missed evidence",
  );
  assert.equal(
    roundScheduleWarning(
      [{ blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" }],
      [],
      [{ witness: "alice", detectedAtBlock: 1, detectedAt: "2026-06-17T14:57:15" }],
    ),
    "missed block: alice missed, bob produced",
  );
  assert.equal(
    roundScheduleWarning(
      [{ blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" }],
      [{ blockNumber: 1, scheduledWitness: "bob", producedWitness: "bob" }],
      [{ witness: "alice", detectedAtBlock: 1, detectedAt: "2026-06-17T14:57:15" }],
    ),
    "missed block: alice missed, bob produced",
  );
  assert.equal(
    roundScheduleWarning([
      { blockNumber: 1, scheduledWitness: "settling", settling: true },
      { blockNumber: 2, scheduledWitness: "alice", producedWitness: "bob" },
    ], [], [{ witness: "alice", detectedAtBlock: 2, detectedAt: "2026-06-17T14:57:15" }]),
    "missed block: alice missed, bob produced",
  );
});

test("stabilizeObservedRoundRows preserves produced row interpretation", () => {
  const rows = [
    { blockNumber: 1, scheduledWitness: "new-alice", producedWitness: "alice" },
    { blockNumber: 2, scheduledWitness: "new-bob" },
  ];
  const observed = new Map([[1, { blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" }]]);

  assert.deepEqual(stabilizeObservedRoundRows(rows, observed), [
    { blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" },
    { blockNumber: 2, scheduledWitness: "new-bob" },
  ]);
});

test("stabilizeObservedRoundRows lets current matching rows replace old observed mismatches", () => {
  const rows = [{ blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" }];
  const observed = new Map([[1, { blockNumber: 1, scheduledWitness: "bob", producedWitness: "alice" }]]);

  assert.deepEqual(stabilizeObservedRoundRows(rows, observed), [
    { blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" },
  ]);
});

test("shouldPersistObservedRoundRow does not pin unbacked transient mismatches", () => {
  assert.equal(
    shouldPersistObservedRoundRow({ blockNumber: 1, scheduledWitness: "alice", producedWitness: "alice" }, []),
    true,
  );
  assert.equal(
    shouldPersistObservedRoundRow({ blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" }, []),
    false,
  );
  assert.equal(
    shouldPersistObservedRoundRow(
      { blockNumber: 1, scheduledWitness: "alice", producedWitness: "bob" },
      [{ witness: "alice", detectedAtBlock: 1, detectedAt: "2026-06-17T14:57:15" }],
    ),
    true,
  );
});

test("scrollingRoundRows orders predicted and recent rows newest first", () => {
  const observed = new Map([
    [100, { blockNumber: 100, scheduledWitness: "old-a", producedWitness: "old-a" }],
    [101, { blockNumber: 101, scheduledWitness: "old-b", producedWitness: "old-b" }],
    [102, { blockNumber: 102, scheduledWitness: "too-old", producedWitness: "too-old" }],
  ]);
  const rows = scrollingRoundRows(
    [
      { blockNumber: 103, scheduledWitness: "new-a", producedWitness: "new-a" },
      { blockNumber: 104, scheduledWitness: "new-b" },
      { blockNumber: 105, scheduledWitness: "new-c" },
    ],
    observed,
    103,
  );

  assert.deepEqual(rows.map((row) => row.blockNumber), [105, 104, 103, 102, 101, 100]);
});

test("revealPredictedRows accumulates future scheduled rows nearest to head first", () => {
  const rows = [
    { blockNumber: 105, scheduledWitness: "future-c" },
    { blockNumber: 104, scheduledWitness: "future-b" },
    { blockNumber: 103, scheduledWitness: "future-a" },
    { blockNumber: 102, scheduledWitness: "current", producedWitness: "current" },
    { blockNumber: 101, scheduledWitness: "past", producedWitness: "past" },
  ];

  assert.deepEqual(revealPredictedRows(rows, 102, 0).map((row) => row.blockNumber), [102, 101]);
  assert.deepEqual(revealPredictedRows(rows, 102, 1).map((row) => row.blockNumber), [103, 102, 101]);
  assert.deepEqual(revealPredictedRows(rows, 102, 2).map((row) => row.blockNumber), [104, 103, 102, 101]);
  assert.deepEqual(revealPredictedRows(rows, 102, 3).map((row) => row.blockNumber), [105, 104, 103, 102, 101]);
});

test("mergeRetractingPredictions keeps stale future rows visible while they retract", () => {
  const rows = [
    { blockNumber: 103, scheduledWitness: "new-a" },
    { blockNumber: 102, scheduledWitness: "current", producedWitness: "current" },
  ];
  const merged = mergeRetractingPredictions(rows, [
    { blockNumber: 104, scheduledWitness: "old-b" },
    { blockNumber: 103, scheduledWitness: "old-a" },
  ], 102);

  assert.deepEqual(merged, [
    { blockNumber: 104, scheduledWitness: "old-b" },
    { blockNumber: 103, scheduledWitness: "new-a" },
    { blockNumber: 102, scheduledWitness: "current", producedWitness: "current" },
  ]);
});

test("mergeRetractingPredictions cannot overwrite newly produced rows", () => {
  const rows = [
    { blockNumber: 103, scheduledWitness: "new-a", producedWitness: "new-a" },
    { blockNumber: 102, scheduledWitness: "current", producedWitness: "current" },
  ];
  const merged = mergeRetractingPredictions(rows, [
    { blockNumber: 104, scheduledWitness: "old-b" },
    { blockNumber: 103, scheduledWitness: "old-a" },
  ], 103);

  assert.deepEqual(merged, [
    { blockNumber: 104, scheduledWitness: "old-b" },
    { blockNumber: 103, scheduledWitness: "new-a", producedWitness: "new-a" },
    { blockNumber: 102, scheduledWitness: "current", producedWitness: "current" },
  ]);
});

test("splitReplacementPredictions carries exact matching predicted rows into a replacement schedule", () => {
  const replacement = splitReplacementPredictions(
    [
      { blockNumber: 105, scheduledWitness: "old-c" },
      { blockNumber: 104, scheduledWitness: "same-b" },
      { blockNumber: 103, scheduledWitness: "old-a" },
    ],
    [
      { blockNumber: 103, scheduledWitness: "new-a" },
      { blockNumber: 104, scheduledWitness: "same-b" },
      { blockNumber: 105, scheduledWitness: "new-c" },
    ],
  );

  assert.equal(replacement.revealedCount, 2);
  assert.deepEqual(replacement.retractingRows, [
    { blockNumber: 105, scheduledWitness: "old-c" },
    { blockNumber: 103, scheduledWitness: "old-a" },
  ]);
});

test("schedulePredictionsExpired suppresses future predictions after the shuffle boundary", () => {
  const schedule = { current_shuffled_witnesses: ["alice", "bob", "carol"], next_shuffle_block_num: 105 };

  assert.equal(schedulePredictionsExpired(schedule, 104), false);
  assert.equal(schedulePredictionsExpired(schedule, 105), true);
  assert.equal(schedulePredictionsExpired(schedule, 106), true);
  assert.equal(schedulePredictionsExpired({ current_shuffled_witnesses: ["alice"] }, 106), false);
  const announced = { ...schedule, future_shuffled_witnesses: ["dan", "erin", "frank"] };
  assert.equal(schedulePredictionsExpired(announced, 105), false);
  assert.equal(schedulePredictionsExpired(announced, 107), false);
  assert.equal(schedulePredictionsExpired(announced, 108), true);
});

test("TerminalUi previews the announced round and promotes it without waiting for three blocks", () => {
  const oldSchedule = {
    current_shuffled_witnesses: ["alice", "bob", "carol"],
    future_shuffled_witnesses: ["dan", "erin", "frank"], next_shuffle_block_num: 3,
  };
  const newSchedule = {
    current_shuffled_witnesses: oldSchedule.future_shuffled_witnesses,
    future_shuffled_witnesses: ["gin", "hana", "ian"], next_shuffle_block_num: 6,
  };
  const ui = new TerminalUi({ node: "test", windowSeconds: 120, onQuit() {}, onPauseToggle() {}, onReset() {} });
  ui.view = "round";
  const originalWrite = process.stdout.write;
  let rendered = "";
  process.stdout.write = (chunk) => { rendered = stripAnsi(String(chunk)); return true; };
  const render = (schedule, head, slot, witness, propsHead = head, propsSlot = slot) => ui.render(
    {
      type: "block", block: { ...blockRecord(head), witness }, headBlock: propsHead, lag: propsHead - head,
      dynamicGlobalProperties: {
        head_block_number: propsHead, current_aslot: propsSlot,
        time: new Date(blockRecord(head).timestamp.getTime() + (propsSlot - slot) * 3000).toISOString(),
      },
      witnessSchedule: schedule, witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [],
    },
    { blocks: [{ ...blockRecord(head), witness }], blockRate: 0, transactionRate: 0, operationRate: 0, virtualOperationRate: 0, operationTypes: [], witnesses: [] },
  );
  const preview = () => ui.predictedRowPool.filter((row) => row.blockNumber <= 6)
    .map((row) => [row.blockNumber, row.scheduledWitness]);
  try {
    render(oldSchedule, 2, 5, "carol");
    assert.deepEqual(preview(), [[3, "alice"], [4, "erin"], [5, "frank"]]);
    assert.ok(rendered.includes("Current round 1-3 (2/3) | > current"));
    assert.match(rendered, /^> 2\s/m);
    ui.revealedFutureRows = ui.futureRevealTarget;
    ui.draw();
    assert.match(rendered, /^> 3\s/m, "unproduced blocks in the current round are marked");
    assert.match(rendered, /^  4\s/m, "next-round predictions are not marked as current");
    render(newSchedule, 3, 6, "alice");
    assert.ok(rendered.includes("Current round 1-3 (3/3) | > current"));
    assert.equal(ui.displayedRoundSchedule, oldSchedule, "boundary block uses the old order");
    assert.deepEqual(preview(), [[4, "erin"], [5, "frank"], [6, "dan"]]);
    render(newSchedule, 4, 7, "erin", 5, 8);
    assert.ok(rendered.includes("Current round 4-6 (1/3) | > current"), "round follows displayed blocks during follower lag");
    assert.match(rendered, /^> 4\s/m);
    assert.equal(ui.displayedRoundSchedule, newSchedule, "announced order needs no extra matching blocks");
    assert.deepEqual(preview(), [[5, "frank"], [6, "dan"]]);
    render(oldSchedule, 4, 7, "erin");
    assert.equal(ui.displayedRoundSchedule, newSchedule, "stale response cannot roll the schedule back");
    assert.deepEqual(preview(), [[5, "frank"], [6, "dan"]]);
  } finally {
    ui.stop();
    process.stdout.write = originalWrite;
  }
});

test("scheduledRoundRows uses block boundaries and absolute slots across missed production", () => {
  const schedule = {
    current_shuffled_witnesses: ["alice", "bob", "carol"],
    future_shuffled_witnesses: ["dan", "erin", "frank"], next_shuffle_block_num: 105,
  };
  const rows = scheduledRoundRows(104, schedule, [{ ...blockRecord(104), witness: "carol" }],
    [{ witness: "bob", detectedAtBlock: 104 }], { headSlot: 110 });
  assert.deepEqual(rows.map((row) => [row.blockNumber, row.scheduledWitness]),
    [[103, "alice"], [104, "bob"], [105, "alice"], [106, "erin"], [107, "frank"]]);
  assert.equal(rows.find((row) => row.blockNumber === 104).producedWitness, "carol");
});

test("TerminalUi validates replacements and duplicate extensions against the new round", () => {
  const block = (number, witness) => ({ ...blockRecord(number), witness });
  const oldBlocks = [block(102, "carol"), block(101, "bob"), block(100, "alice")];
  const scenarios = [
    {
      current: ["dan", "erin", "frank"],
      candidate: ["alice", "bob", "carol"],
      confirmed: ["alice", "carol", "bob"],
      newBlocks: [block(104, "carol"), block(103, "alice")],
      nextBlock: block(105, "bob"),
    },
    {
      current: ["alice", "bob", "carol"],
      candidate: ["alice", "bob", "carol"],
      confirmed: ["bob", "alice", "carol"],
      newBlocks: [block(104, "alice"), block(103, "bob")],
      nextBlock: block(105, "carol"),
    },
  ];
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (const scenario of scenarios) {
      const ui = new TerminalUi({ node: "test", windowSeconds: 120, onQuit() {}, onPauseToggle() {}, onReset() {} });
      const current = { current_shuffled_witnesses: scenario.current, next_shuffle_block_num: 102 };
      const candidate = { current_shuffled_witnesses: scenario.candidate, next_shuffle_block_num: 105 };
      const confirmed = { current_shuffled_witnesses: scenario.confirmed, next_shuffle_block_num: 105 };
      const render = (schedule, blocks) => ui.render(
        {
          type: "status", headBlock: blocks[0].number, nextBlock: blocks[0].number + 1, lag: 0,
          dynamicGlobalProperties: { head_block_number: blocks[0].number, time: "2026-06-16T20:00:00" },
          witnessSchedule: schedule, witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [],
        },
        { blocks, blockRate: 0, transactionRate: 0, operationRate: 0, virtualOperationRate: 0, operationTypes: [], witnesses: [] },
      );
      try {
        render(current, oldBlocks);
        render(candidate, [...scenario.newBlocks, ...oldBlocks]);
        assert.equal(ui.displayedRoundSchedule, current, "old blocks must not validate a new round");
        render(confirmed, [scenario.nextBlock, ...scenario.newBlocks, ...oldBlocks]);
        assert.equal(ui.displayedRoundSchedule, confirmed, "three new-round matches should validate the replacement");
        render(current, [scenario.nextBlock, ...scenario.newBlocks, ...oldBlocks]);
        assert.equal(ui.displayedRoundSchedule, confirmed, "a previous schedule must not replace the confirmed schedule");
      } finally {
        ui.stop();
      }
    }
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("rememberScheduleSignature keeps only recent accepted schedules", () => {
  const history = new Map();

  rememberScheduleSignature(history, "old", 100, 2);
  rememberScheduleSignature(history, "current", 121, 2);
  rememberScheduleSignature(history, "old", 122, 2);
  rememberScheduleSignature(history, "next", 143, 2);

  assert.deepEqual([...history.entries()], [
    ["old", 122],
    ["next", 143],
  ]);
  assert.equal(history.has("current"), false);
});

test("clampedScrollStart prevents manual scroll from running past drawable round rows", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ blockNumber: 100 + index, scheduledWitness: `w${index}` }));

  assert.equal(clampedScrollStart(rows, -5, 8), 0);
  assert.equal(clampedScrollStart(rows, 6, 8), 6);
  assert.equal(clampedScrollStart(rows, 999, 8), 13);
});

test("scheduledRoundRows derives the current block round and fills produced witnesses", () => {
  const rows = scheduledRoundRows(
    104,
    { current_shuffled_witnesses: ["alice", "bob", "carol"], next_shuffle_block_num: 105 },
    [
      { number: 103, witness: "alice", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 104, witness: "bob", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
  );

  assert.deepEqual(rows, [
    { blockNumber: 103, scheduledWitness: "alice", producedWitness: "alice" },
    { blockNumber: 104, scheduledWitness: "bob", producedWitness: "bob" },
    { blockNumber: 105, scheduledWitness: "carol", producedWitness: undefined },
  ]);
});

test("scheduledRoundRows jumps ahead if called with a node head beyond produced blocks", () => {
  const schedule = { current_shuffled_witnesses: ["alice", "bob", "carol"], next_shuffle_block_num: 105 };
  const blocks = [
    { number: 103, witness: "alice", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    { number: 104, witness: "bob", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
  ];

  assert.deepEqual(scheduledRoundRows(104, schedule, blocks).map((row) => row.blockNumber), [103, 104, 105]);
  assert.deepEqual(scheduledRoundRows(106, schedule, blocks).map((row) => row.blockNumber), [106, 107, 108]);
});

test("scheduledRoundRows marks the replacement producer as mismatched on a missed block", () => {
  const rows = scheduledRoundRows(
    104,
    { current_shuffled_witnesses: ["alice", "bob", "carol"], next_shuffle_block_num: 105 },
    [
      { number: 103, witness: "carol", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 104, witness: "bob", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
    [{ witness: "alice", detectedAtBlock: 104, detectedAt: "2026-06-16T20:00:06" }],
  );

  assert.equal(rows.find((row) => row.blockNumber === 104)?.scheduledWitness, "alice");
  assert.equal(rows.find((row) => row.blockNumber === 104)?.producedWitness, "bob");
  assert.equal(formatProducedStatus(rows.find((row) => row.blockNumber === 104)), "x");
});

test("scheduledRoundRows settles instead of showing a schedule with only old matches", () => {
  const rows = scheduledRoundRows(
    130,
    { current_shuffled_witnesses: ["alice", "bob", "carol"], next_shuffle_block_num: 105 },
    [
      { number: 100, witness: "alice", timestamp: new Date("2026-06-16T20:00:00Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 101, witness: "bob", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 102, witness: "carol", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
  );

  assert.deepEqual(rows, [{ blockNumber: 130, scheduledWitness: "settling", producedWitness: undefined, settling: true }]);
});

test("scheduledRoundRows uses one active schedule instead of old segments", () => {
  const rows = scheduledRoundRows(
    104,
    { current_shuffled_witnesses: ["new-alice", "new-bob", "new-carol"] },
    [
      { number: 103, witness: "alice", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 104, witness: "new-bob", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
  );

  assert.deepEqual(rows, [
    { blockNumber: 103, scheduledWitness: "new-alice", producedWitness: "alice" },
    { blockNumber: 104, scheduledWitness: "new-bob", producedWitness: "new-bob" },
    { blockNumber: 105, scheduledWitness: "new-carol", producedWitness: undefined },
  ]);
});

test("scheduledRoundRows does not splice stale schedule rows into the active round", () => {
  const rows = scheduledRoundRows(
    920,
    { current_shuffled_witnesses: ["new-a", "new-b", "new-c", "new-d", "new-e", "new-f", "new-g", "new-h", "new-i", "new-j", "new-k", "new-l", "new-m", "new-n", "new-o", "new-p", "new-q", "new-r", "new-s", "new-t", "new-u"] },
    [
      { number: 917, witness: "old-r", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 918, witness: "new-s", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
  );

  assert.equal(rows.find((row) => row.blockNumber === 917)?.scheduledWitness, "new-r");
  assert.equal(rows.find((row) => row.blockNumber === 918)?.scheduledWitness, "new-s");
});

test("scheduledRoundRows can ignore blocks from a previous schedule generation", () => {
  const rows = scheduledRoundRows(
    203,
    { current_shuffled_witnesses: ["new-a", "new-b", "new-c"] },
    [
      { number: 203, witness: "new-a", timestamp: new Date("2026-06-16T20:00:09Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 202, witness: "old-c", timestamp: new Date("2026-06-16T20:00:06Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 201, witness: "old-b", timestamp: new Date("2026-06-16T20:00:03Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
      { number: 200, witness: "old-a", timestamp: new Date("2026-06-16T20:00:00Z"), transactionCount: 0, operationCount: 0, virtualOperationCount: 0, operationTypes: new Map() },
    ],
    [],
    { minBlockNumber: 203 },
  );

  assert.deepEqual(rows, [
    { blockNumber: 203, scheduledWitness: "new-a", producedWitness: "new-a" },
    { blockNumber: 204, scheduledWitness: "new-b", producedWitness: undefined },
    { blockNumber: 205, scheduledWitness: "new-c", producedWitness: undefined },
  ]);
});

test("formatFeedAge summarizes UTC feed age", () => {
  const now = new Date("2026-06-16T12:00:00Z");

  assert.equal(formatFeedAge("2026-06-16T11:45:00", now), "15m");
  assert.equal(formatFeedAge("2026-06-16T05:30:00", now), "6h30");
  assert.equal(formatFeedAge("2026-06-15T12:00:00", now), "24h+");
  assert.equal(formatFeedAge(undefined, now), "-");
});

test("formatMissedBlockRows shows missed block and witness", () => {
  const rows = formatMissedBlockRows([
    {
      witness: "alice",
      detectedAtBlock: 101,
      detectedAt: "2026-06-16T20:00:06",
    },
  ]);

  assert.deepEqual(rows, ["@101 alice"]);
});

function blockRecord(number, transactions = []) {
  return {
    number,
    timestamp: new Date("2026-06-16T20:00:00Z"),
    witness: "alice",
    transactionCount: transactions.length,
    transactions,
    operationCount: 0,
    virtualOperationCount: 0,
    operationTypes: new Map(),
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(0);
  }
}

test("terminal controls filter witnesses, inspect blocks, and preserve event history", () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output = stripAnsi(String(chunk)); return true; };
  let node = "https://one.test";
  let quit = false;
  const ui = new TerminalUi({ node: () => node, windowSeconds: 120, noColor: true, onQuit() { quit = true; }, onPauseToggle() {}, onReset() {} });
  const now = new Date();
  const blocks = [
    { ...blockRecord(11), timestamp: now, witness: "bob" },
    { ...blockRecord(10, [{ id: "transaction-abc", primaryOperationType: "vote" }]), timestamp: now, operationCount: 2, operationTypes: new Map([["vote", 2]]) },
  ];
  const snapshot = { blocks, blockRate: 0.3, transactionRate: 1, operationRate: 2, virtualOperationRate: 0, operationTypes: [], witnesses: [] };
  const event = { type: "block", block: blocks[0], headBlock: 11, lag: 0, dynamicGlobalProperties: { head_block_number: 11, time: now.toISOString() }, witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [] };
  try {
    ui.render(event, snapshot);
    assert.match(output, /LIVE \| block/);
    ui.onKey("/"); ui.onKey("alice"); ui.onKey("\r");
    assert.match(output, /Witness filter: alice/);
    assert.deepEqual(ui.tableBlockNumbers, [10]);
    ui.onKey("\u001b[B"); ui.onKey("\r");
    assert.match(output, /BLOCK 10 \(Esc returns/);
    assert.match(output, /vote: 2/);
    assert.match(output, /transaction-abc/);
    ui.onKey("\u001b"); ui.onKey("\u001b");
    assert.deepEqual(ui.tableBlockNumbers, [11, 10]);
    ui.onKey("?"); assert.match(output, /HELP \/ LEGENDS/); ui.onKey("\u001b");
    ui.lastDataReceivedAt = Date.now() - 16000;
    ui.draw();
    assert.match(output, /STALE \| block/);
    assert.match(output, /cached blk\/s/);
    ui.render({ ...event, type: "retry", message: "offline", retryInMs: 1000 }, snapshot);
    assert.match(output, /RECONNECTING/);
    node = "https://two.test";
    ui.render({ ...event, missedBlocks: [{ detectedAtBlock: 11, witness: "carol", detectedAt: now.toISOString() }] }, snapshot);
    assert.match(output, /LIVE \| block/);
    ui.onKey("e");
    assert.match(output, /Missed block 11: carol/);
    assert.match(output, /Node switched:/);
    assert.match(output, /RPC interrupted: offline/);
    ui.onKey("q"); assert.equal(quit, true);
  } finally { ui.stop(); process.stdout.write = originalWrite; }
});

test("ASCII/NO_COLOR views fit small terminals and keep status distinctions", () => {
  const originalWrite = process.stdout.write;
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const oldRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  let output = "";
  process.stdout.write = (chunk) => { output = String(chunk); return true; };
  try {
    for (const [columns, rows] of [[48, 18], [80, 24], [160, 50]]) {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
      for (const view of ["blocks", "round", "txstatus", "sizes"]) {
        const ui = new TerminalUi({ node: "test", windowSeconds: 120, view, ascii: true, noColor: true, onQuit() {}, onPauseToggle() {}, onReset() {}, transactionStatusClient: { async findTransaction() { return { status: "within_irreversible_block" }; } } });
        const block = { ...blockRecord(104, [{ id: "tx1" }, { id: "tx2" }]), timestamp: new Date(), witness: "bob", sizeBytes: 512 };
        try {
          ui.render({ type: "block", block, headBlock: 104, lag: 0, dynamicGlobalProperties: { head_block_number: 104, current_aslot: 103, time: block.timestamp.toISOString() }, witnessSchedule: { current_shuffled_witnesses: ["alice", "bob", "carol"], future_shuffled_witnesses: ["dan", "erin", "frank"], next_shuffle_block_num: 105 }, witnessRanks: {}, witnessFeedUpdates: {}, witnessVersions: {}, missedBlocks: [] },
            { blocks: [block], blockRate: 0.3, transactionRate: 1, operationRate: 2, virtualOperationRate: 0, operationTypes: [], witnesses: [] });
          const text = stripAnsi(output);
          assert.equal(/[^\x00-\x7f]/.test(text), false);
          assert.equal(/\x1b\[[0-9;]*m/.test(output), false);
          assert.ok(text.split("\n").length <= rows);
          assert.ok(text.split("\n").every((line) => line.length <= columns));
          assert.match(text, /q quit/);
          if (view === "round") assert.match(text, /104\s/);
        } finally { ui.stop(); }
      }
    }
    assert.equal(stripAnsi(formatTransactionStatusCell({ category: "irreversible", glyph: "I" }, 3, true)), "III");
    assert.equal(stripAnsi(formatTransactionStatusCell({ category: "reversible", glyph: "R" }, 2, true)), "RR");
  } finally {
    process.stdout.write = originalWrite;
    if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns); else delete process.stdout.columns;
    if (oldRows) Object.defineProperty(process.stdout, "rows", oldRows); else delete process.stdout.rows;
  }
});

test("transaction RPC timeouts retry and stopping the monitor cancels requests", async () => {
  let calls = 0;
  let signal;
  const monitor = new TransactionStatusMonitor({
    async findTransaction(id, expiration, requestSignal) {
      signal = requestSignal;
      if (++calls === 1) throw new Error("RPC timeout for transaction_status_api.find_transaction");
      return { status: "within_irreversible_block", block_num: 10 };
    },
  }, 1, 500, 1, 300, 0);
  try {
    monitor.sync({ blocks: [blockRecord(10, [{ id: "tx" }])] }, () => {});
    await waitFor(() => monitor.diagnostic()?.includes("retryable error"));
    assert.equal(monitor.statusFor("tx").category, "pending");
    await waitFor(() => monitor.statusFor("tx").category === "irreversible", 2000);
    assert.equal(calls, 2);
    assert.equal(monitor.diagnostic(), undefined);
  } finally { monitor.stop(); }
  assert.equal(signal.aborted, true);
});
