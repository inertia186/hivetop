import type {
  AppliedOperation,
  BlockRecord,
  DynamicGlobalProperties,
  FollowerEvent,
  FollowerMetadata,
  HardforkInfo,
  HiveBlock,
  MissedBlock,
  NextScheduledHardfork,
  RcInfo,
  RcStats,
  ScheduleDiagnostics,
  WitnessByVote,
  WitnessFeedUpdates,
  WitnessRanks,
  WitnessSchedule,
  WitnessVersions,
} from "./types.js";
import { withStableEndpoint, type HiveRpcReadable } from "./rpc.js";

export interface BlockFollowerOptions {
  startBlock?: number;
  pollMs: number;
  retryMs: number;
  hardforkRefreshMs?: number;
  witnessScheduleRefreshMs?: number;
  witnessRankRefreshMs?: number;
  rcStatsRefreshMs?: number;
  maxMissedBlocks?: number;
}

export class BlockFollower {
  private paused = false;
  private resetRequested = false;
  private hardforkInfo: HardforkInfo | undefined;
  private hardforkInfoFetchedAt = 0;
  private witnessSchedule: WitnessSchedule | undefined;
  private witnessScheduleFetchedAt = 0;
  private witnessScheduleRound: number | undefined;
  private witnessScheduleCurrentSignature: string | undefined;
  private witnessScheduleFutureSignature: string | undefined;
  private witnessScheduleRequestId: string | undefined;
  private witnessScheduleEndpoint: string | undefined;
  private witnessScheduleDiagnostics: ScheduleDiagnostics | undefined;
  private witnessRanks: WitnessRanks = {};
  private witnessFeedUpdates: WitnessFeedUpdates = {};
  private witnessVersions: WitnessVersions = {};
  private majorityWitnessVersion: string | undefined;
  private witnessRanksFetchedAt = 0;
  private rcInfo: RcInfo | undefined;
  private rcInfoFetchedAt = 0;
  private missedBlocks: MissedBlock[] = [];
  private readonly panelErrors: NonNullable<FollowerMetadata["panelErrors"]> = {};
  private metadataRefresh: Promise<void> | undefined;

  constructor(
    private readonly client: HiveRpcReadable,
    private readonly options: BlockFollowerOptions,
  ) {}

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  resetToHead(): void {
    this.resetRequested = true;
  }

