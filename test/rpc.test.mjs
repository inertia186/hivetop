import assert from "node:assert/strict";
import test from "node:test";
import { FailoverHiveRpcClient, HiveRpcClient, HiveRpcError, withStableEndpoint } from "../dist/rpc.js";

test("HiveRpcClient sends condenser_api.get_block requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: { timestamp: "2026-06-16T20:00:00", witness: "alice", transactions: [] } });
  });

  const block = await client.getBlock(123);

  assert.equal(block.witness, "alice");
  assert.equal(requests[0].method, "condenser_api.get_block");
  assert.deepEqual(requests[0].params, [123]);
});

test("HiveRpcClient sends virtual operation requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: [{ op: ["producer_reward", {}] }] });
  });

  const ops = await client.getVirtualOperationsInBlock(123);

  assert.equal(ops.length, 1);
  assert.equal(requests[0].method, "condenser_api.get_ops_in_block");
  assert.deepEqual(requests[0].params, [123, true]);
});

test("block sizes include envelopes and signatures while serializing operations in one request", async () => {
  const block = { previous: "00".repeat(20), timestamp: "2026-10-06T00:00:00", witness: "alice",
    transaction_merkle_root: "00".repeat(20), witness_signature: "00".repeat(65), extensions: [], transactions: [] };
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (request.method === "condenser_api.get_block") return response({ result: block });
    const ops = request.params[0].operations;
    const countBytes = ops.length < 128 ? 1 : 2;
    return response({ result: "00".repeat(10 + countBytes + 2 + ops.length * 2) });
  });
  assert.equal(await client.getBlockSize(1), 117);
  assert.equal(requests.length, 1); // Empty blocks need no serialization RPC.
  block.extensions = [[0, {}], [1, "1.28.0"], [2, { hf_version: "1.28.0", hf_time: "2026-10-06T00:00:00" }]];
  block.transactions = Array.from({ length: 128 }, () => ({ operations: [["vote", {}]], signatures: ["00".repeat(65)], extensions: [] }));
  assert.equal(await client.getBlockSize(2), 117 + 15 + 1 + 128 * (13 + 65 + 2));
  assert.equal(requests[2].method, "condenser_api.get_transaction_hex");
  assert.equal(requests[2].params[0].operations.length, 128);
  assert.deepEqual(requests[2].params[0].signatures, []);
  block.witness = "é".repeat(64); // UTF-8 string byte length crosses the varuint boundary.
  block.transactions = [];
  block.extensions = [];
  assert.equal(await client.getBlockSize(3), 117 - 5 + 128 + 1);
  block.extensions = [[3, {}]];
  await assert.rejects(client.getBlockSize(4), /Unsupported block header extension/);
});

test("HiveRpcClient sends hardfork version requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: "1.28.0" });
  });

  const version = await client.getHardforkVersion();

  assert.equal(version, "1.28.0");
  assert.equal(requests[0].method, "condenser_api.get_hardfork_version");
  assert.deepEqual(requests[0].params, []);
});

test("HiveRpcClient sends next scheduled hardfork requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: { hf_version: "1.29.0", live_time: "2026-07-01T00:00:00" } });
  });

  const next = await client.getNextScheduledHardfork();

  assert.equal(next.hf_version, "1.29.0");
  assert.equal(requests[0].method, "condenser_api.get_next_scheduled_hardfork");
  assert.deepEqual(requests[0].params, []);
});

test("HiveRpcClient sends witness schedule requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: { current_shuffled_witnesses: ["alice", "bob"], num_scheduled_witnesses: 2 } });
  });

  const schedule = await client.getWitnessSchedule();

  assert.deepEqual(schedule.current_shuffled_witnesses, ["alice", "bob"]);
  assert.equal(requests[0].method, "condenser_api.get_witness_schedule");
  assert.deepEqual(requests[0].params, []);
});

test("HiveRpcClient can request future witness schedule data", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({
      result: {
        current_shuffled_witnesses: ["alice", "bob"],
        future_shuffled_witnesses: ["carol", "dan"],
        num_scheduled_witnesses: 2,
      },
    });
  });

  const schedule = await client.getWitnessSchedule(undefined, true);

  assert.deepEqual(schedule.future_shuffled_witnesses, ["carol", "dan"]);
  assert.equal(requests[0].method, "condenser_api.get_witness_schedule");
  assert.deepEqual(requests[0].params, [true]);
});

