import { stripVTControlCharacters as stripAnsi } from "node:util";
import { HiveRpcError } from "./rpc.js";
export class TerminalUi {
    options;
    paused = false;
    scroll = 0;
    view = "blocks";
    txStatusMonitor;
    displayedRoundSchedule;
    displayedRoundScheduleMinBlock;
    acceptedRoundScheduleSignatures = new Map();
    observedRoundRows = new Map();
    roundRevealKey = "";
    revealedFutureRows = 0;
    futureRevealTarget = 0;
    predictedRowPool = [];
    lastVisiblePredictedRows = [];
    retractingPredictedRows = [];
    revealTimer;
    retractTimer;
    spinnerTimer;
    spinnerFrame = 0;
    latestEvent = null;
    latestDataEvent = null;
    latestSnapshot = null;
    startedAt = Date.now();
    constructor(options) {
        this.options = options;
        this.txStatusMonitor = options.transactionStatusClient ? new TransactionStatusMonitor(options.transactionStatusClient) : undefined;
    }
    start() {
        process.stdin.setEncoding("utf8");
        if (process.stdin.isTTY)
            process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", this.onKey);
        process.stdout.write("\x1b[?25l\x1b[2J");
    }
    stop() {
        process.stdin.off("data", this.onKey);
        this.stopRevealTimer();
        this.stopRetractTimer();
        this.stopSpinnerTimer();
        this.txStatusMonitor?.stop();
        if (process.stdin.isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
    }
    render(event, snapshot) {
        this.latestEvent = event;
        this.latestSnapshot = snapshot;
        this.txStatusMonitor?.sync(snapshot, () => this.draw());
        if ("dynamicGlobalProperties" in event) {
            this.latestDataEvent = event;
            this.updateDisplayedRoundSchedule(event, snapshot.blocks);
            this.recordObservedRoundRow(event, snapshot.blocks);
            this.updateRoundReveal(event, snapshot.blocks);
        }
        this.draw();
    }
    onKey = (chunk) => {
        if (chunk === "q" || chunk === "\u0003") {
            this.options.onQuit();
            return;
        }
        if (chunk === "p") {
            this.paused = !this.paused;
            this.options.onPauseToggle(this.paused);
            this.draw();
            return;
        }
        if (chunk === "r") {
            this.options.onReset();
            this.draw();
            return;
        }
        if (chunk === "v") {
            this.view = nextView(this.view);
            this.scroll = 0;
            this.updateSpinnerTimer();
            this.draw();
            return;
        }
        if (chunk === "\u001b[A")
            this.scroll = Math.max(0, this.scroll - 1);
        if (chunk === "\u001b[B")
            this.scroll += 1;
        if (chunk === "\u001b[5~")
            this.scroll = Math.max(0, this.scroll - 10);
        if (chunk === "\u001b[6~")
            this.scroll += 10;
        this.draw();
    };
    draw() {
        if (!this.latestSnapshot || !this.latestEvent)
            return;
        const columns = process.stdout.columns || 100;
        const rows = process.stdout.rows || 30;
        const snapshot = this.latestSnapshot;
        const statusEvent = this.latestEvent;
        const dataEvent = this.latestDataEvent ?? statusEvent;
        const status = headerSummary(statusEvent, this.view);
        const panelWidth = columns >= 100 ? Math.min(40, Math.max(32, Math.floor(columns * 0.34))) : 0;
        const gutterWidth = panelWidth > 0 ? 3 : 0;
        const mainWidth = columns - panelWidth - gutterWidth;
        const tableRows = Math.max(5, rows - 13);
        const mainLines = [];
        const panelLines = panelWidth > 0 ? dynamicPropertiesPanel(dataEvent, panelWidth) : [];
        mainLines.push(color(" HIVEtop ", "white", "red") + " " + status.padEnd(Math.max(0, mainWidth - 10)));
        mainLines.push([
            `node ${this.nodeLabel()}`,
            `window ${this.options.windowSeconds}s`,
            `uptime ${formatDuration(Date.now() - this.startedAt)}`,
            this.paused ? "PAUSED" : "LIVE",
        ].join("  |  "));
        mainLines.push([
            `blocks/s ${snapshot.blockRate.toFixed(2)}`,
            `tx/s ${snapshot.transactionRate.toFixed(2)}`,
            `ops/s ${snapshot.operationRate.toFixed(2)}`,
            `vops/s ${snapshot.virtualOperationRate.toFixed(2)}`,
            `view ${this.view}`,
        ].join("  |  "));
        mainLines.push(horizontal(mainWidth));
        if (this.view === "round") {
            mainLines.push(...roundTableLines(dataEvent, snapshot.blocks, this.displayedRoundSchedule, this.displayedRoundScheduleMinBlock, this.observedRoundRows, this.revealedFutureRows, this.retractingPredictedRows, this.spinnerFrame, this.scroll, tableRows, mainWidth));
        }
        else if (this.view === "txstatus") {
            mainLines.push(...txStatusTableLines(this.txStatusMonitor, this.scroll, tableRows, mainWidth));
        }
        else {
            mainLines.push(...blockTableLines(dataEvent, snapshot.blocks, this.scroll, tableRows, mainWidth));
        }
        while (mainLines.length < tableRows + 5)
            mainLines.push("");
        mainLines.push(horizontal(mainWidth));
        mainLines.push(fit(`Top ops: ${snapshot.operationTypes.slice(0, 5).map(([name, count]) => `${name}:${count}`).join("  ") || "none"}`, mainWidth));
        mainLines.push(fit(`Witnesses: ${snapshot.witnesses.slice(0, 5).map(([name, count]) => `${name}:${count}`).join("  ") || "none"}`, mainWidth));
        mainLines.push(horizontal(mainWidth));
        mainLines.push(fit("q quit  p pause/resume  r reset-to-head  v view  ↑/↓ scroll  PgUp/PgDn page", mainWidth));
        const lines = mainLines.map((line, index) => {
            if (panelWidth === 0)
                return fit(line, columns);
            return `${fit(line, mainWidth)}   ${fit(panelLines[index] ?? "", panelWidth)}`;
        });
        process.stdout.write("\x1b[H" + lines.slice(0, rows).map((line) => fit(line, columns)).join("\n") + "\x1b[J");
    }
    nodeLabel() {
        return typeof this.options.node === "function" ? this.options.node() : this.options.node;
    }
    updateDisplayedRoundSchedule(event, blocks) {
        const props = dynamicGlobalProperties(event);
        const candidate = witnessSchedule(event);
        if (!props || !candidate?.current_shuffled_witnesses?.length)
            return;
        const displayHeadBlock = latestProducedBlockNumber(blocks) ?? props.head_block_number;
        if (!this.displayedRoundSchedule) {
            this.acceptDisplayedRoundSchedule(candidate, displayHeadBlock);
            return;
        }
        const currentSignature = scheduleSignature(this.displayedRoundSchedule);
        const candidateSignature = scheduleSignature(candidate);
        const previousShuffle = this.displayedRoundSchedule.next_shuffle_block_num;
        const nextShuffle = candidate.next_shuffle_block_num;
        if (previousShuffle !== undefined && nextShuffle !== undefined && nextShuffle < previousShuffle)
            return;
        const advancesRound = previousShuffle !== undefined && nextShuffle !== undefined && nextShuffle > previousShuffle;
        // The boundary block is still produced by the old schedule.
        if (advancesRound && displayHeadBlock <= previousShuffle)
            return;
        if (currentSignature === candidateSignature && !advancesRound) {
            this.displayedRoundSchedule = candidate;
            return;
        }
        if (advancesRound && candidateSignature === (this.displayedRoundSchedule.future_shuffled_witnesses ?? []).join("\n")) {
            this.acceptDisplayedRoundSchedule(candidate, previousShuffle + 1);
            return;
        }
        if (!advancesRound && currentSignature !== candidateSignature && this.acceptedRoundScheduleSignatures.has(candidateSignature))
            return;
        const fit = bestScheduleFit(displayHeadBlock, candidate.current_shuffled_witnesses, blocks, event.missedBlocks, previousShuffle === undefined ? this.displayedRoundScheduleMinBlock : previousShuffle + 1);
        if (fit.matches >= 3 && fit.newestMatchBlock === displayHeadBlock) {
            this.acceptDisplayedRoundSchedule(candidate, previousShuffle === undefined ? displayHeadBlock : previousShuffle + 1);
        }
    }
    acceptDisplayedRoundSchedule(schedule, minBlock) {
        this.displayedRoundSchedule = schedule;
        this.displayedRoundScheduleMinBlock = minBlock;
        rememberScheduleSignature(this.acceptedRoundScheduleSignatures, scheduleSignature(schedule), minBlock);
    }
    recordObservedRoundRow(event, blocks) {
        if (event.type !== "block")
            return;
        const schedule = this.displayedRoundSchedule ?? event.witnessSchedule;
        if (!schedule?.current_shuffled_witnesses?.length)
            return;
        const rows = scheduledRoundRows(event.block.number, schedule, blocks, event.missedBlocks, roundRowsOptions(event, blocks, this.displayedRoundScheduleMinBlock));
        const row = rows.find((candidate) => candidate.blockNumber === event.block.number);
        if (!row || row.settling || !row.producedWitness)
            return;
        if (!shouldPersistObservedRoundRow(row, event.missedBlocks))
            return;
        this.observedRoundRows.set(row.blockNumber, row);
        trimObservedRows(this.observedRoundRows, 300);
    }
    updateRoundReveal(event, blocks) {
        const props = dynamicGlobalProperties(event);
        const schedule = this.displayedRoundSchedule ?? witnessSchedule(event);
        if (!props || !schedule?.current_shuffled_witnesses?.length) {
            this.roundRevealKey = "";
            this.revealedFutureRows = 0;
            this.futureRevealTarget = 0;
            this.predictedRowPool = [];
            this.lastVisiblePredictedRows = [];
            this.retractingPredictedRows = [];
            this.stopRevealTimer();
            this.stopRetractTimer();
            return;
        }
        const displayHeadBlock = latestProducedBlockNumber(blocks) ?? props.head_block_number;
        const suppressPredictions = schedulePredictionsExpired(schedule, displayHeadBlock);
        this.retractingPredictedRows = suppressPredictions ? [] : this.retractingPredictedRows.filter((row) => row.blockNumber > displayHeadBlock);
        const key = `${scheduleSignature(schedule)}:${this.displayedRoundScheduleMinBlock ?? ""}`;
        const activeRows = scheduledRoundRows(displayHeadBlock, schedule, blocks, event.missedBlocks, roundRowsOptions(event, blocks, this.displayedRoundScheduleMinBlock));
        const target = suppressPredictions ? 0 : countPredictedRows(activeRows, displayHeadBlock);
        const predictedRows = suppressPredictions ? [] : predictedRowsNearestFirst(activeRows, displayHeadBlock);
        if (key !== this.roundRevealKey) {
            const replacement = splitReplacementPredictions(this.lastVisiblePredictedRows, predictedRows);
            this.roundRevealKey = key;
            this.retractingPredictedRows = replacement.retractingRows;
            this.revealedFutureRows = this.retractingPredictedRows.length > 0 ? replacement.revealedCount : Math.max(replacement.revealedCount, Math.min(1, target));
            if (this.retractingPredictedRows.length > 0)
                this.startRetractTimer();
        }
        else {
            this.revealedFutureRows = Math.min(this.revealedFutureRows, target);
        }
        this.futureRevealTarget = target;
        this.predictedRowPool = predictedRows;
        this.updateLastVisiblePredictedRows();
        if (this.retractingPredictedRows.length === 0 && this.revealedFutureRows < this.futureRevealTarget)
            this.startRevealTimer();
        else
            this.stopRevealTimer();
        this.updateSpinnerTimer(displayHeadBlock);
    }
    startRevealTimer() {
        if (this.revealTimer)
            return;
        this.revealTimer = setInterval(() => {
            if (this.revealedFutureRows >= this.futureRevealTarget) {
                this.stopRevealTimer();
                return;
            }
            this.revealedFutureRows += 1;
            this.updateLastVisiblePredictedRows();
            this.draw();
        }, 500);
    }
    stopRevealTimer() {
        if (!this.revealTimer)
            return;
        clearInterval(this.revealTimer);
        this.revealTimer = undefined;
    }
    startRetractTimer() {
        if (this.retractTimer)
            return;
        this.retractTimer = setInterval(() => {
            if (this.retractingPredictedRows.length === 0) {
                this.stopRetractTimer();
                this.revealedFutureRows = Math.max(this.revealedFutureRows, Math.min(1, this.futureRevealTarget));
                this.updateLastVisiblePredictedRows();
                if (this.revealedFutureRows < this.futureRevealTarget)
                    this.startRevealTimer();
                this.draw();
                return;
            }
            this.retractingPredictedRows.shift();
            this.draw();
        }, 250);
    }
    stopRetractTimer() {
        if (!this.retractTimer)
            return;
        clearInterval(this.retractTimer);
        this.retractTimer = undefined;
    }
    startSpinnerTimer() {
        if (this.spinnerTimer)
            return;
        this.spinnerTimer = setInterval(() => {
            this.spinnerFrame += 1;
            this.draw();
        }, 250);
    }
    stopSpinnerTimer() {
        if (!this.spinnerTimer)
            return;
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = undefined;
    }
    updateSpinnerTimer(displayHeadBlock) {
        const headBlock = displayHeadBlock ?? latestProducedBlockNumber(this.latestSnapshot?.blocks ?? []);
        if (this.view === "round" && headBlock !== undefined && this.predictedRowPool.some((row) => row.blockNumber === headBlock + 1)) {
            this.startSpinnerTimer();
        }
        else {
            this.stopSpinnerTimer();
        }
    }
    updateLastVisiblePredictedRows() {
        this.lastVisiblePredictedRows = this.predictedRowPool.slice(0, this.revealedFutureRows);
    }
}
function nextView(view) {
    if (view === "blocks")
        return "round";
    if (view === "round")
        return "txstatus";
    return "blocks";
}
export class TransactionStatusMonitor {
    client;
    maxConcurrent;
    maxQueued;
    requestIntervalMs;
    maxRetainedBlocks;
    checkingDwellMs;
    maxBatchSize;
    cache = new Map();
    queued = new Set();
    checking = new Set();
    checkingTimers = new Map();
    retainedBlocks = new Map();
    queue = [];
    inFlight = 0;
    nextRequestAt = 0;
    pumpTimer;
    stopped = false;
    onUpdate;
    apiUnavailable = false;
    batchUnavailable = false;
    behindVisibleWindow = false;
    visibleBlockNumbers = new Set();
    activeGroupKey;
    warning;
    constructor(client, maxConcurrent = 4, maxQueued = 500, requestIntervalMs = 250, maxRetainedBlocks = 300, checkingDwellMs = 200, maxBatchSize = 8) {
        this.client = client;
        this.maxConcurrent = maxConcurrent;
        this.maxQueued = maxQueued;
        this.requestIntervalMs = requestIntervalMs;
        this.maxRetainedBlocks = maxRetainedBlocks;
        this.checkingDwellMs = checkingDwellMs;
        this.maxBatchSize = maxBatchSize;
    }
    stop() {
        this.stopped = true;
        this.queue = [];
        this.queued.clear();
        this.checking.clear();
        this.activeGroupKey = undefined;
        this.visibleBlockNumbers.clear();
        for (const timer of this.checkingTimers.values())
            clearTimeout(timer);
        this.checkingTimers.clear();
        this.retainedBlocks.clear();
        if (this.pumpTimer)
            clearTimeout(this.pumpTimer);
        this.pumpTimer = undefined;
    }
    sync(snapshot, onUpdate) {
        this.onUpdate = onUpdate;
        this.visibleBlockNumbers.clear();
        for (const block of snapshot.blocks)
            this.visibleBlockNumbers.add(block.number);
        for (const block of snapshot.blocks)
            this.retainedBlocks.set(block.number, block);
        this.trimRetainedBlocks();
        const visibleTransactions = new Set();
        for (const block of this.displayBlocks()) {
            for (const transaction of block.transactions) {
                visibleTransactions.add(transaction.id);
                if (this.apiUnavailable || this.cache.has(transaction.id) || this.queued.has(transaction.id) || this.checking.has(transaction.id))
                    continue;
                this.queue.push({
                    id: transaction.id,
                    expiration: transaction.expiration,
                    blockNumber: block.number,
                    primaryOperationType: transaction.primaryOperationType,
                });
                this.queued.add(transaction.id);
            }
        }
        for (const id of this.cache.keys()) {
            if (!visibleTransactions.has(id))
                this.cache.delete(id);
        }
        this.queue = this.queue.filter((item) => visibleTransactions.has(item.id)).sort(compareTxStatusQueueItems).slice(0, this.maxQueued);
        this.rebuildQueuedIndex();
        this.dropCompletedRetainedBlocks();
        this.updateBehindVisibleWindow();
        this.pump();
    }
    displayBlocks() {
        return [...this.retainedBlocks.values()].sort((a, b) => b.number - a.number);
    }
    statusFor(transactionId) {
        if (this.checking.has(transactionId))
            return { category: "checking", glyph: "*" };
        return this.cache.get(transactionId) ?? { category: "pending", glyph: "." };
    }
    diagnostic() {
        return this.warning;
    }
    budgetLine() {
        const backlog = this.queue.length + this.checking.size;
        const rate = this.requestIntervalMs > 0 ? 1000 / this.requestIntervalMs : Number.POSITIVE_INFINITY;
        const unit = this.behindVisibleWindow ? "batch" : "request";
        const rateLabel = Number.isFinite(rate) ? `${formatRate(rate)} ${unit}/s` : "unlimited";
        const eta = backlog > 0 && Number.isFinite(rate) ? `  eta ${Math.ceil(backlog / rate)}s` : "";
        const group = topQueueGroup(this.queue);
        const groupLabel = group ? `  group ${formatOperationName(group.key)}:${group.count}` : "";
        return `status RPC budget ${rateLabel}  backlog ${backlog}${groupLabel}${eta}`;
    }
    pump() {
        if (this.pumpTimer) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = undefined;
        }
        while (!this.stopped && !this.apiUnavailable && this.inFlight < this.maxConcurrent && this.queue.length > 0) {
            const now = Date.now();
            if (this.requestIntervalMs > 0 && now < this.nextRequestAt) {
                this.schedulePump(this.nextRequestAt - now);
                return;
            }
            const batch = this.nextBatch();
            if (batch.length === 0)
                return;
            this.inFlight += 1;
            for (const item of batch)
                this.checking.add(item.id);
            this.nextRequestAt = this.requestIntervalMs > 0 ? Math.max(now, this.nextRequestAt) + this.requestIntervalMs : 0;
            void this.checkBatch(batch);
        }
    }
    nextBatch() {
        this.queue = this.queue.filter((item) => !this.cache.has(item.id)).sort(compareTxStatusQueueItems);
        const group = this.activeQueueGroup();
        if (!group) {
            this.activeGroupKey = undefined;
            this.rebuildQueuedIndex();
            return [];
        }
        this.activeGroupKey = group.key;
        const selected = [];
        const remaining = [];
        for (const item of this.queue) {
            if (queueGroupKey(item) === group.key && selected.length < this.effectiveBatchSize())
                selected.push(item);
            else
                remaining.push(item);
        }
        this.queue = remaining;
        this.rebuildQueuedIndex();
        return selected;
    }
    activeQueueGroup() {
        if (this.activeGroupKey && this.queue.some((item) => queueGroupKey(item) === this.activeGroupKey)) {
            return { key: this.activeGroupKey, count: this.queue.filter((item) => queueGroupKey(item) === this.activeGroupKey).length };
        }
        return topQueueGroup(this.queue);
    }
    effectiveBatchSize() {
        return this.behindVisibleWindow ? this.maxBatchSize : 1;
    }
    schedulePump(delayMs) {
        if (this.pumpTimer || this.stopped)
            return;
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = undefined;
            this.pump();
        }, Math.max(0, delayMs));
    }
    rebuildQueuedIndex() {
        this.queued.clear();
        for (const item of this.queue)
            this.queued.add(item.id);
    }
    dropCompletedRetainedBlocks() {
        for (const block of this.retainedBlocks.values()) {
            if (this.visibleBlockNumbers.has(block.number))
                continue;
            if (block.transactions.every((transaction) => this.cache.has(transaction.id))) {
                this.retainedBlocks.delete(block.number);
            }
        }
    }
    updateBehindVisibleWindow() {
        this.behindVisibleWindow = [...this.retainedBlocks.keys()].some((blockNumber) => !this.visibleBlockNumbers.has(blockNumber));
    }
    trimRetainedBlocks() {
        while (this.retainedBlocks.size > this.maxRetainedBlocks) {
            const oldest = [...this.retainedBlocks.keys()].sort((a, b) => a - b)[0];
            if (oldest === undefined)
                return;
            this.retainedBlocks.delete(oldest);
        }
    }
    async checkBatch(batch) {
        try {
            const responses = await this.findTransactionBatch(batch);
            if (this.stopped)
                return;
            responses.forEach((response, index) => {
                const item = batch[index];
                if (item)
                    this.commitAfterCheckingDwell(item.id, transactionStatusEntry(response, item.blockNumber));
            });
        }
        catch (error) {
            if (this.stopped)
                return;
            const message = error instanceof Error ? error.message : String(error);
            if (isTransactionStatusApiUnavailable(error, message)) {
                this.apiUnavailable = true;
                this.warning = "transaction_status_api unavailable";
                this.queue = [];
                this.queued.clear();
            }
            else {
                for (const item of batch)
                    this.commitAfterCheckingDwell(item.id, { category: "unknown", glyph: "?", message });
                this.warning = `transaction status retryable error: ${message}`;
            }
        }
        finally {
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.onUpdate?.();
            this.pump();
        }
    }
    async findTransactionBatch(batch) {
        if (this.behindVisibleWindow && batch.length > 1 && !this.batchUnavailable && this.client.findTransactions) {
            try {
                return await this.client.findTransactions(batch);
            }
            catch (error) {
                if (isTransactionStatusApiUnavailable(error, error instanceof Error ? error.message : String(error)))
                    throw error;
                this.batchUnavailable = true;
                this.warning = "transaction status batch unsupported; using single requests";
            }
        }
        return Promise.all(batch.map((item) => this.client.findTransaction(item.id, item.expiration)));
    }
    commitAfterCheckingDwell(transactionId, entry) {
        if (this.checkingDwellMs <= 0) {
            this.checking.delete(transactionId);
            this.cache.set(transactionId, entry);
            this.dropCompletedRetainedBlocks();
            this.updateBehindVisibleWindow();
            return;
        }
        const previousTimer = this.checkingTimers.get(transactionId);
        if (previousTimer)
            clearTimeout(previousTimer);
        const timer = setTimeout(() => {
            this.checkingTimers.delete(transactionId);
            this.checking.delete(transactionId);
            this.cache.set(transactionId, entry);
            this.dropCompletedRetainedBlocks();
            this.updateBehindVisibleWindow();
            this.onUpdate?.();
            this.pump();
        }, this.checkingDwellMs);
        this.checkingTimers.set(transactionId, timer);
    }
}
function compareTxStatusQueueItems(a, b) {
    return expirationSortValue(a.expiration) - expirationSortValue(b.expiration) || a.blockNumber - b.blockNumber || a.id.localeCompare(b.id);
}
function topQueueGroup(queue) {
    const counts = new Map();
    for (const item of queue) {
        const key = queueGroupKey(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))[0];
}
function queueGroupKey(item) {
    return item.primaryOperationType ?? "unknown";
}
function expirationSortValue(expiration) {
    if (!expiration)
        return Number.POSITIVE_INFINITY;
    const parsed = parseHiveUtcTime(expiration);
    return parsed?.getTime() ?? Number.POSITIVE_INFINITY;
}
function formatRate(rate) {
    if (!Number.isFinite(rate))
        return "unlimited";
    return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1).replace(/\.0$/, "");
}
function transactionStatusEntry(response, expectedBlockNumber) {
    if (typeof response.block_num === "number" &&
        response.block_num > 0 &&
        response.status !== "within_mempool" &&
        response.block_num !== expectedBlockNumber) {
        return {
            category: "mismatch",
            glyph: "!",
            status: response.status,
            blockNum: response.block_num,
            message: `status block ${response.block_num} differs from observed block ${expectedBlockNumber}`,
        };
    }
    if (response.status === "within_irreversible_block")
        return { category: "irreversible", glyph: "I", status: response.status, blockNum: response.block_num };
    if (response.status === "within_reversible_block")
        return { category: "reversible", glyph: "R", status: response.status, blockNum: response.block_num };
    if (response.status === "within_mempool")
        return { category: "mempool", glyph: "M", status: response.status, blockNum: response.block_num };
    if (response.status === "too_old")
        return { category: "old", glyph: "T", status: response.status, blockNum: response.block_num };
    if (response.status === "expired_reversible" || response.status === "expired_irreversible") {
        return { category: "expired", glyph: "E", status: response.status, blockNum: response.block_num };
    }
    return { category: "unknown", glyph: "?", status: response.status, blockNum: response.block_num };
}
function isTransactionStatusApiUnavailable(error, message) {
    if (error instanceof HiveRpcError && error.method !== "transaction_status_api.find_transaction")
        return false;
    return /transaction_status_api|find_transaction|unknown api|method not found|does not exist|Assert Exception/i.test(message);
}
function blockTableLines(event, blocks, scroll, rowCount, width) {
    const lines = [fit("BLOCK       (RANK) WITNESS           TX     OPS    VOPS", width)];
    const feedAgeReference = chainTime(event);
    for (const block of blocks.slice(scroll, scroll + rowCount)) {
        lines.push(fit(`${String(block.number).padEnd(11)} ${formatRankedWitnessCell(block.witness, event.witnessRanks, event.witnessFeedUpdates, feedAgeReference, event.witnessVersions, event.majorityWitnessVersion, 22)} ${String(block.transactionCount).padStart(5)} ${String(block.operationCount).padStart(7)} ${String(block.virtualOperationCount).padStart(7)}`, width));
    }
    return lines;
}
function txStatusTableLines(monitor, scroll, rowCount, width) {
    const lines = [fit("BLOCK       TX   STATUS MAP", width)];
    if (!monitor) {
        lines.push(fit("transaction status monitor unavailable", width));
        return lines;
    }
    for (const block of monitor.displayBlocks().slice(scroll, scroll + rowCount)) {
        const prefix = `${String(block.number).padEnd(11)} ${String(block.transactionCount).padStart(3)}  `;
        const mapWidth = Math.max(0, width - stripAnsi(prefix).length);
        lines.push(fit(prefix + formatTransactionStatusMap(block, monitor, mapWidth), width));
    }
    const diagnostic = monitor.diagnostic();
    if (diagnostic)
        lines.push(fit(ansiStyle(diagnostic, "orange", false), width));
    lines.push(fit(monitor.budgetLine(), width));
    lines.push(fit(`${ansiStyle("█", "cyan", false)} checking  ${ansiStyle("█", "green", false)} irreversible  ${ansiStyle("█", "white", false)} reversible  ${ansiStyle("█", "orange", false)} pending/unknown  ${ansiStyle("█", "red", false)} expired/old`, width));
    return lines;
}
export function formatTransactionStatusMap(block, monitor, width) {
    if (width <= 0)
        return "";
    if (block.transactions.length === 0)
        return "-";
    if (block.transactions.length > width) {
        return Array.from({ length: width }, (_, index) => {
            const start = Math.floor((index * block.transactions.length) / width);
            const end = Math.max(start + 1, Math.floor(((index + 1) * block.transactions.length) / width));
            return formatTransactionStatusCell(mergeTransactionStatusEntries(block.transactions.slice(start, end).map((transaction) => monitor.statusFor(transaction.id))));
        }).join("");
    }
    const cellWidths = justifiedCellWidths(block.transactions.length, width);
    return block.transactions.map((transaction, index) => formatTransactionStatusCell(monitor.statusFor(transaction.id), cellWidths[index] ?? 1)).join("");
}
export function mergeTransactionStatusEntries(entries) {
    return [...entries].sort((a, b) => transactionStatusPriority(a.category) - transactionStatusPriority(b.category))[0] ?? { category: "pending", glyph: "." };
}
function transactionStatusPriority(category) {
    if (category === "checking")
        return 0;
    if (category === "expired" || category === "old" || category === "mismatch")
        return 1;
    if (category === "pending" || category === "unknown" || category === "mempool")
        return 2;
    if (category === "reversible")
        return 3;
    return 4;
}
export function justifiedCellWidths(cellCount, width) {
    if (cellCount <= 0 || width <= 0)
        return [];
    const base = Math.max(1, Math.floor(width / cellCount));
    const remainder = Math.max(0, width - base * cellCount);
    return Array.from({ length: cellCount }, (_, index) => base + (index < remainder ? 1 : 0));
}
export function formatTransactionStatusCell(entry, width = 1) {
    const cell = "█".repeat(width);
    if (entry.category === "checking")
        return ansiStyle(cell, "cyan", false);
    if (entry.category === "irreversible")
        return ansiStyle(cell, "green", false);
    if (entry.category === "mempool" || entry.category === "unknown" || entry.category === "pending")
        return ansiStyle(cell, "orange", false);
    if (entry.category === "expired" || entry.category === "old" || entry.category === "mismatch")
        return ansiStyle(cell, "red", false);
    return ansiStyle(cell, "white", false);
}
function roundTableLines(event, blocks, displayedSchedule, displayedScheduleMinBlock, observedRoundRows, revealedFutureRows, retractingPredictedRows, spinnerFrame, scroll, rowCount, width) {
    const lines = [fit("  BLOCK       SCHEDULED WITNESS        STATUS   VERSION   FEED", width)];
    const props = dynamicGlobalProperties(event);
    const schedule = displayedSchedule ?? witnessSchedule(event);
    if (!props || !schedule?.current_shuffled_witnesses?.length || typeof props.head_block_number !== "number") {
        lines.push(fit("waiting for witness schedule", width));
        return lines;
    }
    const displayHeadBlock = latestProducedBlockNumber(blocks) ?? props.head_block_number;
    const witnessCount = schedule.current_shuffled_witnesses.length;
    const roundEnd = typeof schedule.next_shuffle_block_num === "number"
        ? displayHeadBlock + positiveModulo(schedule.next_shuffle_block_num - displayHeadBlock, witnessCount)
        : undefined;
    const roundStart = roundEnd === undefined ? undefined : roundEnd - witnessCount + 1;
    if (roundStart !== undefined && roundEnd !== undefined) {
        lines.unshift(fit(`Current round ${roundStart}-${roundEnd} (${displayHeadBlock - roundStart + 1}/${witnessCount}) | > current`, width));
    }
    const activeRoundRows = stabilizeObservedRoundRows(scheduledRoundRows(displayHeadBlock, schedule, blocks, event.missedBlocks, roundRowsOptions(event, blocks, displayedScheduleMinBlock)), observedRoundRows);
    const roundRows = scrollingRoundRows(activeRoundRows, observedRoundRows, displayHeadBlock);
    const visibleRoundRows = mergeRetractingPredictions(revealPredictedRows(roundRows, displayHeadBlock, revealedFutureRows), retractingPredictedRows, displayHeadBlock);
    const rowStart = scroll === 0 ? 0 : clampedScrollStart(visibleRoundRows, scroll, rowCount);
    for (const row of visibleRoundRows.slice(rowStart, rowStart + rowCount)) {
        const roundMarker = roundStart !== undefined && roundEnd !== undefined && row.blockNumber >= roundStart && row.blockNumber <= roundEnd
            ? ansiStyle("> ", "cyan", false) : "  ";
        const scheduled = row.settling
            ? "settling".padEnd(22)
            : formatRankedWitnessCell(row.scheduledWitness, event.witnessRanks, event.witnessFeedUpdates, chainTime(event), event.witnessVersions, event.majorityWitnessVersion, 22);
        const producedStatus = formatRoundProducedStatus(row, displayHeadBlock, spinnerFrame, event.missedBlocks);
        const producedStatusCell = formatProducedStatusCell(producedStatus, 8);
        lines.push(fit(`${roundMarker}${String(row.blockNumber).padEnd(11)} ${scheduled} ${producedStatusCell} ${formatVersion(row.settling ? undefined : event.witnessVersions[row.scheduledWitness]).padEnd(9)} ${formatFeedAge(row.settling ? undefined : event.witnessFeedUpdates[row.scheduledWitness], chainTime(event)).padStart(6)}`, width));
    }
    const warning = roundScheduleWarning(activeRoundRows, [], event.missedBlocks);
    if (warning)
        lines.push(fit(ansiStyle(warning, "orange", false), width));
    if (event.scheduleDiagnostics?.message) {
        lines.push(fit(ansiStyle(event.scheduleDiagnostics.message, "orange", false), width));
    }
    return lines;
}
function roundRowsOptions(event, blocks, minBlockNumber) {
    const props = dynamicGlobalProperties(event);
    const headBlockNumber = latestProducedBlockNumber(blocks) ?? props?.head_block_number;
    // DGPO's slot belongs to its head, which may be ahead of the followed blocks.
    let headSlot = props?.head_block_number === headBlockNumber ? props?.current_aslot : undefined;
    const head = blocks.find((block) => block.number === headBlockNumber);
    const chainHeadTime = props && parseHiveUtcTime(props.time);
    if (headSlot === undefined && props?.current_aslot !== undefined && head && chainHeadTime) {
        const elapsedSlots = (chainHeadTime.getTime() - head.timestamp.getTime()) / 3000;
        if (Number.isInteger(elapsedSlots) && elapsedSlots >= 0)
            headSlot = props.current_aslot - elapsedSlots;
    }
    return { minBlockNumber, headSlot };
}
export function stabilizeObservedRoundRows(rows, observedRows) {
    return rows.map((row) => {
        const observed = observedRows.get(row.blockNumber);
        if (!observed)
            return row;
        if (row.producedWitness && row.producedWitness === row.scheduledWitness && observed.producedWitness !== observed.scheduledWitness) {
            return row;
        }
        return observed;
    });
}
export function shouldPersistObservedRoundRow(row, missedBlocks) {
    if (!row.producedWitness || row.settling)
        return false;
    if (row.producedWitness === row.scheduledWitness)
        return true;
    return missedBlocks.some((miss) => miss.detectedAtBlock === row.blockNumber);
}
export function scrollingRoundRows(activeRows, observedRows, headBlockNumber) {
    if (activeRows.length === 0)
        return [];
    const firstActiveBlock = activeRows[0].blockNumber;
    const oldestObservedBlock = Math.max(1, headBlockNumber - activeRows.length * 2);
    const rowsByBlock = new Map();
    for (const row of observedRows.values()) {
        if (row.blockNumber >= oldestObservedBlock && row.blockNumber < firstActiveBlock) {
            rowsByBlock.set(row.blockNumber, row);
        }
    }
    for (const row of activeRows)
        rowsByBlock.set(row.blockNumber, row);
    return [...rowsByBlock.values()].sort((a, b) => b.blockNumber - a.blockNumber);
}
export function revealPredictedRows(rows, headBlockNumber, revealedCount) {
    if (revealedCount <= 0)
        return rows.filter((row) => !isPredictedRow(row, headBlockNumber));
    const revealedBlocks = new Set(predictedRowsNearestFirst(rows, headBlockNumber)
        .slice(0, revealedCount)
        .map((row) => row.blockNumber));
    return rows.filter((row) => !isPredictedRow(row, headBlockNumber) || revealedBlocks.has(row.blockNumber));
}
export function mergeRetractingPredictions(rows, retractingRows, headBlockNumber = Number.POSITIVE_INFINITY) {
    if (retractingRows.length === 0)
        return rows;
    const rowsByBlock = new Map(rows.map((row) => [row.blockNumber, row]));
    for (const row of retractingRows) {
        if (row.blockNumber <= headBlockNumber)
            continue;
        if (!rowsByBlock.has(row.blockNumber))
            rowsByBlock.set(row.blockNumber, row);
    }
    return [...rowsByBlock.values()].sort((a, b) => b.blockNumber - a.blockNumber);
}
export function splitReplacementPredictions(visibleRows, newPredictedRowsNearestFirst) {
    const newRowKeys = new Set(newPredictedRowsNearestFirst.map(predictedRowKey));
    const visibleRowKeys = new Set(visibleRows.map(predictedRowKey));
    let revealedCount = 0;
    for (let index = 0; index < newPredictedRowsNearestFirst.length; index += 1) {
        if (visibleRowKeys.has(predictedRowKey(newPredictedRowsNearestFirst[index]))) {
            revealedCount = index + 1;
        }
    }
    return {
        revealedCount,
        retractingRows: visibleRows.filter((row) => !newRowKeys.has(predictedRowKey(row))).sort((a, b) => b.blockNumber - a.blockNumber),
    };
}
export function clampedScrollStart(rows, scroll, rowCount) {
    return Math.min(Math.max(0, scroll), Math.max(0, rows.length - rowCount));
}
function countPredictedRows(rows, headBlockNumber) {
    return rows.filter((row) => isPredictedRow(row, headBlockNumber)).length;
}
function predictedRowsNearestFirst(rows, headBlockNumber) {
    return rows.filter((row) => isPredictedRow(row, headBlockNumber)).sort((a, b) => a.blockNumber - b.blockNumber);
}
function predictedRowKey(row) {
    return `${row.blockNumber}\0${row.scheduledWitness}`;
}
function isPredictedRow(row, headBlockNumber) {
    return row.blockNumber > headBlockNumber && !row.producedWitness && !row.settling;
}
export function schedulePredictionsExpired(schedule, headBlockNumber) {
    return typeof schedule.next_shuffle_block_num === "number" &&
        headBlockNumber >= schedule.next_shuffle_block_num + (schedule.future_shuffled_witnesses?.length ?? 0);
}
export function scheduledRoundRows(headBlockNumber, schedule, blocks, missedBlocks = [], options = {}) {
    const witnesses = schedule.current_shuffled_witnesses ?? [];
    if (witnesses.length === 0)
        return [];
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
                const slot = options.headSlot + blockNumber - headBlockNumber - missesAtHead +
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
    const producedByBlock = new Map();
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
function bestScheduleFit(headBlockNumber, witnesses, blocks, missedBlocks, minBlockNumber) {
    const recentProducedBlocks = blocks
        .filter((block) => block.number <= headBlockNumber && (minBlockNumber === undefined || block.number >= minBlockNumber))
        .sort((a, b) => a.number - b.number)
        .slice(-witnesses.length * 2);
    const observations = scheduleObservations(recentProducedBlocks, missedBlocks);
    if (observations.length === 0)
        return { offset: 0, matches: 0, score: 0 };
    let bestOffset = 0;
    let bestScore = -1;
    let bestMatches = 0;
    let bestNewestMatchBlock;
    for (let offset = 0; offset < witnesses.length; offset += 1) {
        let score = 0;
        let matches = 0;
        let newestMatchBlock;
        for (const observation of observations) {
            if (witnesses[positiveModulo(observation.slotPosition + offset, witnesses.length)] === observation.witness) {
                matches += 1;
                if (newestMatchBlock === undefined || observation.blockNumber > newestMatchBlock)
                    newestMatchBlock = observation.blockNumber;
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
function scheduleFitIsFresh(fit, headBlockNumber, witnessCount) {
    if (fit.matches <= 0 || fit.newestMatchBlock === undefined)
        return false;
    return headBlockNumber - fit.newestMatchBlock < witnessCount;
}
function scheduleObservations(blocks, missedBlocks) {
    const sortedBlocks = [...blocks].sort((a, b) => a.number - b.number);
    const sortedMisses = [...missedBlocks].sort((a, b) => a.detectedAtBlock - b.detectedAtBlock);
    const observations = [];
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
function slotPositionForProducedBlock(blockNumber, missedBlocks) {
    return blockNumber + missedBlocks.filter((miss) => miss.detectedAtBlock <= blockNumber).length;
}
function slotPositionForDisplayedBlock(blockNumber, missedBlocks) {
    return blockNumber + missedBlocks.filter((miss) => miss.detectedAtBlock < blockNumber).length;
}
function scheduleSignature(schedule) {
    return (schedule.current_shuffled_witnesses ?? []).join("\n");
}
export function rememberScheduleSignature(history, signature, blockNumber, maxSize = 32) {
    history.delete(signature);
    history.set(signature, blockNumber);
    while (history.size > maxSize) {
        const oldest = history.keys().next().value;
        if (oldest === undefined)
            return;
        history.delete(oldest);
    }
}
function latestProducedBlockNumber(blocks) {
    let latest;
    for (const block of blocks) {
        if (latest === undefined || block.number > latest)
            latest = block.number;
    }
    return latest;
}
function trimObservedRows(rows, maxSize) {
    while (rows.size > maxSize) {
        const oldest = rows.keys().next().value;
        if (oldest === undefined)
            return;
        rows.delete(oldest);
    }
}
function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}
export function headerSummary(event, view) {
    const parts = [`view ${view}`];
    if ("dynamicGlobalProperties" in event) {
        parts.push(`head ${event.dynamicGlobalProperties.head_block_number}`);
        const libDelta = irreversibleDelta(event.dynamicGlobalProperties);
        if (libDelta > 0)
            parts.push(`LIB ${event.dynamicGlobalProperties.last_irreversible_block_num}`);
    }
    else if ("headBlock" in event) {
        parts.push(`head ${event.headBlock}`);
    }
    if ("lag" in event && event.lag > 0)
        parts.push(`lag ${event.lag}`);
    const issue = eventIssueSummary(event);
    if (issue)
        parts.push(issue);
    return parts.join("  |  ");
}
function eventIssueSummary(event) {
    if (event.type === "gap")
        return `missing ${event.blockNumber}; retry ${event.retryInMs}ms`;
    if (event.type === "retry")
        return `rpc retry ${event.retryInMs}ms: ${event.message}`;
    return undefined;
}
function chainTime(event) {
    if ("dynamicGlobalProperties" in event)
        return parseHiveUtcTime(event.dynamicGlobalProperties.time) ?? new Date();
    return new Date();
}
function dynamicGlobalProperties(event) {
    return "dynamicGlobalProperties" in event ? event.dynamicGlobalProperties : undefined;
}
function witnessSchedule(event) {
    return "witnessSchedule" in event ? event.witnessSchedule : undefined;
}
export function formatProducedStatus(row) {
    if (row.settling)
        return "?";
    if (!row.producedWitness)
        return "-";
    return row.producedWitness === row.scheduledWitness ? "√" : "x";
}
export function formatRoundProducedStatus(row, headBlockNumber, spinnerFrame, missedBlocks = []) {
    if (row.blockNumber === headBlockNumber + 1 && !row.producedWitness && !row.settling) {
        return spinnerGlyph(spinnerFrame);
    }
    if (isUnbackedMismatch(row, missedBlocks))
        return "?";
    return formatProducedStatus(row);
}
export function formatProducedStatusCell(status, width) {
    const cell = status.padEnd(width);
    if (status === "√")
        return ansiStyle(cell, "green", false);
    if (status === "x")
        return ansiStyle(cell, "red", false);
    if (status === "?")
        return ansiStyle(cell, "orange", false);
    return cell;
}
function spinnerGlyph(frame) {
    return ["|", "/", "-", "\\"][positiveModulo(frame, 4)] ?? "|";
}
export function roundScheduleWarning(rows, _futureRows = [], missedBlocks = []) {
    const ambiguous = rows.some((row) => formatProducedStatus(row) === "?");
    const provisionalMismatch = rows.some((row) => isUnbackedMismatch(row, missedBlocks));
    const backedMismatch = firstBackedMismatch(rows, missedBlocks);
    if (!ambiguous && !provisionalMismatch && !backedMismatch)
        return undefined;
    if (provisionalMismatch)
        return "schedule provisional: unmatched witness has no producer_missed evidence";
    if (backedMismatch) {
        return `missed block: ${backedMismatch.scheduledWitness} missed, ${backedMismatch.producedWitness} produced`;
    }
    return "schedule settling: waiting for a verifiable schedule fit";
}
function isBackedMismatch(row, missedBlocks) {
    return formatProducedStatus(row) === "x" && missedBlocks.some((miss) => miss.detectedAtBlock === row.blockNumber);
}
function firstBackedMismatch(rows, missedBlocks) {
    return rows.find((row) => isBackedMismatch(row, missedBlocks));
}
function isUnbackedMismatch(row, missedBlocks) {
    return formatProducedStatus(row) === "x" && !missedBlocks.some((miss) => miss.detectedAtBlock === row.blockNumber);
}
function formatVersion(value) {
    return value ?? "-";
}
export function formatFeedAge(value, now = new Date()) {
    const updatedAt = parseHiveUtcTime(value);
    if (!updatedAt)
        return "-";
    const ageMs = now.getTime() - updatedAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0)
        return "-";
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    if (hours >= 24)
        return "24h+";
    if (hours > 0)
        return `${hours}h${String(minutes).padStart(2, "0")}`;
    return `${minutes}m`;
}
function dynamicPropertiesPanel(event, width) {
    const props = "dynamicGlobalProperties" in event ? event.dynamicGlobalProperties : undefined;
    const lines = [color(" dgpo ", "white", "red") + " dynamic global properties", horizontal(width)];
    if (!props) {
        lines.push("waiting for RPC data");
    }
    else {
        lines.push(...propertyRows(props).map(([label, value]) => `${label.padEnd(14)} ${value}`));
        lines.push("");
        lines.push(...dhfPanel(props));
    }
    lines.push("");
    lines.push(...rcPanel(event.rcInfo));
    lines.push("");
    lines.push(...hardforkPanel(event.hardforkInfo));
    lines.push("");
    lines.push(...missedBlocksPanel(event.missedBlocks));
    return lines;
}
function dhfPanel(props) {
    return [
        color(" dhf ", "white", "red") + " treasury / proposals",
        `Ledger       ${formatValue(props.dhf_interval_ledger)}`,
        `Maint        ${formatMaintenanceCountdown(props.next_maintenance_time, props.time)}`,
        `Daily        ${formatMaintenanceCountdown(props.next_daily_maintenance_time, props.time)}`,
    ];
}
function rcPanel(info) {
    const lines = [color(" rc ", "white", "red") + " resource credits"];
    if (!info) {
        lines.push("waiting for RC stats");
        return lines;
    }
    lines.push(`Vote          ${formatCompactNumber(info.voteCost)}`);
    lines.push(`Comment       ${formatCompactNumber(info.commentCost)}`);
    lines.push(`Transfer      ${formatCompactNumber(info.transferCost)}`);
    lines.push(`Low <5%       ${formatCompactNumber(info.lowRcUnder5)}`);
    lines.push(`Low <20%      ${formatCompactNumber(info.lowRcUnder20)}`);
    lines.push(`Dry Vote      ${formatCompactNumber(info.cantAffordVote)}`);
    lines.push(`Dry Comment   ${formatCompactNumber(info.cantAffordComment)}`);
    lines.push(`Top Op        ${formatOperationName(info.topOperation)}`);
    return lines;
}
function hardforkPanel(info) {
    const lines = [color(" hardfork ", "white", "red") + " latest / next"];
    if (!info) {
        lines.push("Latest        -");
        lines.push("Next          -");
        lines.push("Live Time     -");
        return lines;
    }
    lines.push(`Latest        ${formatValue(info.currentVersion)}`);
    lines.push(`Next          ${formatValue(info.nextVersion)}`);
    lines.push(`Live Time     ${formatValue(info.nextLiveTime)}`);
    return lines;
}
function missedBlocksPanel(missedBlocks) {
    const lines = [color(" missed ", "white", "red") + " recent blocks"];
    if (missedBlocks.length === 0) {
        lines.push("none detected");
        return lines;
    }
    lines.push(...formatMissedBlockRows(missedBlocks));
    return lines;
}
export function formatMissedBlockRows(missedBlocks) {
    return missedBlocks.slice(0, 5).map((miss) => `@${miss.detectedAtBlock} ${miss.witness}`);
}
export function formatRankedWitness(witness, ranks, feedUpdates = {}, now = new Date(), versions = {}, majorityVersion) {
    return styleRankedWitness(rankedWitnessText(witness, ranks), witness, feedUpdates, now, versions, majorityVersion);
}
export function formatRankedWitnessCell(witness, ranks, feedUpdates = {}, now = new Date(), versions = {}, majorityVersion = undefined, width = 22) {
    const value = rankedWitnessText(witness, ranks).padEnd(width);
    return styleRankedWitness(value, witness, feedUpdates, now, versions, majorityVersion);
}
function rankedWitnessText(witness, ranks) {
    const rank = ranks[witness];
    return `#${rank ?? "-"} ${witness}`;
}
function styleRankedWitness(value, witness, feedUpdates, now, versions, majorityVersion) {
    const inverted = Boolean(majorityVersion && versions[witness] === majorityVersion);
    const freshness = priceFeedFreshness(feedUpdates[witness], now);
    if (freshness === "fresh")
        return ansiStyle(value, "green", inverted);
    if (freshness === "stale")
        return ansiStyle(value, "orange", inverted);
    if (freshness === "expired")
        return ansiStyle(value, "red", inverted);
    return inverted ? ansiStyle(value, undefined, true) : value;
}
export function priceFeedFreshness(value, now = new Date()) {
    if (!value)
        return "unknown";
    const updatedAt = parseHiveUtcTime(value);
    if (!updatedAt)
        return "unknown";
    const ageMs = now.getTime() - updatedAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0)
        return "unknown";
    if (ageMs <= 6 * 60 * 60 * 1000)
        return "fresh";
    if (ageMs < 24 * 60 * 60 * 1000)
        return "stale";
    return "expired";
}
export function parseHiveUtcTime(value) {
    if (!value)
        return undefined;
    const parsed = new Date(value.endsWith("Z") ? value : `${value}Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}
export function propertyRows(props) {
    const rows = [
        ["Head", formatValue(props.head_block_number)],
        ["Witness", formatValue(props.current_witness)],
        ["Time", formatValue(props.time)],
        ["Supply", formatValue(props.current_supply)],
        ["HBD Supply", formatValue(props.current_hbd_supply)],
        ["Vest Fund", formatValue(props.total_vesting_fund_hive)],
        ["Vest Shares", formatMvests(props.total_vesting_shares)],
        ["HBD Interest", formatPercentBasisPoints(props.hbd_interest_rate)],
        ["HBD Print", formatPercentBasisPoints(props.hbd_print_rate)],
        ["Max Block", formatValue(props.maximum_block_size)],
        ["Participation", formatParticipation(props.participation_count)],
        ["Subsidies", formatValue(props.available_account_subsidies)],
    ];
    if (irreversibleDelta(props) > 0)
        rows.splice(1, 0, ["LIB", formatValue(props.last_irreversible_block_num)]);
    return rows;
}
function irreversibleDelta(props) {
    if (typeof props.last_irreversible_block_num !== "number")
        return 0;
    return Math.max(0, props.head_block_number - props.last_irreversible_block_num);
}
function formatValue(value) {
    if (value === undefined || value === null || value === "")
        return "-";
    return String(value);
}
function formatPercentBasisPoints(value) {
    if (typeof value !== "number")
        return formatValue(value);
    return `${(value / 100).toFixed(2)}%`;
}
export function formatParticipation(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return formatValue(value);
    return `${((value / 128) * 100).toFixed(2)}%`;
}
export function formatMvests(value) {
    if (typeof value !== "string")
        return formatValue(value);
    const match = value.match(/^(-?\d+(?:\.\d+)?)\s+VESTS$/);
    if (!match)
        return formatValue(value);
    return `${formatMvestsNumber(Number(match[1]) / 1_000_000)} MVESTS`;
}
export function formatMaintenanceCountdown(nextTime, currentTime) {
    if (typeof nextTime !== "string" || typeof currentTime !== "string")
        return "-";
    const next = parseHiveUtcTime(nextTime);
    const current = parseHiveUtcTime(currentTime);
    if (!next || !current)
        return "-";
    const deltaMs = next.getTime() - current.getTime();
    if (deltaMs <= 0)
        return "due";
    return formatDuration(deltaMs);
}
function formatMvestsNumber(value) {
    if (!Number.isFinite(value))
        return "-";
    return value.toLocaleString("en-US", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
        useGrouping: true,
    });
}
function formatCompactNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return "-";
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000_000_000)
        return `${(value / 1_000_000_000_000).toFixed(2)}T`;
    if (absolute >= 1_000_000_000)
        return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (absolute >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (absolute >= 1_000)
        return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
}
function formatOperationName(value) {
    if (!value)
        return "-";
    return value.replace(/_operation$/, "").replaceAll("_", " ");
}
function horizontal(columns) {
    return "─".repeat(columns);
}
function fit(input, columns) {
    const visible = stripAnsi(input);
    if (visible.length === columns)
        return input;
    if (visible.length > columns)
        return input.slice(0, Math.max(0, columns - 1)) + "…";
    return input + " ".repeat(columns - visible.length);
}
function color(text, _fg, _bg) {
    return `\x1b[37;41;1m${text}\x1b[0m`;
}
function ansiStyle(text, fg, inverted) {
    const codes = ["1"];
    if (fg)
        codes.push(String({ green: 32, orange: 33, red: 31, cyan: 36, white: 37 }[fg]));
    if (inverted)
        codes.push("7");
    return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0)
        return `${hours}h${minutes % 60}m`;
    if (minutes > 0)
        return `${minutes}m${seconds % 60}s`;
    return `${seconds}s`;
}