  async *follow(signal?: AbortSignal): AsyncGenerator<FollowerEvent> {
    let nextBlock = this.options.startBlock;

    while (!signal?.aborted) {
      if (this.paused) {
        await sleep(this.options.pollMs, signal);
        continue;
      }

      try {
        const read = await withStableEndpoint(
          this.client,
          async (client) => {
            const props = await client.getDynamicGlobalProperties(signal);
            if (signal?.aborted) throw abortError();
            this.refreshSidePanels(client, signal);
            await this.refreshPanel("schedule", () => this.refreshWitnessSchedule(client, props, signal), signal);
            const witnessSchedule = this.witnessSchedule;
            const effectiveNextBlock = this.resetRequested ? props.head_block_number : (nextBlock ?? props.head_block_number);
            if (effectiveNextBlock > props.head_block_number) {
              return { props, witnessSchedule, nextBlock: effectiveNextBlock };
            }
            const [block, virtualOperations] = await Promise.all([
              client.getBlock(effectiveNextBlock, signal),
              client.getVirtualOperationsInBlock(effectiveNextBlock, signal),
            ]);
            return { props, witnessSchedule, nextBlock: effectiveNextBlock, block, virtualOperations };
          },
          signal,
        );
        if (signal?.aborted) break;

        const { props, witnessSchedule } = read;
        nextBlock = read.nextBlock;
        if (this.resetRequested) this.resetRequested = false;

        if (nextBlock > props.head_block_number) {
          yield {
            ...this.metadata(),
            type: "status",
            headBlock: props.head_block_number,
            nextBlock,
            lag: Math.max(0, props.head_block_number - nextBlock),
            dynamicGlobalProperties: props,
            witnessSchedule,
          };
          await sleep(this.options.pollMs, signal);
          continue;
        }

        const { block, virtualOperations } = read;

        if (!block) {
          yield {
            ...this.metadata(),
            type: "gap",
            blockNumber: nextBlock,
            retryInMs: this.options.retryMs,
            dynamicGlobalProperties: props,
            witnessSchedule,
          };
          await sleep(this.options.retryMs, signal);
          continue;
        }

        const record = toBlockRecord(nextBlock, block, virtualOperations.length);
        const newMissedBlocks = missedBlocksFromVirtualOperations(nextBlock, block.timestamp, virtualOperations);
        if (newMissedBlocks.length > 0) {
          this.missedBlocks = [...newMissedBlocks, ...this.missedBlocks].slice(0, this.options.maxMissedBlocks ?? 8);
        }

        yield {
          ...this.metadata(),
          type: "block",
          block: record,
          headBlock: props.head_block_number,
          lag: Math.max(0, props.head_block_number - nextBlock),
          dynamicGlobalProperties: props,
          witnessSchedule,
        };
        nextBlock += 1;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) break;

        yield {
          ...this.metadata(),
          type: "retry",
          message: error instanceof Error ? error.message : String(error),
          retryInMs: this.options.retryMs,
        };
        await sleep(this.options.retryMs, signal);
      }
    }
  }

  private metadata(): FollowerMetadata {
    return {
      panelErrors: { ...this.panelErrors },
      hardforkInfo: this.hardforkInfo,
      rcInfo: this.rcInfo,
      witnessRanks: this.witnessRanks,
      witnessFeedUpdates: this.witnessFeedUpdates,
      witnessVersions: this.witnessVersions,
      majorityWitnessVersion: this.majorityWitnessVersion,
      scheduleDiagnostics: this.witnessScheduleDiagnostics,
      missedBlocks: this.missedBlocks,
    };
  }

  private refreshSidePanels(client: HiveRpcReadable, signal?: AbortSignal): void {
    if (this.metadataRefresh) return;
    this.metadataRefresh = Promise.all([
      this.refreshPanel("hardfork", () => this.refreshHardforkInfo(client, signal), signal),
      this.refreshPanel("rc", () => this.refreshRcInfo(client, signal), signal),
      this.refreshPanel("witnesses", () => this.refreshWitnessRanks(client, signal), signal),
    ]).then(() => {}).finally(() => { this.metadataRefresh = undefined; });
  }

  private async refreshPanel(panel: keyof NonNullable<FollowerMetadata["panelErrors"]>, refresh: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
    const error = this.panelErrors[panel];
    if (error && Date.now() - error.at < 30_000) return;
    try {
      await refresh();
      delete this.panelErrors[panel];
    } catch (error) {
      if (signal?.aborted) return;
      this.panelErrors[panel] = { message: error instanceof Error ? error.message : String(error), at: Date.now() };
    }
  }

  private async refreshHardforkInfo(client: HiveRpcReadable, signal?: AbortSignal): Promise<HardforkInfo | undefined> {
    const refreshMs = this.options.hardforkRefreshMs ?? 60_000;
    const now = Date.now();
    if (this.hardforkInfo && now - this.hardforkInfoFetchedAt < refreshMs) return this.hardforkInfo;

    const [currentVersion, next] = await Promise.all([
      client.getHardforkVersion(signal),
      client.getNextScheduledHardfork(signal),
    ]);
    if (signal?.aborted) return this.hardforkInfo;

    this.hardforkInfo = {
      currentVersion,
      nextVersion: hardforkVersion(next),
      nextLiveTime: typeof next.live_time === "string" ? next.live_time : undefined,
    };
    this.hardforkInfoFetchedAt = now;
    return this.hardforkInfo;
  }

  private async refreshWitnessSchedule(client: HiveRpcReadable, props: DynamicGlobalProperties, signal?: AbortSignal): Promise<WitnessSchedule | undefined> {
    const refreshMs = this.options.witnessScheduleRefreshMs ?? 60_000;
    const now = Date.now();
    const round = this.witnessSchedule ? scheduleRound(props.head_block_number, this.witnessSchedule) : undefined;
    if (this.witnessSchedule && now - this.witnessScheduleFetchedAt < refreshMs) {
      if (round === undefined || this.witnessScheduleRound === undefined || round === this.witnessScheduleRound) {
        return this.witnessSchedule;
      }
    }

    const nextSchedule = await client.getWitnessSchedule(signal, true);
    this.updateWitnessScheduleDiagnostics(props, nextSchedule);
    this.witnessSchedule = nextSchedule;
    this.witnessScheduleFetchedAt = now;
    this.witnessScheduleRound = scheduleRound(props.head_block_number, this.witnessSchedule);
    return this.witnessSchedule;
  }

  private async refreshWitnessRanks(client: HiveRpcReadable, signal?: AbortSignal): Promise<WitnessRanks> {
    const refreshMs = this.options.witnessRankRefreshMs ?? 300_000;
    const now = Date.now();
    if (Object.keys(this.witnessRanks).length > 0 && now - this.witnessRanksFetchedAt < refreshMs) return this.witnessRanks;

    const witnesses = await client.getWitnessesByVote("", 250, signal);
    if (signal?.aborted) return this.witnessRanks;

    this.witnessRanks = witnessRanksByVote(witnesses);
    this.witnessFeedUpdates = witnessFeedUpdatesByVote(witnesses);
    this.witnessVersions = witnessVersionsByVote(witnesses);
    this.majorityWitnessVersion = majorityHighestVersion(Object.values(this.witnessVersions));
    this.witnessRanksFetchedAt = now;
    return this.witnessRanks;
  }

  private async refreshRcInfo(client: HiveRpcReadable, signal?: AbortSignal): Promise<RcInfo | undefined> {
    const refreshMs = this.options.rcStatsRefreshMs ?? 30_000;
    const now = Date.now();
    if (this.rcInfo && now - this.rcInfoFetchedAt < refreshMs) return this.rcInfo;

    const response = await client.getRcStats(signal);
    if (signal?.aborted) return this.rcInfo;

    this.rcInfo = summarizeRcStats(response.rc_stats);
    this.rcInfoFetchedAt = now;
    return this.rcInfo;
  }

  private updateWitnessScheduleDiagnostics(props: DynamicGlobalProperties, schedule: WitnessSchedule): void {
    const previousCurrentSignature = this.witnessScheduleCurrentSignature;
    const previousFutureSignature = this.witnessScheduleFutureSignature;
    const previousRequestId = this.witnessScheduleRequestId;
    const previousEndpoint = this.witnessScheduleEndpoint;
    const currentSignature = scheduleListSignature(schedule.current_shuffled_witnesses);
    const futureSignature = scheduleListSignature(schedule.future_shuffled_witnesses);
    const endpoint = schedule.rpcEndpoint ?? this.client.endpoint;

    if (
      previousCurrentSignature &&
      currentSignature &&
      currentSignature !== previousCurrentSignature &&
      previousFutureSignature &&
      currentSignature !== previousFutureSignature &&
      endpoint === previousEndpoint
    ) {
      this.witnessScheduleDiagnostics = {
        kind: "possible_rpc_backend_drift",
        message: "possible RPC backend drift: current schedule differs from prior future schedule",
        endpoint,
        changedAtBlock: props.head_block_number,
        previousRequestId,
        requestId: schedule.rpcRequestId,
      };
    } else if (this.witnessScheduleDiagnostics && props.head_block_number - this.witnessScheduleDiagnostics.changedAtBlock > 42) {
      this.witnessScheduleDiagnostics = undefined;
    }

    this.witnessScheduleCurrentSignature = currentSignature;
    this.witnessScheduleFutureSignature = futureSignature;
    this.witnessScheduleRequestId = schedule.rpcRequestId;
    this.witnessScheduleEndpoint = endpoint;
  }
}

