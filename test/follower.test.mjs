import assert from "node:assert/strict";
import test from "node:test";
import {
  BlockFollower,
  majorityHighestVersion,
  missedBlocksFromVirtualOperations,
  scheduleRound,
  summarizeRcStats,
  toBlockRecord,
  witnessFeedUpdatesByVote,
  witnessRanksByVote,
  witnessVersionsByVote,
} from "../dist/follower.js";

test("toBlockRecord counts transactions and operation types", () => {
  const record = toBlockRecord(
    42,
    {
      timestamp: "2026-06-16T20:00:00",
      witness: "alice",
      transaction_ids: ["tx-a", "tx-b"],
      transactions: [
        { expiration: "2026-06-16T20:01:00", operations: [["vote", {}], ["comment", {}]] },
        { expiration: "2026-06-16T20:02:00", operations: [["vote", {}]] },
      ],
    },
    5,
  );

  assert.equal(record.number, 42);
  assert.equal(record.witness, "alice");
  assert.equal(record.transactionCount, 2);
  assert.deepEqual(record.transactions, [
    { id: "tx-a", expiration: "2026-06-16T20:01:00", primaryOperationType: "vote" },
    { id: "tx-b", expiration: "2026-06-16T20:02:00", primaryOperationType: "vote" },
  ]);
  assert.equal(record.operationCount, 3);
  assert.equal(record.virtualOperationCount, 5);
  assert.equal(record.operationTypes.get("vote"), 2);
  assert.equal(record.operationTypes.get("comment"), 1);
});

test("BlockFollower starts from an explicit block and follows sequentially", async () => {
  let hardforkVersionCalls = 0;
  const client = {
    async getDynamicGlobalProperties() {
      return { head_block_number: 11, time: "2026-06-16T20:00:00" };
    },
    async getBlock(blockNumber) {
      return {
        timestamp: "2026-06-16T20:00:00",
        witness: `witness-${blockNumber}`,
        transactions: [],
      };
    },
    async getVirtualOperationsInBlock(blockNumber) {
      return Array.from({ length: blockNumber - 9 }, () => ({ op: ["producer_reward", {}] }));
    },
    async getHardforkVersion() {
      hardforkVersionCalls += 1;
      return "1.28.0";
    },
    async getNextScheduledHardfork() {
      return { hf_version: "1.29.0", live_time: "2026-07-01T00:00:00" };
    },
    async getWitnessSchedule() {
      return { current_shuffled_witnesses: ["alice", "bob", "carol"], num_scheduled_witnesses: 3 };
    },
    async getWitnessesByVote() {
      return [
        { owner: "witness-10", last_hbd_exchange_update: "2026-06-16T19:00:00", running_version: "1.28.3" },
        { owner: "witness-11", last_hbd_exchange_update: "2026-06-16T18:00:00", running_version: "1.28.3" },
      ];
    },
    async getRcStats() {
      return rcStatsResponse();
    },
  };
  const abort = new AbortController();
  const follower = new BlockFollower(client, { startBlock: 10, pollMs: 1, retryMs: 1, hardforkRefreshMs: 60_000 });
  const events = [];

  for await (const event of follower.follow(abort.signal)) {
    events.push(event);
    if (events.length === 2) abort.abort();
  }

  assert.deepEqual(events.map((event) => event.type), ["block", "block"]);
  assert.deepEqual(events.map((event) => event.block.number), [10, 11]);
  assert.deepEqual(events.map((event) => event.block.virtualOperationCount), [1, 2]);
  assert.deepEqual(events.map((event) => event.dynamicGlobalProperties.head_block_number), [11, 11]);
  assert.deepEqual(events.map((event) => event.hardforkInfo.currentVersion), ["1.28.0", "1.28.0"]);
  assert.deepEqual(events.map((event) => event.rcInfo.topOperation), ["custom_json_operation", "custom_json_operation"]);
  assert.deepEqual(events.map((event) => event.witnessRanks), [{ "witness-10": 1, "witness-11": 2 }, { "witness-10": 1, "witness-11": 2 }]);
  assert.deepEqual(events.map((event) => event.witnessFeedUpdates), [
    { "witness-10": "2026-06-16T19:00:00", "witness-11": "2026-06-16T18:00:00" },
    { "witness-10": "2026-06-16T19:00:00", "witness-11": "2026-06-16T18:00:00" },
  ]);
  assert.deepEqual(events.map((event) => event.witnessVersions), [{ "witness-10": "1.28.3", "witness-11": "1.28.3" }, { "witness-10": "1.28.3", "witness-11": "1.28.3" }]);
  assert.deepEqual(events.map((event) => event.majorityWitnessVersion), ["1.28.3", "1.28.3"]);
  assert.deepEqual(events.map((event) => event.missedBlocks), [[], []]);
  assert.equal(hardforkVersionCalls, 1);
});

