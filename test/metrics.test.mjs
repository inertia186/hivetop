import assert from "node:assert/strict";
import test from "node:test";
import { MetricsStore } from "../dist/metrics.js";

test("MetricsStore aggregates rates, operation types, and witnesses", () => {
  const store = new MetricsStore(10);
  const now = new Date("2026-06-16T20:00:10Z");

  store.record(block(1, "2026-06-16T20:00:05Z", "alice", 2, [["vote", 2]]), now);
  store.record(block(2, "2026-06-16T20:00:06Z", "bob", 1, [["comment", 1], ["vote", 1]]), now);

  const snapshot = store.snapshot(now);

  assert.equal(snapshot.blocks.length, 2);
  assert.equal(snapshot.blockRate, 0.2);
  assert.equal(snapshot.transactionRate, 0.3);
  assert.equal(snapshot.operationRate, 0.4);
  assert.equal(snapshot.virtualOperationRate, 0.5);
  assert.deepEqual(snapshot.operationTypes, [["vote", 3], ["comment", 1]]);
  assert.deepEqual(snapshot.witnesses, [["alice", 1], ["bob", 1]]);
});

test("MetricsStore evicts blocks outside the rolling window", () => {
  const store = new MetricsStore(5);
  const now = new Date("2026-06-16T20:00:10Z");

  store.record(block(1, "2026-06-16T20:00:04Z", "alice", 1, [["vote", 1]]), now);
  store.record(block(2, "2026-06-16T20:00:06Z", "bob", 1, [["vote", 1]]), now);

  const snapshot = store.snapshot(now);

  assert.deepEqual(snapshot.blocks.map((entry) => entry.number), [2]);
});

test("MetricsStore uses latest chain block time by default instead of local wall time", () => {
  const store = new MetricsStore(5);

  store.record(block(1, "2026-06-16T20:00:04Z", "alice", 1, [["vote", 1]]));
  store.record(block(2, "2026-06-16T20:00:06Z", "bob", 1, [["vote", 1]]));

  const snapshot = store.snapshot();

  assert.deepEqual(snapshot.blocks.map((entry) => entry.number), [2, 1]);
});

function block(number, timestamp, witness, transactionCount, operationTypes) {
  return {
    number,
    timestamp: new Date(timestamp),
    witness,
    transactionCount,
    operationCount: operationTypes.reduce((total, [, count]) => total + count, 0),
    virtualOperationCount: number === 1 ? 2 : 3,
    operationTypes: new Map(operationTypes),
  };
}