export function witnessRanksByVote(witnesses: WitnessByVote[]): WitnessRanks {
  return witnesses.reduce<WitnessRanks>((ranks, witness, index) => {
    if (typeof witness.owner === "string" && witness.owner.length > 0) ranks[witness.owner] = index + 1;
    return ranks;
  }, {});
}

export function scheduleRound(headBlockNumber: unknown, schedule: WitnessSchedule): number | undefined {
  if (typeof headBlockNumber !== "number" || !Number.isFinite(headBlockNumber)) return undefined;
  const witnessCount = schedule.current_shuffled_witnesses?.length ?? schedule.num_scheduled_witnesses;
  if (typeof witnessCount !== "number" || !Number.isFinite(witnessCount) || witnessCount <= 0) return undefined;
  return Math.floor(headBlockNumber / witnessCount);
}

function scheduleListSignature(witnesses: string[] | undefined): string | undefined {
  if (!witnesses?.length) return undefined;
  return witnesses.join("\n");
}

export function witnessFeedUpdatesByVote(witnesses: WitnessByVote[]): WitnessFeedUpdates {
  return witnesses.reduce<WitnessFeedUpdates>((updates, witness) => {
    if (
      typeof witness.owner === "string" &&
      witness.owner.length > 0 &&
      typeof witness.last_hbd_exchange_update === "string" &&
      witness.last_hbd_exchange_update.length > 0
    ) {
      updates[witness.owner] = witness.last_hbd_exchange_update;
    }
    return updates;
  }, {});
}