test("witnessRanksByVote derives HiveHub-style ranks from get_witnesses_by_vote order", () => {
  assert.deepEqual(witnessRanksByVote([{ owner: "alice" }, { owner: "bob" }, { owner: "" }, {}]), { alice: 1, bob: 2 });
});

test("scheduleRound derives round number from head block and scheduled witness count", () => {
  assert.equal(scheduleRound(101, { current_shuffled_witnesses: ["alice", "bob", "carol"] }), 33);
  assert.equal(scheduleRound(102, { current_shuffled_witnesses: ["alice", "bob", "carol"] }), 34);
  assert.equal(scheduleRound(undefined, { current_shuffled_witnesses: ["alice"] }), undefined);
});

test("BlockFollower replaces witness schedule when head block enters a new schedule round", async () => {
  const props = [
    { head_block_number: 101, time: "2026-06-16T20:00:00" },
    { head_block_number: 102, time: "2026-06-16T20:00:03" },
  ];
  let scheduleCalls = 0;
  const client = {
    async getDynamicGlobalProperties() {
      return props.shift() ?? { head_block_number: 102, time: "2026-06-16T20:00:03" };
    },
    async getBlock(blockNumber) {
      return { timestamp: "2026-06-16T20:00:00", witness: `witness-${blockNumber}`, transactions: [] };
    },
    async getVirtualOperationsInBlock() {
      return [];
    },
    async getHardforkVersion() {
      return "1.28.0";
    },
    async getNextScheduledHardfork() {
      return {};
    },
    async getWitnessSchedule() {
      scheduleCalls += 1;
      return scheduleCalls === 1
        ? { current_shuffled_witnesses: ["alice", "bob", "carol"], num_scheduled_witnesses: 3 }
        : { current_shuffled_witnesses: ["dan", "erin", "frank"], num_scheduled_witnesses: 3 };
    },
    async getWitnessesByVote() {
      return [];
    },
    async getRcStats() {
      return rcStatsResponse();
    },
  };
  const abort = new AbortController();
  const follower = new BlockFollower(client, { pollMs: 1, retryMs: 1, witnessScheduleRefreshMs: 60_000 });
  const events = [];

  for await (const event of follower.follow(abort.signal)) {
    events.push(event);
    if (events.length === 2) abort.abort();
  }

  assert.equal(scheduleCalls, 2);
  assert.deepEqual(events.map((event) => event.witnessSchedule.current_shuffled_witnesses), [
    ["alice", "bob", "carol"],
    ["dan", "erin", "frank"],
  ]);
});

test("BlockFollower flags schedule drift when current schedule does not match prior future schedule", async () => {
  const props = [
    { head_block_number: 101, time: "2026-06-16T20:00:00" },
    { head_block_number: 102, time: "2026-06-16T20:00:03" },
  ];
  let scheduleCalls = 0;
  const client = {
    async getDynamicGlobalProperties() {
      return props.shift() ?? { head_block_number: 102, time: "2026-06-16T20:00:03" };
    },
    async getBlock(blockNumber) {
      return { timestamp: "2026-06-16T20:00:00", witness: `witness-${blockNumber}`, transactions: [] };
    },
    async getVirtualOperationsInBlock() {
      return [];
    },
    async getHardforkVersion() {
      return "1.28.0";
    },
    async getNextScheduledHardfork() {
      return {};
    },
    async getWitnessSchedule() {
      scheduleCalls += 1;
      return scheduleCalls === 1
        ? {
            current_shuffled_witnesses: ["alice", "bob", "carol"],
            future_shuffled_witnesses: ["dan", "erin", "frank"],
            num_scheduled_witnesses: 3,
            rpcEndpoint: "https://api.hive.blog",
            rpcRequestId: "request-1",
          }
        : {
            current_shuffled_witnesses: ["grace", "heidi", "ivan"],
            future_shuffled_witnesses: ["judy", "mallory", "oscar"],
            num_scheduled_witnesses: 3,
            rpcEndpoint: "https://api.hive.blog",
            rpcRequestId: "request-2",
          };
    },
    async getWitnessesByVote() {
      return [];
    },
    async getRcStats() {
      return rcStatsResponse();
    },
  };
  const abort = new AbortController();
  const follower = new BlockFollower(client, { pollMs: 1, retryMs: 1, witnessScheduleRefreshMs: 60_000 });
  const events = [];

  for await (const event of follower.follow(abort.signal)) {
    events.push(event);
    if (events.length === 2) abort.abort();
  }

  assert.equal(events[0].scheduleDiagnostics, undefined);
  assert.equal(events[1].scheduleDiagnostics.kind, "possible_rpc_backend_drift");
  assert.equal(events[1].scheduleDiagnostics.endpoint, "https://api.hive.blog");
  assert.equal(events[1].scheduleDiagnostics.previousRequestId, "request-1");
  assert.equal(events[1].scheduleDiagnostics.requestId, "request-2");
});

