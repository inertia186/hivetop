import type { BlockRecord, DynamicGlobalProperties, MissedBlock, WitnessSchedule } from "./types.js";

export class WitnessScheduleTracker {
  schedule: WitnessSchedule | undefined;
  minBlockNumber: number | undefined;
  private readonly acceptedSignatures = new Map<string, number>();

  update(props: DynamicGlobalProperties | undefined, candidate: WitnessSchedule | undefined, blocks: BlockRecord[], missedBlocks: MissedBlock[] = []): void {
    if (!props || !candidate?.current_shuffled_witnesses?.length) return;
    const displayHeadBlock = latestProducedBlockNumber(blocks) ?? props.head_block_number;
    if (!this.schedule) {
      this.accept(candidate, displayHeadBlock);
      return;
    }
    const currentSignature = scheduleSignature(this.schedule);
    const candidateSignature = scheduleSignature(candidate);
    const previousShuffle = this.schedule.next_shuffle_block_num;
    const nextShuffle = candidate.next_shuffle_block_num;
    if (previousShuffle !== undefined && nextShuffle !== undefined && nextShuffle < previousShuffle) return;
    const advancesRound = previousShuffle !== undefined && nextShuffle !== undefined && nextShuffle > previousShuffle;
    // The boundary block is still produced by the old schedule.
    if (advancesRound && displayHeadBlock <= previousShuffle!) return;
    if (currentSignature === candidateSignature && !advancesRound) {
      this.schedule = candidate;
      return;
    }
    if (advancesRound && candidateSignature === (this.schedule.future_shuffled_witnesses ?? []).join("\n")) {
      this.accept(candidate, previousShuffle! + 1);
      return;
    }
    if (!advancesRound && currentSignature !== candidateSignature && this.acceptedSignatures.has(candidateSignature)) return;
    const fit = bestScheduleFit(
      displayHeadBlock, candidate.current_shuffled_witnesses, blocks, missedBlocks,
      previousShuffle === undefined ? this.minBlockNumber : previousShuffle + 1,
    );
    if (fit.matches >= 3 && fit.newestMatchBlock === displayHeadBlock) {
      this.accept(candidate, previousShuffle === undefined ? displayHeadBlock : previousShuffle + 1);
    }
  }

  private accept(schedule: WitnessSchedule, minBlock: number): void {
    this.schedule = schedule;
    this.minBlockNumber = minBlock;
    rememberScheduleSignature(this.acceptedSignatures, scheduleSignature(schedule), minBlock);
  }

}

export interface ScheduledRoundRow {
  blockNumber: number;
  scheduledWitness: string;
  producedWitness?: string;
  settling?: boolean;
}

export interface ScheduledRoundRowsOptions {
  minBlockNumber?: number;
  headSlot?: number;
}

export function roundRowsOptions(props: DynamicGlobalProperties | undefined, blocks: BlockRecord[], minBlockNumber?: number): ScheduledRoundRowsOptions {
  const headBlockNumber = latestProducedBlockNumber(blocks) ?? props?.head_block_number;
  // DGPO's slot belongs to its head, which may be ahead of the followed blocks.
  let headSlot = props?.head_block_number === headBlockNumber ? props?.current_aslot : undefined;
  const head = blocks.find((block) => block.number === headBlockNumber);
  const chainHeadTime = props && new Date(props.time.endsWith("Z") ? props.time : `${props.time}Z`);
  if (headSlot === undefined && props?.current_aslot !== undefined && head && chainHeadTime) {
    const elapsedSlots = (chainHeadTime.getTime() - head.timestamp.getTime()) / 3000;
    if (Number.isInteger(elapsedSlots) && elapsedSlots >= 0) headSlot = props.current_aslot - elapsedSlots;
  }
  return { minBlockNumber, headSlot };
}

