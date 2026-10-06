import type { BlockRecord } from "./types.js";

export interface MetricsSnapshot {
  blocks: BlockRecord[];
  blockRate: number;
  transactionRate: number;
  operationRate: number;
  virtualOperationRate: number;
  operationTypes: Array<[string, number]>;
  witnesses: Array<[string, number]>;
}

export class MetricsStore {
  private blocks: BlockRecord[] = [];
  private latestBlockTime: Date | undefined;

  constructor(private readonly windowSeconds: number, private readonly maxBlocks = 300) {}

  record(block: BlockRecord, now = block.timestamp): void {
    this.blocks.unshift(block);
    if (!this.latestBlockTime || block.timestamp.getTime() > this.latestBlockTime.getTime()) {
      this.latestBlockTime = block.timestamp;
    }
    this.evict(now);
  }

  snapshot(now = this.latestBlockTime ?? new Date()): MetricsSnapshot {
    this.evict(now);
    const seconds = Math.max(1, this.windowSeconds);
    const operationTypes = new Map<string, number>();
    const witnesses = new Map<string, number>();
    let transactions = 0;
    let operations = 0;
    let virtualOperations = 0;

    for (const block of this.blocks) {
      transactions += block.transactionCount;
      operations += block.operationCount;
      virtualOperations += block.virtualOperationCount;
      witnesses.set(block.witness, (witnesses.get(block.witness) ?? 0) + 1);
      for (const [type, count] of block.operationTypes) {
        operationTypes.set(type, (operationTypes.get(type) ?? 0) + count);
      }
    }

    return {
      blocks: [...this.blocks],
      blockRate: this.blocks.length / seconds,
      transactionRate: transactions / seconds,
      operationRate: operations / seconds,
      virtualOperationRate: virtualOperations / seconds,
      operationTypes: sortedEntries(operationTypes),
      witnesses: sortedEntries(witnesses),
    };
  }

  private evict(now: Date): void {
    const cutoff = now.getTime() - this.windowSeconds * 1000;
    this.blocks = this.blocks
      .filter((block) => block.timestamp.getTime() >= cutoff)
      .slice(0, this.maxBlocks);
  }
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