test("witnessFeedUpdatesByVote maps feed update times by witness owner", () => {
  assert.deepEqual(
    witnessFeedUpdatesByVote([
      { owner: "alice", last_hbd_exchange_update: "2026-06-16T19:00:00" },
      { owner: "bob" },
      { owner: "", last_hbd_exchange_update: "2026-06-16T18:00:00" },
    ]),
    { alice: "2026-06-16T19:00:00" },
  );
});

test("witnessVersionsByVote maps running versions by witness owner", () => {
  assert.deepEqual(
    witnessVersionsByVote([
      { owner: "alice", running_version: "1.28.3" },
      { owner: "bob" },
      { owner: "", running_version: "1.28.4" },
    ]),
    { alice: "1.28.3" },
  );
});

test("majorityHighestVersion chooses the mode with highest-version tie break", () => {
  assert.equal(majorityHighestVersion(["1.28.2", "1.28.3", "1.28.3", "1.28.4"]), "1.28.3");
  assert.equal(majorityHighestVersion(["1.28.2", "1.28.3"]), "1.28.3");
  assert.equal(majorityHighestVersion([]), undefined);
});

test("summarizeRcStats derives pressure signals", () => {
  const summary = summarizeRcStats(rcStatsResponse().rc_stats);

  assert.equal(summary.voteCost, 96_105_296);
  assert.equal(summary.commentCost, 1_105_471_966);
  assert.equal(summary.transferCost, 181_731_991);
  assert.equal(summary.lowRcUnder5, 1_386);
  assert.equal(summary.lowRcUnder20, 4_261);
  assert.equal(summary.cantAffordVote, 838);
  assert.equal(summary.cantAffordComment, 1_442);
  assert.equal(summary.topOperation, "custom_json_operation");
});

test("missedBlocksFromVirtualOperations reports chain-emitted producer misses", () => {
  const missed = missedBlocksFromVirtualOperations(123, "2026-06-16T20:00:06", [
    { op: ["producer_reward", { producer: "alice" }] },
    { op: ["producer_missed", { producer: "bob" }] },
    { op: ["producer_missed_operation", { owner: "carol" }] },
  ]);

  assert.deepEqual(missed, [
    {
      witness: "bob",
      detectedAtBlock: 123,
      detectedAt: "2026-06-16T20:00:06",
    },
    {
      witness: "carol",
      detectedAtBlock: 123,
      detectedAt: "2026-06-16T20:00:06",
    },
  ]);
});

test("BlockFollower reports missed witnesses from virtual operations", async () => {
  const client = {
    async getDynamicGlobalProperties() {
      return { head_block_number: 10, time: "2026-06-16T20:00:06" };
    },
    async getBlock() {
      return { timestamp: "2026-06-16T20:00:06", witness: "alice", transactions: [] };
    },
    async getVirtualOperationsInBlock() {
      return [{ op: ["producer_missed", { producer: "bob" }] }];
    },
    async getHardforkVersion() {
      return "1.28.0";
    },
    async getNextScheduledHardfork() {
      return {};
    },
    async getWitnessSchedule() {
      return { current_shuffled_witnesses: ["alice", "bob", "carol"], num_scheduled_witnesses: 3 };
    },
    async getWitnessesByVote() {
      return [];
    },
    async getRcStats() {
      return rcStatsResponse();
    },
  };
  const abort = new AbortController();
  const follower = new BlockFollower(client, { startBlock: 10, pollMs: 1, retryMs: 1 });
  const iterator = follower.follow(abort.signal);
  const result = await iterator.next();
  abort.abort();

  assert.equal(result.value.type, "block");
  assert.deepEqual(result.value.missedBlocks, [
    {
      witness: "bob",
      detectedAtBlock: 10,
      detectedAt: "2026-06-16T20:00:06",
    },
  ]);
});