test("HiveRpcClient annotates witness schedules with RPC source metadata", async () => {
  const client = new HiveRpcClient("https://example.test", async () =>
    response(
      {
        result: {
          current_shuffled_witnesses: ["alice", "bob"],
          num_scheduled_witnesses: 2,
        },
      },
      true,
      200,
      {
        "x-request-id": "request-123",
        "x-jussi-param-hash": "hash-456",
      },
    ),
  );

  const schedule = await client.getWitnessSchedule(undefined, true);

  assert.equal(schedule.rpcEndpoint, "https://example.test");
  assert.equal(schedule.rpcRequestId, "request-123");
  assert.equal(schedule.rpcParamHash, "hash-456");
  assert.match(schedule.rpcFetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("HiveRpcClient sends witnesses-by-vote requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: [{ owner: "alice" }, { owner: "bob" }] });
  });

  const witnesses = await client.getWitnessesByVote("", 250);

  assert.deepEqual(witnesses.map((witness) => witness.owner), ["alice", "bob"]);
  assert.equal(requests[0].method, "condenser_api.get_witnesses_by_vote");
  assert.deepEqual(requests[0].params, ["", 250]);
});

test("HiveRpcClient sends RC stats requests with object params", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: { rc_stats: { vote: 1, comment: 2, transfer: 3 } } });
  });

  const stats = await client.getRcStats();

  assert.equal(stats.rc_stats.vote, 1);
  assert.equal(requests[0].method, "rc_api.get_rc_stats");
  assert.deepEqual(requests[0].params, {});
});

test("HiveRpcClient sends transaction status requests with object params", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ result: { status: "within_reversible_block", block_num: 123, rc_cost: 456 } });
  });

  const status = await client.findTransaction("abc123", "2026-06-16T20:01:00");

  assert.equal(status.status, "within_reversible_block");
  assert.equal(status.block_num, 123);
  assert.equal(status.rc_cost, 456);
  assert.equal(requests[0].method, "transaction_status_api.find_transaction");
  assert.deepEqual(requests[0].params, { transaction_id: "abc123", expiration: "2026-06-16T20:01:00" });
});

test("HiveRpcClient sends batched transaction status requests", async () => {
  const requests = [];
  const client = new HiveRpcClient("https://example.test", async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return response(
      request.map((item, index) => ({
        id: item.id,
        result: { status: index === 0 ? "within_reversible_block" : "within_irreversible_block", block_num: 123 + index },
      })),
    );
  });

  const statuses = await client.findTransactions([
    { id: "abc123", expiration: "2026-06-16T20:01:00" },
    { id: "def456" },
  ]);

  assert.deepEqual(statuses.map((status) => status.status), ["within_reversible_block", "within_irreversible_block"]);
  assert.equal(requests[0][0].method, "transaction_status_api.find_transaction");
  assert.deepEqual(requests[0][0].params, { transaction_id: "abc123", expiration: "2026-06-16T20:01:00" });
  assert.deepEqual(requests[0][1].params, { transaction_id: "def456" });
});

test("HiveRpcClient throws HiveRpcError on RPC errors", async () => {
  const client = new HiveRpcClient("https://example.test", async () => response({ error: { message: "bad block" } }));

  await assert.rejects(() => client.getBlock(123), HiveRpcError);
});

test("FailoverHiveRpcClient keeps the current endpoint after a successful failover", async () => {
  const calls = [];
  const client = new FailoverHiveRpcClient(["https://first.test", "https://second.test"], (endpoint) => ({
    endpoint,
    async getDynamicGlobalProperties() {
      calls.push(endpoint);
      if (endpoint === "https://first.test") throw new Error("offline");
      return { head_block_number: 10, time: "2026-06-16T20:00:00" };
    },
  }));

  const props = await client.getDynamicGlobalProperties();

  assert.equal(props.head_block_number, 10);
  assert.deepEqual(calls, ["https://first.test", "https://second.test"]);
  assert.equal(client.endpoint, "https://second.test");

  await client.getDynamicGlobalProperties();

  assert.deepEqual(calls, ["https://first.test", "https://second.test", "https://second.test"]);
});

test("withStableEndpoint retries an entire concurrent read batch on failover", async () => {
  const calls = [];
  const client = new FailoverHiveRpcClient(["https://first.test", "https://second.test"], (endpoint) => ({
    endpoint,
    async getBlock() {
      calls.push(["block", endpoint]);
      if (endpoint === "https://first.test") throw new Error("block unavailable");
      return { timestamp: "2026-06-16T20:00:00", witness: "second-block", transactions: [] };
    },
    async getVirtualOperationsInBlock() {
      calls.push(["ops", endpoint]);
      if (endpoint === "https://first.test") await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ op: ["producer_reward", { producer: endpoint }] }];
    },
  }));

  const [block, ops] = await withStableEndpoint(client, (endpointClient) =>
    Promise.all([endpointClient.getBlock(10), endpointClient.getVirtualOperationsInBlock(10)]),
  );

  assert.equal(block.witness, "second-block");
  assert.deepEqual(ops, [{ op: ["producer_reward", { producer: "https://second.test" }] }]);
  assert.deepEqual(calls, [
    ["block", "https://first.test"],
    ["ops", "https://first.test"],
    ["block", "https://second.test"],
    ["ops", "https://second.test"],
  ]);
});