export function witnessVersionsByVote(witnesses: WitnessByVote[]): WitnessVersions {
  return witnesses.reduce<WitnessVersions>((versions, witness) => {
    if (
      typeof witness.owner === "string" &&
      witness.owner.length > 0 &&
      typeof witness.running_version === "string" &&
      witness.running_version.length > 0
    ) {
      versions[witness.owner] = witness.running_version;
    }
    return versions;
  }, {});
}

export function majorityHighestVersion(versions: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const version of versions) {
    if (version.length > 0) counts.set(version, (counts.get(version) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareVersions(b[0], a[0]))[0]?.[0];
}

function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function parseVersion(version: string): number[] {
  return version.split(".").map((part) => {
    const parsed = Number(part);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function hardforkVersion(next: NextScheduledHardfork): string | undefined {
  return next.hf_version ?? next.hardfork_version;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function missedBlocksFromVirtualOperations(blockNumber: number, blockTime: string, virtualOperations: AppliedOperation[]): MissedBlock[] {
  return virtualOperations.flatMap((operation) => {
    const op = operation.op;
    if (!Array.isArray(op)) return [];

    const [type, payload] = op;
    if (type !== "producer_missed" && type !== "producer_missed_operation") return [];

    const witness = missedWitnessName(payload);
    if (!witness) return [];

    return [
      {
        witness,
        detectedAtBlock: blockNumber,
        detectedAt: blockTime,
      },
    ];
  });
}

function missedWitnessName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const fields = payload as { producer?: unknown; owner?: unknown; witness?: unknown };
  for (const value of [fields.producer, fields.owner, fields.witness]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function summarizeRcStats(stats: RcStats | undefined): RcInfo | undefined {
  if (!stats) return undefined;
  const payers = stats.payers ?? [];
  const lowRcUnder5 = sumNumbers(payers.map((payer) => payer.lt5));
  const lowRcUnder20 = sumNumbers(payers.map((payer) => payer.lt20));
  const cantAffordVote = sumNumbers(payers.map((payer) => payer.cant_afford?.vote));
  const cantAffordComment = sumNumbers(payers.map((payer) => payer.cant_afford?.comment));
  const topOperation = Object.entries(stats.ops ?? {})
    .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))[0]?.[0];

  return {
    voteCost: stats.vote,
    commentCost: stats.comment,
    transferCost: stats.transfer,
    lowRcUnder5,
    lowRcUnder20,
    cantAffordVote,
    cantAffordComment,
    topOperation,
  };
}

function sumNumbers(values: Array<number | undefined>): number {
  let total = 0;
  for (const value of values) {
    if (typeof value === "number") total += value;
  }
  return total;
}

export function toBlockRecord(number: number, block: HiveBlock, virtualOperationCount = 0): BlockRecord {
  const operationTypes = new Map<string, number>();
  const transactions = block.transactions ?? [];
  let operationCount = 0;

  for (const transaction of transactions) {
    for (const operation of transaction.operations ?? []) {
      const type = operation[0] ?? "unknown";
      operationCount += 1;
      operationTypes.set(type, (operationTypes.get(type) ?? 0) + 1);
    }
  }

  return {
    number,
    timestamp: new Date(`${block.timestamp}Z`),
    witness: block.witness,
    transactionCount: transactions.length,
    transactions: transactionRefs(block),
    operationCount,
    virtualOperationCount,
    operationTypes,
  };
}

function transactionRefs(block: HiveBlock): BlockRecord["transactions"] {
  const ids = block.transaction_ids ?? [];
  return ids.map((id, index) => ({
    id,
    expiration: block.transactions?.[index]?.expiration,
    primaryOperationType: block.transactions?.[index]?.operations?.[0]?.[0],
  }));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      abortHandler = () => {
        clearTimeout(timeout);
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
