#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BlockFollower, missedBlocksFromVirtualOperations, sleep, toBlockRecord } from "./follower.js";
import { MetricsStore } from "./metrics.js";
import { FailoverHiveRpcClient, HiveRpcClient, withStableEndpoint } from "./rpc.js";
import { formatRoundProducedStatus } from "./tui.js";
import { WitnessScheduleTracker, scheduledRoundRows, roundRowsOptions } from "./schedule.js";
import { TerminalUi, type TerminalView } from "./tui.js";
import { selectHiveNode } from "./beacon.js";
import type { BlockRecord, MissedBlock, WitnessSchedule } from "./types.js";

interface CliOptions {
  node: string;
  nodeExplicit: boolean;
  start?: number;
  window: number;
  pollMs: number;
  follow: boolean;
  limit?: number;
  maxGapRetries?: number;
  gapRetryMs?: number;
  view?: TerminalView;
  ascii?: boolean;
  compact?: boolean;
  noColor?: boolean;
  rpcTimeoutMs?: number;
}

const DEFAULT_NODE = "https://api.hive.blog";
const DEFAULT_FOLLOW_GAP_RETRIES = 3;

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("hivetop requires Node 24 or newer. Run `nvm use` in this project.");
  const options = parseArgs(process.argv.slice(2));
  if (!options.follow && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("The dashboard needs an interactive terminal. Use --follow for JSON output.");
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  process.on("SIGTERM", () => abort.abort());
  const selection = options.nodeExplicit
    ? { endpoint: options.node, endpoints: [options.node] }
    : await selectHiveNode({ fallbackEndpoint: options.node, signal: abort.signal });
  const rpcClient = (endpoint: string) => new HiveRpcClient(endpoint, undefined, options.rpcTimeoutMs);
  const client = options.nodeExplicit ? rpcClient(selection.endpoint) : new FailoverHiveRpcClient(selection.endpoints, rpcClient);
  if (options.follow) {
    await runFollowLog(client, options, abort.signal);
    return;
  }

  const follower = new BlockFollower(client, {
    startBlock: options.start,
    pollMs: options.pollMs,
    retryMs: Math.max(1000, options.pollMs),
  });
  const metrics = new MetricsStore(options.window);
  const ui = new TerminalUi({
    node: () => client.endpoint,
    windowSeconds: options.window,
    transactionStatusClient: client,
    view: options.view,
    ascii: options.ascii,
    compact: options.compact,
    noColor: options.noColor,
    onQuit: () => abort.abort(),
    onPauseToggle: (paused) => (paused ? follower.pause() : follower.resume()),
    onReset: () => follower.resetToHead(),
  });
  ui.start();

  try {
    for await (const event of follower.follow(abort.signal)) {
      if (event.type === "block") metrics.record(event.block);
      ui.render(event, metrics.snapshot());
    }
  } finally {
    ui.stop();
  }
}