function response(payload, ok = true, status = 200, headers = {}) {
  return {
    ok,
    status,
    headers,
    async json() {
      return payload;
    },
  };
}

test("RPC deadlines cover the response body and let failover recover", async () => {
  let timedOutSignal;
  const client = new FailoverHiveRpcClient(["https://slow.test", "https://healthy.test"], (endpoint) =>
    new HiveRpcClient(endpoint, async (_url, init) => {
      if (endpoint === "https://healthy.test") return response({ result: { head_block_number: 42 } });
      timedOutSignal = init.signal;
      return { ok: true, status: 200, json: () => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }) };
    }, 15));
  assert.equal((await client.getDynamicGlobalProperties()).head_block_number, 42);
  assert.equal(timedOutSignal.aborted, true);
  assert.equal(client.endpoint, "https://healthy.test");
  assert.ok(client.health.lastResponseAt <= Date.now());
  assert.ok(client.health.latencyMs >= 0);
});

test("RPC batch requests time out and caller cancellation does not fail over", async () => {
  const batch = new HiveRpcClient("https://slow.test", (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }), 15);
  await assert.rejects(batch.findTransactions([{ id: "one" }, { id: "two" }]), /RPC timeout after 15ms/);
  const abort = new AbortController();
  let calls = 0;
  const client = new FailoverHiveRpcClient(["https://one.test", "https://two.test"], (endpoint) =>
    new HiveRpcClient(endpoint, async (_url, init) => {
      calls += 1;
      abort.abort();
      throw init.signal.reason;
    }));
  await assert.rejects(client.getBlock(1, abort.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("schedule refreshes are single-flight and discard cancelled or old-endpoint responses", async () => {
  const { WitnessScheduleReader } = await import('../dist/rpc.js');
  const reader = new WitnessScheduleReader();
  const requests = [];
  const client = endpoint => ({ endpoint, getWitnessSchedule(signal) {
    return new Promise(resolve => requests.push({ endpoint, signal, resolve }));
  } });
  const first = client('https://first.test'), second = client('https://second.test');
  reader.refresh(first);
  const old = reader.pending;
  reader.refresh(first);
  assert.equal(requests.length, 1);
  reader.refresh(second, undefined, false);
  assert.equal(requests.length, 2, 'an endpoint change requires fresh data even within the refresh interval');
  assert.equal(requests[0].signal.aborted, true);
  const current = { current_shuffled_witnesses: ['new'] };
  requests[1].resolve(current);
  await reader.pending;
  requests[0].resolve({ current_shuffled_witnesses: ['old'] });
  await old;
  assert.equal(reader.schedule, current);
  const caller = new AbortController();
  reader.refresh(second, caller.signal);
  const pending = reader.pending;
  caller.abort();
  requests[2].resolve({ current_shuffled_witnesses: ['cancelled'] });
  await pending;
  assert.equal(reader.schedule, current);
  reader.stop();
});

test("failed schedule refreshes keep cached data and back off for thirty seconds", async context => {
  const { WitnessScheduleReader } = await import('../dist/rpc.js');
  context.mock.timers.enable({ apis: ['Date'] });
  const reader = new WitnessScheduleReader();
  let calls = 0;
  const schedule = { current_shuffled_witnesses: ['alice'] };
  const client = { endpoint: 'https://example.test', async getWitnessSchedule() {
    if (++calls === 2) throw new Error('schedule unavailable');
    return schedule;
  } };
  reader.refresh(client); await reader.pending;
  reader.refresh(client); await reader.pending;
  assert.equal(reader.schedule, schedule);
  assert.match(reader.error.message, /schedule unavailable/);
  context.mock.timers.tick(29999);
  reader.refresh(client);
  assert.equal(calls, 2);
  context.mock.timers.tick(1);
  reader.refresh(client); await reader.pending;
  assert.equal(calls, 3);
  assert.equal(reader.error, undefined);
  reader.stop();
});

for (const first of ['schedule', 'block']) {
  test(`block context reuses the ${first} request slot before fetching virtual operations`, async () => {
    const { readBlockWithSchedule } = await import('../dist/rpc.js');
    let finishBlock, finishSchedule, ops = 0;
    const block = new Promise(resolve => { finishBlock = resolve; });
    const schedule = new Promise(resolve => { finishSchedule = resolve; });
    const value = { witness: 'alice' };
    const read = readBlockWithSchedule({
      getBlock() { return block; },
      async getVirtualOperationsInBlock() { ops++; return ['evidence']; },
    }, 1, schedule);
    assert.equal(ops, 0);
    if (first === 'schedule') finishSchedule(); else finishBlock(value);
    await new Promise(setImmediate);
    assert.equal(ops, 1);
    finishBlock(value); finishSchedule();
    assert.deepEqual(await read, [value, ['evidence']]);
  });
}
