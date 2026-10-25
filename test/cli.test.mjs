import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  const directory = await mkdtemp(join(tmpdir(), "hivetop-bin-"));
  try {
    const command = join(directory, "hivetop");
    await symlink(fileURLToPath(cli), command);
    const linked = await execFileAsync(command, ["--help"], { cwd: tmpdir() });
    assert.equal(linked.stdout, stdout);
  } finally { await rm(directory, { recursive: true }); }
});

test("CLI accepts terminal options and rejects invalid views/timeouts", () => {
  const options = parseArgs(["--view", "round", "--ascii", "--compact", "--no-color", "--rpc-timeout-ms", "2500"]);
  assert.equal(options.view, "round");
  assert.equal(options.ascii, true);
  assert.equal(options.compact, true);
  assert.equal(options.noColor, true);
  assert.equal(options.rpcTimeoutMs, 2500);
  assert.equal(parseArgs(["--view", "sizes"]).view, "sizes");
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

test("JSON diagnostics advance with an unknown schedule and cancel refreshes at the limit", async () => {
  let signal, calls = 0;
  const client = {
    endpoint: 'https://example.test',
    async getDynamicGlobalProperties() { return { head_block_number: 11, time: '2026-06-16T20:00:00' }; },
    async getBlock() { return { timestamp: '2026-06-16T20:00:00', witness: 'alice', transactions: [] }; },
    async getVirtualOperationsInBlock() { return []; },
    getWitnessSchedule(active) {
      calls++; signal = active;
      return new Promise((resolve, reject) => active.addEventListener('abort', () => reject(active.reason), { once: true }));
    },
  };
  const logs = [], originalLog = console.log;
  console.log = line => logs.push(JSON.parse(line));
  try { await runFollowLog(client, { start: 10, pollMs: 1000, follow: true, limit: 2 }, new AbortController().signal); }
  finally { console.log = originalLog; }
  assert.deepEqual(logs.map(row => row.block), [10, 11]);
  assert.ok(logs.every(row => row.status === '?' && row.scheduled === undefined));
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("diagnostic idle polling wakes when the pending schedule completes", async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let head = 10, finishSchedule;
  const schedule = { current_shuffled_witnesses: ['alice'], next_shuffle_block_num: 11 };
  let first = true;
  const client = {
    endpoint: 'https://example.test',
    async getDynamicGlobalProperties() { return { head_block_number: head, time: '2026-06-16T20:00:00' }; },
    async getBlock() { return { timestamp: '2026-06-16T20:00:00', witness: 'alice', transactions: [] }; },
    async getVirtualOperationsInBlock() { return []; },
    getWitnessSchedule() {
      if (!first) return Promise.resolve(schedule);
      first = false;
      return new Promise(resolve => { finishSchedule = resolve; });
    },
  };
  const originalLog = console.log, logs = [];
  console.log = line => logs.push(JSON.parse(line));
  const abort = new AbortController();
  const running = runFollowLog(client, { start: 10, pollMs: 1000, follow: true, limit: 2 }, abort.signal);
  try {
    await new Promise(setImmediate);
    assert.equal(logs.length, 1);
    context.mock.timers.tick(100);
    head = 11;
    finishSchedule(schedule);
    await new Promise(setImmediate);
    assert.deepEqual(logs.map(row => row.block), [10, 11]);
    await running;
  } finally { abort.abort(); await running; console.log = originalLog; }
});
