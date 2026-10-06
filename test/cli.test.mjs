import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { runFollowLog } from "../dist/cli.js";

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
