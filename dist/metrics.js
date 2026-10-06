export class MetricsStore {
    windowSeconds;
    maxBlocks;
    blocks = [];
    latestBlockTime;
    constructor(windowSeconds, maxBlocks = 300) {
        this.windowSeconds = windowSeconds;
        this.maxBlocks = maxBlocks;
    }
    record(block, now = block.timestamp) {
        this.blocks.unshift(block);
        if (!this.latestBlockTime || block.timestamp.getTime() > this.latestBlockTime.getTime()) {
            this.latestBlockTime = block.timestamp;
        }
        this.evict(now);
    }
    snapshot(now = this.latestBlockTime ?? new Date()) {
        this.evict(now);
        const seconds = Math.max(1, this.windowSeconds);
        const operationTypes = new Map();
        const witnesses = new Map();
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
    evict(now) {
        const cutoff = now.getTime() - this.windowSeconds * 1000;
        this.blocks = this.blocks
            .filter((block) => block.timestamp.getTime() >= cutoff)
            .slice(0, this.maxBlocks);
    }
}
function sortedEntries(map) {
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