export function schedulePredictionsExpired(schedule: WitnessSchedule, headBlockNumber: number): boolean {
  return typeof schedule.next_shuffle_block_num === "number" &&
    headBlockNumber >= schedule.next_shuffle_block_num + (schedule.future_shuffled_witnesses?.length ?? 0);
}

export function scheduledRoundRows(
  headBlockNumber: number,
  schedule: WitnessSchedule,
  blocks: BlockRecord[],
  missedBlocks: MissedBlock[] = [],
  options: ScheduledRoundRowsOptions = {},
): ScheduledRoundRow[] {
  const witnesses = schedule.current_shuffled_witnesses ?? [];
  if (witnesses.length === 0) return [];
  const boundary = schedule.next_shuffle_block_num;
  if (options.headSlot !== undefined && boundary !== undefined) {
    const futureWitnesses = schedule.future_shuffled_witnesses ?? [];
    const roundStart = boundary - witnesses.length + 1;
    // Keep one round of lookahead; cross the boundary using the announced list.
    const roundEnd = Math.min(boundary + futureWitnesses.length, headBlockNumber + witnesses.length);
    if (headBlockNumber >= roundStart - 1 && headBlockNumber <= roundEnd) {
      const missesAtHead = missedBlocks.filter((miss) => miss.detectedAtBlock <= headBlockNumber).length;
      const producedByBlock = new Map(blocks.map((block) => [block.number, block]));
      return Array.from({ length: roundEnd - roundStart + 1 }, (_, index) => {
        const blockNumber = roundStart + index;
        const slot = options.headSlot! + blockNumber - headBlockNumber - missesAtHead +
          missedBlocks.filter((miss) => miss.detectedAtBlock < blockNumber).length;
        const activeWitnesses = blockNumber <= boundary ? witnesses : futureWitnesses;
        return {
          blockNumber,
          scheduledWitness: activeWitnesses[positiveModulo(slot, activeWitnesses.length)] ?? "unknown",
          producedWitness: producedByBlock.get(blockNumber)?.witness,
        };
      });
    }
  }
  const fit = bestScheduleFit(headBlockNumber, witnesses, blocks, missedBlocks, options.minBlockNumber);
  if (!scheduleFitIsFresh(fit, headBlockNumber, witnesses.length)) {
    return [
      {
        blockNumber: headBlockNumber,
        scheduledWitness: "settling",
        producedWitness: blocks.find((block) => block.number === headBlockNumber)?.witness,
        settling: true,
      },
    ];
  }

  const offset = fit.offset;
  const headSlot = slotPositionForProducedBlock(headBlockNumber, missedBlocks);
  const fitRoundStart = headBlockNumber - positiveModulo(headSlot + offset, witnesses.length);
  const roundStart = options.minBlockNumber === undefined ? fitRoundStart : Math.max(fitRoundStart, options.minBlockNumber);
  const producedByBlock = new Map<number, BlockRecord>();
  for (const block of blocks) {
    if (block.number >= roundStart && block.number < roundStart + witnesses.length) {
      producedByBlock.set(block.number, block);
    }
  }

  return Array.from({ length: witnesses.length }, (_, index) => {
    const blockNumber = roundStart + index;
    const produced = producedByBlock.get(blockNumber);
    const slotPosition = slotPositionForDisplayedBlock(blockNumber, missedBlocks);
    return {
      blockNumber,
      scheduledWitness: witnesses[positiveModulo(slotPosition + offset, witnesses.length)] ?? "unknown",
      producedWitness: produced?.witness,
    };
  });
}