test("BlockFollower reports a gap when a block is null", async () => {
  const client = {
    async getDynamicGlobalProperties() {
      return { head_block_number: 10, time: "2026-06-16T20:00:00" };
    },
    async getBlock() {
      return null;
    },
    async getVirtualOperationsInBlock() {
      return [];
    },
    async getHardforkVersion() {
      return "1.28.0";
    },
    async getNextScheduledHardfork() {
      return { hf_version: "1.29.0", live_time: "2026-07-01T00:00:00" };
    },
    async getWitnessSchedule() {
      return { current_shuffled_witnesses: ["alice", "bob", "carol"], num_scheduled_witnesses: 3 };
    },
    async getWitnessesByVote() {
      return [{ owner: "alice", last_hbd_exchange_update: "2026-06-16T19:00:00", running_version: "1.28.3" }];
    },
    async getRcStats() {
      return rcStatsResponse();
    },
  };
  const abort = new AbortController();
  const follower = new BlockFollower(client, { startBlock: 10, pollMs: 1, retryMs: 1 });
  const iterator = follower.follow(abort.signal);
  const result = await iterator.next();
  abort.abort();

  assert.equal(result.value.type, "gap");
  assert.equal(result.value.blockNumber, 10);
  assert.equal(result.value.dynamicGlobalProperties.head_block_number, 10);
  assert.equal(result.value.hardforkInfo.nextVersion, "1.29.0");
  assert.equal(result.value.rcInfo.lowRcUnder20, 4_261);
  assert.deepEqual(result.value.witnessRanks, { alice: 1 });
  assert.deepEqual(result.value.witnessFeedUpdates, { alice: "2026-06-16T19:00:00" });
  assert.deepEqual(result.value.witnessVersions, { alice: "1.28.3" });
  assert.equal(result.value.majorityWitnessVersion, "1.28.3");
  assert.deepEqual(result.value.missedBlocks, []);
});

test("BlockFollower exits without yielding retry events after abort", async () => {
  const abort = new AbortController();
  const client = {
    async getDynamicGlobalProperties() {
      abort.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    async getBlock() {
      throw new Error("should not fetch block");
    },
    async getVirtualOperationsInBlock() {
      throw new Error("should not fetch virtual ops");
    },
    async getHardforkVersion() {
      throw new Error("should not fetch hardfork version");
    },
    async getNextScheduledHardfork() {
      throw new Error("should not fetch next hardfork");
    },
    async getWitnessSchedule() {
      throw new Error("should not fetch witness schedule");
    },
    async getWitnessesByVote() {
      throw new Error("should not fetch witnesses by vote");
    },
    async getRcStats() {
      throw new Error("should not fetch rc stats");
    },
  };
  const follower = new BlockFollower(client, { pollMs: 1, retryMs: 1 });
  const iterator = follower.follow(abort.signal);
  const result = await iterator.next();

  assert.equal(result.done, true);
});

function rcStatsResponse() {
  return {
    rc_stats: {
      vote: 96_105_296,
      comment: 1_105_471_966,
      transfer: 181_731_991,
      ops: {
        vote_operation: { count: 183_016, avg_cost: 97_679_642 },
        custom_json_operation: { count: 268_746, avg_cost: 165_896_767 },
      },
      payers: [
        {
          rank: 0,
          count: 10_582,
          lt5: 474,
          lt20: 679,
          cant_afford: { vote: 379, comment: 678, transfer: 442 },
        },
        {
          rank: 1,
          count: 54_381,
          lt5: 912,
          lt20: 3_582,
          cant_afford: { vote: 459, comment: 764, transfer: 531 },
        },
      ],
    },
  };
}
