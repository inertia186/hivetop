#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { BlockFollower, missedBlocksFromVirtualOperations, sleep, toBlockRecord } from "./follower.js";
import { MetricsStore } from "./metrics.js";
import { FailoverHiveRpcClient, HiveRpcClient, withStableEndpoint } from "./rpc.js";
import { formatProducedStatus, scheduledRoundRows } from "./tui.js";
import { TerminalUi } from "./tui.js";
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
}

const DEFAULT_NODE = "https://api.hive.blog";
const DEFAULT_FOLLOW_GAP_RETRIES = 3;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  const selection = options.nodeExplicit
    ? { endpoint: options.node, endpoints: [options.node] }
    : await selectHiveNode({ fallbackEndpoint: options.node, signal: abort.signal });
  const client = options.nodeExplicit ? new HiveRpcClient(selection.endpoint) : new FailoverHiveRpcClient(selection.endpoints);
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
  let scheduleMinBlock: number | undefined;
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

    const scheduleSignature = witnessScheduleSignature(schedule);
    const scheduleChanged = scheduleSignature !== lastScheduleSignature;
    if (scheduleChanged) scheduleMinBlock = nextBlock;
    lastScheduleSignature = scheduleSignature;
    const rows = scheduledRoundRows(nextBlock, schedule, blocks, missedBlocks, { minBlockNumber: scheduleMinBlock });
    const row = rows.find((candidate) => candidate.blockNumber === nextBlock);
    const futureSchedule = futureWitnessSchedule(schedule);
    const futureRows = futureSchedule ? scheduledRoundRows(nextBlock, futureSchedule, blocks, missedBlocks) : [];
    const futureRow = futureRows.find((candidate) => candidate.blockNumber === nextBlock);

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
        status: row ? formatProducedStatus(row) : "?",
        future_scheduled: futureRow?.settling ? undefined : futureRow?.scheduledWitness,
        future_status: futureRow ? formatProducedStatus(futureRow) : undefined,
        settling: Boolean(row?.settling),
        schedule_changed: scheduleChanged,
        next_shuffle_block_num: schedule.next_shuffle_block_num,
        schedule_index: schedule.current_shuffled_witnesses?.indexOf(block.witness) ?? -1,
        future_schedule_index: schedule.future_shuffled_witnesses?.indexOf(block.witness) ?? -1,
        schedule_sig: shortScheduleSignature(schedule),
        future_schedule_sig: shortWitnessListSignature(schedule.future_shuffled_witnesses),
        future_changes: schedule.future_changes,
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

function futureWitnessSchedule(schedule: WitnessSchedule): WitnessSchedule | undefined {
  if (!schedule.future_shuffled_witnesses?.length) return undefined;
  return {
    ...schedule,
    current_shuffled_witnesses: schedule.future_shuffled_witnesses,
  };
}

function parseArgs(args: string[]): CliOptions {
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
  hivetop --follow [--node URL] [--start BLOCK] [--poll-ms MS] [--limit NUM]

By default, hivetop asks PeakD Beacon for healthy Hive API nodes, keeps
api.hive.blog while its score is at least 90, and otherwise follows the
highest-scored compatible node. It also fails over through that Beacon-ordered
node list when RPC calls fail. Use --node to pin a specific endpoint.

Use --follow to print one JSON diagnostic record per block instead of opening
the terminal UI. It fetches the witness schedule every block and includes the
produced witness, inferred scheduled witness, status marker, next shuffle block,
schedule signature, endpoint, and producer_missed virtual ops.
Use --limit with --follow to stop after NUM emitted block/gap records. A block
that remains unavailable after bounded retries is emitted as a terminal gap and
the follower advances.

Controls:
  q, Ctrl-C  Quit
  p          Pause/resume
  r          Reset to current head
  arrows     Scroll recent blocks
`);
}
