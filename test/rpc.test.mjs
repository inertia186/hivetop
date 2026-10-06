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

test("FailoverHiveRpcClient rotates to the next endpoint after a failed call", async () => {
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

  await client.getDynamicGlobalProperties();
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