export async function runFollowLog(client: HiveRpcClient | FailoverHiveRpcClient, options: CliOptions, signal: AbortSignal): Promise<void> {
  const blocks: BlockRecord[] = [];
  let missedBlocks: MissedBlock[] = [];
  let nextBlock = options.start;
  let lastScheduleSignature = "";
  const scheduleTracker = new WitnessScheduleTracker();
  let emittedRecords = 0;
  let gapRetries = 0;
  const maxGapRetries = options.maxGapRetries ?? DEFAULT_FOLLOW_GAP_RETRIES;
  const gapRetryMs = options.gapRetryMs ?? Math.max(1000, options.pollMs);

  while (!signal.aborted) {
    const read = await withStableEndpoint(
      client,
      async (endpointClient) => {
        const [props, schedule] = await Promise.all([
          endpointClient.getDynamicGlobalProperties(signal),
          endpointClient.getWitnessSchedule(signal, true),
        ]);
        const effectiveNextBlock = nextBlock ?? props.head_block_number;
        if (effectiveNextBlock > props.head_block_number) return { props, schedule, nextBlock: effectiveNextBlock };
        const [block, virtualOperations] = await Promise.all([
          endpointClient.getBlock(effectiveNextBlock, signal),
          endpointClient.getVirtualOperationsInBlock(effectiveNextBlock, signal),
        ]);
        return { props, schedule, nextBlock: effectiveNextBlock, block, virtualOperations };
      },
      signal,
    );
    const { props, schedule } = read;
    nextBlock = read.nextBlock;

    if (nextBlock > props.head_block_number) {
      await sleep(options.pollMs, signal);
      continue;
    }

    const { block, virtualOperations } = read;
    if (!block) {
      gapRetries += 1;
      const terminal = gapRetries > maxGapRetries;
      console.log(
        JSON.stringify({
          type: "gap",
          block: nextBlock,
          head: props.head_block_number,
          endpoint: client.endpoint,
          retry: gapRetries,
          terminal,
        }),
      );
      if (!terminal) {
        await sleep(gapRetryMs, signal);
        continue;
      }
      emittedRecords += 1;
      if (options.limit !== undefined && emittedRecords >= options.limit) break;
      nextBlock += 1;
      gapRetries = 0;
      continue;
    }
    gapRetries = 0;

    const record = toBlockRecord(nextBlock, block, virtualOperations.length);
    blocks.unshift(record);
    blocks.splice(120);

    const newMisses = missedBlocksFromVirtualOperations(nextBlock, block.timestamp, virtualOperations);
    if (newMisses.length > 0) missedBlocks = [...newMisses, ...missedBlocks].slice(0, 24);

    scheduleTracker.update(props, schedule, blocks, missedBlocks);
    const displayedSchedule = scheduleTracker.schedule ?? schedule;
    const scheduleSignature = witnessScheduleSignature(displayedSchedule);
    const scheduleChanged = scheduleSignature !== lastScheduleSignature;
    lastScheduleSignature = scheduleSignature;
    const rows = scheduledRoundRows(nextBlock, displayedSchedule, blocks, missedBlocks, roundRowsOptions(props, blocks, scheduleTracker.minBlockNumber));
    const row = rows.find((candidate) => candidate.blockNumber === nextBlock);
    const futureBoundary = Math.max(nextBlock, displayedSchedule.next_shuffle_block_num ?? nextBlock);
    const futureRow = rows.find((candidate) => candidate.blockNumber > futureBoundary);

    console.log(
      JSON.stringify({
        type: "block",
        endpoint: client.endpoint,
        block: nextBlock,
        head: props.head_block_number,
        lag: Math.max(0, props.head_block_number - nextBlock),
        block_time: block.timestamp,
        dgpo_time: props.time,
        produced: block.witness,
        scheduled: row?.settling ? undefined : row?.scheduledWitness,
        status: row ? formatRoundProducedStatus(row, nextBlock, 0, missedBlocks) : "?",
        current_aslot: props.current_aslot,
        future_block: futureRow?.blockNumber,
        future_scheduled: futureRow?.settling ? undefined : futureRow?.scheduledWitness,
        future_status: futureRow ? "-" : undefined,
        settling: Boolean(row?.settling),
        schedule_changed: scheduleChanged,
        next_shuffle_block_num: displayedSchedule.next_shuffle_block_num,
        schedule_index: displayedSchedule.current_shuffled_witnesses?.indexOf(block.witness) ?? -1,
        future_schedule_index: displayedSchedule.future_shuffled_witnesses?.indexOf(block.witness) ?? -1,
        schedule_sig: shortScheduleSignature(displayedSchedule),
        future_schedule_sig: shortWitnessListSignature(displayedSchedule.future_shuffled_witnesses),
        reported_schedule_sig: shortScheduleSignature(schedule),
        reported_next_shuffle_block_num: schedule.next_shuffle_block_num,
        future_changes: displayedSchedule.future_changes,
        missed: newMisses.map((miss) => miss.witness),
      }),
    );

    emittedRecords += 1;
    if (options.limit !== undefined && emittedRecords >= options.limit) break;
    nextBlock += 1;
  }
}