function bestScheduleFit(
  headBlockNumber: number,
  witnesses: string[],
  blocks: BlockRecord[],
  missedBlocks: MissedBlock[],
  minBlockNumber?: number,
): { offset: number; matches: number; score: number; newestMatchBlock?: number } {
  const recentProducedBlocks = blocks
    .filter((block) => block.number <= headBlockNumber && (minBlockNumber === undefined || block.number >= minBlockNumber))
    .sort((a, b) => a.number - b.number)
    .slice(-witnesses.length * 2);
  const observations = scheduleObservations(recentProducedBlocks, missedBlocks);
  if (observations.length === 0) return { offset: 0, matches: 0, score: 0 };

  let bestOffset = 0;
  let bestScore = -1;
  let bestMatches = 0;
  let bestNewestMatchBlock: number | undefined;
  for (let offset = 0; offset < witnesses.length; offset += 1) {
    let score = 0;
    let matches = 0;
    let newestMatchBlock: number | undefined;
    for (const observation of observations) {
      if (witnesses[positiveModulo(observation.slotPosition + offset, witnesses.length)] === observation.witness) {
        matches += 1;
        if (newestMatchBlock === undefined || observation.blockNumber > newestMatchBlock) newestMatchBlock = observation.blockNumber;
        score += witnesses.length - Math.min(witnesses.length - 1, Math.max(0, headBlockNumber - observation.blockNumber));
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
      bestMatches = matches;
      bestNewestMatchBlock = newestMatchBlock;
    }
  }

  return { offset: bestOffset, matches: bestMatches, score: bestScore, newestMatchBlock: bestNewestMatchBlock };
}

function scheduleFitIsFresh(
  fit: { matches: number; newestMatchBlock?: number },
  headBlockNumber: number,
  witnessCount: number,
): boolean {
  if (fit.matches <= 0 || fit.newestMatchBlock === undefined) return false;
  return headBlockNumber - fit.newestMatchBlock < witnessCount;
}

function scheduleObservations(blocks: BlockRecord[], missedBlocks: MissedBlock[]): Array<{ blockNumber: number; slotPosition: number; witness: string }> {
  const sortedBlocks = [...blocks].sort((a, b) => a.number - b.number);
  const sortedMisses = [...missedBlocks].sort((a, b) => a.detectedAtBlock - b.detectedAtBlock);
  const observations: Array<{ blockNumber: number; slotPosition: number; witness: string }> = [];
  let missIndex = 0;
  let missesBeforeOrAtBlock = 0;

  for (const block of sortedBlocks) {
    while (missIndex < sortedMisses.length && sortedMisses[missIndex].detectedAtBlock < block.number) {
      missesBeforeOrAtBlock += 1;
      missIndex += 1;
    }

    while (missIndex < sortedMisses.length && sortedMisses[missIndex].detectedAtBlock === block.number) {
      observations.push({
        blockNumber: block.number,
        slotPosition: block.number + missesBeforeOrAtBlock,
        witness: sortedMisses[missIndex].witness,
      });
      missesBeforeOrAtBlock += 1;
      missIndex += 1;
    }

    observations.push({
      blockNumber: block.number,
      slotPosition: block.number + missesBeforeOrAtBlock,
      witness: block.witness,
    });
  }

  return observations;
}

function slotPositionForProducedBlock(blockNumber: number, missedBlocks: MissedBlock[]): number {
  return blockNumber + missedBlocks.filter((miss) => miss.detectedAtBlock <= blockNumber).length;
}

function slotPositionForDisplayedBlock(blockNumber: number, missedBlocks: MissedBlock[]): number {
  return blockNumber + missedBlocks.filter((miss) => miss.detectedAtBlock < blockNumber).length;
}

export function scheduleSignature(schedule: WitnessSchedule): string {
  return (schedule.current_shuffled_witnesses ?? []).join("\n");
}

export function rememberScheduleSignature(history: Map<string, number>, signature: string, blockNumber: number, maxSize = 32): void {
  history.delete(signature);
  history.set(signature, blockNumber);
  while (history.size > maxSize) {
    const oldest = history.keys().next().value;
    if (oldest === undefined) return;
    history.delete(oldest);
  }
}

export function latestProducedBlockNumber(blocks: BlockRecord[]): number | undefined {
  let latest: number | undefined;
  for (const block of blocks) {
    if (latest === undefined || block.number > latest) latest = block.number;
  }
  return latest;
}

export function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
