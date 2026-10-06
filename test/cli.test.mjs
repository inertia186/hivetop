import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { parseArgs, runFollowLog } from "../dist/cli.js";

const execFileAsync = promisify(execFile);

test("runFollowLog advances after a terminal gap and honors limit", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const client = {
      endpoint: "https://example.test",
      async getDynamicGlobalProperties() {
        return { head_block_number: 11, time: "2026-06-16T20:00:00" };
      },
      async getWitnessSchedule() {
        return { current_shuffled_witnesses: ["alice", "bob", "carol"], num_scheduled_witnesses: 3 };
      },
      async getBlock(blockNumber) {
        if (blockNumber === 10) return null;
        return { timestamp: "2026-06-16T20:00:03", witness: "witness-11", transactions: [] };
      },
      async getVirtualOperationsInBlock() {
        return [];
      },
    };

    await runFollowLog(
      client,
      {
        node: "https://example.test",
        nodeExplicit: true,
        start: 10,
        window: 120,
        pollMs: 1,
        follow: true,
        limit: 2,
        maxGapRetries: 1,
        gapRetryMs: 1,
      },
      new AbortController().signal,
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(
    logs.map((entry) => [entry.type, entry.block, entry.terminal]),
    [
      ["gap", 10, false],
      ["gap", 10, true],
      ["block", 11, undefined],
    ],
  );
});

test("built CLI entrypoint is executable as a package bin", async () => {
  const cli = new URL("../dist/cli.js", import.meta.url);
  const source = await readFile(cli, "utf8");

  assert.equal(source.split("\n")[0], "#!/usr/bin/env node");

  const { stdout } = await execFileAsync(cli.pathname, ["--help"]);
  assert.match(stdout, /^hivetop\n/);
});

test("CLI accepts terminal options and rejects invalid views/timeouts", () => {
  const options = parseArgs(["--view", "round", "--ascii", "--compact", "--no-color", "--rpc-timeout-ms", "2500"]);
  assert.equal(options.view, "round");
  assert.equal(options.ascii, true);
  assert.equal(options.compact, true);
  assert.equal(options.noColor, true);
  assert.equal(options.rpcTimeoutMs, 2500);
  assert.throws(() => parseArgs(["--view", "invalid"]), /--view/);
  assert.throws(() => parseArgs(["--rpc-timeout-ms", "0"]), /positive integer/);
});

test("JSON diagnostics retain the accepted schedule through a round boundary", async () => {
  let head = 1;
  const current = { current_shuffled_witnesses: ["alice", "bob", "carol"], future_shuffled_witnesses: ["dan", "erin", "frank"], next_shuffle_block_num: 3 };
  const next = { current_shuffled_witnesses: current.future_shuffled_witnesses, future_shuffled_witnesses: ["gin", "hana", "ian"], next_shuffle_block_num: 6 };
  const client = {
    endpoint: "https://example.test",
    async getDynamicGlobalProperties() {
      head += 1;
      return { head_block_number: head, current_aslot: head + 3, time: `2026-06-16T20:00:0${head}` };
    },
    async getWitnessSchedule() { return head >= 3 ? next : current; },
    async getBlock(number) { return { timestamp: `2026-06-16T20:00:0${number}`, witness: { 2: "carol", 3: "alice", 4: "erin" }[number], transactions: [] }; },
    async getVirtualOperationsInBlock() { return []; },
  };
  const originalLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    await runFollowLog(client, { start: 2, follow: true, limit: 3, pollMs: 1 }, new AbortController().signal);
  } finally { console.log = originalLog; }
  assert.deepEqual(logs.map((entry) => entry.scheduled), ["carol", "alice", "erin"]);
  assert.deepEqual(logs.map((entry) => entry.status), ["√", "√", "√"]);
  assert.deepEqual(logs.map((entry) => entry.next_shuffle_block_num), [3, 3, 6]);
  assert.deepEqual(logs.map((entry) => entry.schedule_changed), [true, false, true]);
  assert.deepEqual(logs.map((entry) => entry.future_block), [4, 4, 7]);
  assert.deepEqual(logs.map((entry) => entry.future_scheduled), ["erin", "erin", "hana"]);
});