function witnessScheduleSignature(schedule: WitnessSchedule): string {
  return (schedule.current_shuffled_witnesses ?? []).join(",");
}

function shortScheduleSignature(schedule: WitnessSchedule): string {
  return shortWitnessListSignature(schedule.current_shuffled_witnesses);
}

function shortWitnessListSignature(witnesses: string[] | undefined): string {
  witnesses ??= [];
  if (witnesses.length === 0) return "";
  return `${witnesses[0]}..${witnesses[witnesses.length - 1]}`;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    node: DEFAULT_NODE,
    nodeExplicit: false,
    window: 120,
    pollMs: 1000,
    follow: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--node" && value) {
      options.node = value;
      options.nodeExplicit = true;
      index += 1;
    } else if (arg === "--start" && value) {
      options.start = positiveInteger(value, "--start");
      index += 1;
    } else if (arg === "--window" && value) {
      options.window = positiveInteger(value, "--window");
      index += 1;
    } else if (arg === "--poll-ms" && value) {
      options.pollMs = positiveInteger(value, "--poll-ms");
      index += 1;
    } else if (arg === "--follow") {
      options.follow = true;
    } else if (arg === "--limit" && value) {
      options.limit = positiveInteger(value, "--limit");
      index += 1;
    } else if (arg === "--view" && value) {
      if (value !== "blocks" && value !== "round" && value !== "txstatus" && value !== "sizes") throw new Error("--view must be blocks, round, txstatus, or sizes");
      options.view = value;
      index += 1;
    } else if (arg === "--rpc-timeout-ms" && value) {
      options.rpcTimeoutMs = positiveInteger(value, "--rpc-timeout-ms");
      index += 1;
    } else if (arg === "--ascii") {
      options.ascii = true;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--no-color") {
      options.noColor = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return options;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`hivetop

Usage:
  hivetop [--node URL] [--start BLOCK] [--window SECONDS] [--poll-ms MS]
          [--view blocks|round|txstatus|sizes] [--compact] [--ascii] [--no-color]
          [--rpc-timeout-ms MS]
  hivetop --follow [--node URL] [--start BLOCK] [--poll-ms MS] [--limit NUM]

By default, hivetop asks PeakD Beacon for healthy Hive API nodes, keeps
api.hive.blog while its score is at least 90, and otherwise follows the
highest-scored compatible node. It also fails over through that Beacon-ordered
node list when RPC calls fail. Use --node to pin a specific endpoint.

Use --follow to print one JSON diagnostic record per block instead of opening
the terminal UI. It fetches the witness schedule every block and includes the
produced witness, scheduled witness using the same slot/boundary logic as the UI,
status, next shuffle block, schedule signature, endpoint, and producer_missed ops.
future_block/future_scheduled describe the first predicted block of the next round.
Use --limit with --follow to stop after NUM emitted block/gap records. A block
that remains unavailable after bounded retries is emitted as a terminal gap and
the follower advances.

Controls:
  q, Ctrl-C  Quit
  p          Pause/resume
  r          Reset to current head
  v          Cycle blocks, witness round, transaction status (defrag), sizes
  arrows/j/k Select rows; PageUp/PageDown moves a page; Home/g follows live
  Enter      Inspect the selected produced block
  /          Filter by witness name; Enter applies; Esc clears/closes
  ?          Help and legends
  e          Recent event history

RPC requests time out after 10000ms by default. Optional side-panel failures
are marked unavailable/stale and retried every 30 seconds.
--compact hides the sidebar and uses fewer columns; narrow terminals adapt
automatically. --ascii uses status letters; --no-color or a nonempty NO_COLOR
environment variable disables colors and also uses distinct status letters.
Requires Node 24+. Run nvm use if you use nvm.
`);
}
