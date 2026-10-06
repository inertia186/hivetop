import { stripVTControlCharacters as stripAnsi } from "node:util";
import { emitKeypressEvents } from "node:readline";
import { WitnessScheduleTracker, latestProducedBlockNumber, positiveModulo, roundRowsOptions, scheduleSignature, schedulePredictionsExpired, scheduledRoundRows } from "./schedule.js";
export { rememberScheduleSignature, schedulePredictionsExpired, scheduledRoundRows } from "./schedule.js";
import { HiveRpcError } from "./rpc.js";
export class TerminalUi {
    options;
    paused = false;
    scroll = 0;
    view = "blocks";
    stopped = false;
    healthTimer;
    lastDataReceivedAt;
    previousState = "CONNECTING";
    previousEndpoint;
    eventHistory = [];
    selectedBlock;
    tableBlockNumbers = [];
    tableCapacity = 10;
    witnessFilter = "";
    searchInput;
    overlay;
    overlayScroll = 0;
    detailBlock;
    notice = "";
    noColor;
    txStatusMonitor;
    sizeAbort;
    sizeError = "";
    sizeRetryAt = 0;
    scheduleTracker = new WitnessScheduleTracker();
    get displayedRoundSchedule() { return this.scheduleTracker.schedule; }
    get displayedRoundScheduleMinBlock() { return this.scheduleTracker.minBlockNumber; }
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
        this.view = options.view ?? "blocks";
        this.noColor = options.noColor ?? Boolean(process.env.NO_COLOR);
        this.txStatusMonitor = options.transactionStatusClient ? new TransactionStatusMonitor(options.transactionStatusClient) : undefined;
    }
    start() {
        emitKeypressEvents(process.stdin);
        process.stdin.setEncoding("utf8");
        if (process.stdin.isTTY)
            process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("keypress", this.onKey);
        process.stdout.on("resize", this.onResize);
        process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[HConnecting to Hive...  q quit");
        this.healthTimer = setInterval(() => this.draw(), 1000);
    }
    stop() {
        this.stopped = true;
        process.stdin.off("keypress", this.onKey);
        process.stdout.off("resize", this.onResize);
        if (this.healthTimer)
            clearInterval(this.healthTimer);
        this.stopRevealTimer();
        this.stopRetractTimer();
        this.stopSpinnerTimer();
        this.txStatusMonitor?.stop();
        this.sizeAbort?.abort();
        if (process.stdin.isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[?25h\x1b[0m\x1b[?1049l");
    }
    render(event, snapshot) {
        if (this.stopped)
            return;
        const previous = this.latestEvent;
        const oldMisses = new Set((previous?.missedBlocks ?? []).map((miss) => `${miss.detectedAtBlock}:${miss.witness}`));
        for (const miss of event.missedBlocks) {
            if (!oldMisses.has(`${miss.detectedAtBlock}:${miss.witness}`))
                this.addEvent(`Missed block ${miss.detectedAtBlock}: ${miss.witness}`);
        }
        if (event.type === "retry" && (previous?.type !== "retry" || previous.message !== event.message))
            this.addEvent(`RPC interrupted: ${event.message}`);
        if (event.type === "gap")
            this.addEvent(`Waiting for block ${event.blockNumber}`);
        if (event.scheduleDiagnostics && event.scheduleDiagnostics.changedAtBlock !== previous?.scheduleDiagnostics?.changedAtBlock) {
            this.addEvent(`Block ${event.scheduleDiagnostics.changedAtBlock}: ${event.scheduleDiagnostics.message}`);
        }
        for (const [panel, error] of Object.entries(event.panelErrors ?? {})) {
            if (error.message !== previous?.panelErrors?.[panel]?.message)
                this.addEvent(`${panel} unavailable/stale: ${error.message}`);
        }
        this.latestEvent = event;
        this.latestSnapshot = snapshot;
        this.txStatusMonitor?.sync(snapshot, () => this.draw());
        if ("dynamicGlobalProperties" in event) {
            this.lastDataReceivedAt = Date.now();
            this.latestDataEvent = event;
            this.updateDisplayedRoundSchedule(event, snapshot.blocks);
            this.recordObservedRoundRow(event, snapshot.blocks);
            this.updateRoundReveal(event, snapshot.blocks);
        }
        this.draw();
    }
    onResize = () => { this.draw(); };
    onKey = (chunk, key) => {
        chunk = key?.sequence ?? chunk ?? "";
        if (chunk === "\u0003" || (chunk === "q" && this.searchInput === undefined)) {
            this.options.onQuit();
            return;
        }
        if (this.searchInput !== undefined) {
            if (chunk === "\r" || chunk === "\n") {
                this.witnessFilter = this.searchInput.trim().toLowerCase();
                this.searchInput = undefined;
                this.selectedBlock = undefined;
                this.scroll = 0;
            }
            else if (chunk === "\u001b")
                this.searchInput = undefined;
            else if (chunk === "\u007f" || chunk === "\b")
                this.searchInput = this.searchInput.slice(0, -1);
            else if (/^[a-zA-Z0-9.\- ]+$/.test(chunk))
                this.searchInput = (this.searchInput + chunk).slice(0, 64);
            this.draw();
            return;
        }
        if (chunk === "?" || chunk === "e") {
            const overlay = chunk === "?" ? "help" : "events";
            this.overlay = this.overlay === overlay ? undefined : overlay;
            this.overlayScroll = 0;
        }
        else if (chunk === "\u001b") {
            if (this.overlay)
                this.overlay = undefined;
            else {
                this.witnessFilter = "";
                this.selectedBlock = undefined;
                this.scroll = 0;
            }
            this.notice = "";
        }
        else if (chunk === "/") {
            this.searchInput = this.witnessFilter;
            this.overlay = undefined;
        }
        else if (chunk === "\r" || chunk === "\n") {
            const number = this.selectedBlock ?? this.latestSnapshot?.blocks.find((block) => this.tableBlockNumbers.includes(block.number))?.number;
            this.detailBlock = [...(this.latestSnapshot?.blocks ?? []), ...(this.txStatusMonitor?.displayBlocks() ?? [])].find((block) => block.number === number);
            if (this.detailBlock) {
                this.overlay = "detail";
                this.overlayScroll = 0;
            }
            else
                this.notice = "Block details become available after production.";
        }
        if (chunk === "p") {
            this.paused = !this.paused;
            this.options.onPauseToggle(this.paused);
            this.draw();
            return;
        }
        if (chunk === "r") {
            this.selectedBlock = undefined;
            this.scroll = 0;
            this.overlay = undefined;
            this.options.onReset();
            this.draw();
            return;
        }
        if (chunk === "v") {
            this.view = nextView(this.view);
            this.scroll = 0;
            this.selectedBlock = undefined;
            this.overlay = undefined;
            this.updateSpinnerTimer();
            this.draw();
            return;
        }
        const delta = chunk === "\u001b[A" || chunk === "k" ? -1 : chunk === "\u001b[B" || chunk === "j" ? 1
            : chunk === "\u001b[5~" ? -this.tableCapacity : chunk === "\u001b[6~" ? this.tableCapacity : 0;
        if (delta) {
            if (this.overlay)
                this.overlayScroll = Math.max(0, this.overlayScroll + delta);
            else {
                const index = this.selectedBlock === undefined ? this.scroll : Math.max(0, this.tableBlockNumbers.indexOf(this.selectedBlock)) + delta;
                this.selectedBlock = this.tableBlockNumbers[Math.max(0, Math.min(this.tableBlockNumbers.length - 1, index))];
            }
        }
        if (key?.name === "home" || chunk === "g") {
            this.selectedBlock = undefined;
            this.scroll = 0;
            this.overlayScroll = 0;
        }
        this.draw();
    };
    addEvent(message) {
        if (this.eventHistory[0]?.message === message)
            return;
        this.eventHistory.unshift({ time: Date.now(), message });
        this.eventHistory.length = Math.min(100, this.eventHistory.length);
    }
    connectionState(now = Date.now()) {
        if (this.paused)
            return "PAUSED";
        if (this.latestEvent?.type === "retry")
            return "RECONNECTING";
        if (this.lastDataReceivedAt === undefined)
            return "CONNECTING";
        const props = this.latestDataEvent && dynamicGlobalProperties(this.latestDataEvent);
        const chainTime = props ? parseHiveUtcTime(props.time)?.getTime() : undefined;
        if (now - this.lastDataReceivedAt > 15_000 || (chainTime !== undefined && now - chainTime > 15_000))
            return "STALE";
        if (this.latestEvent?.type === "gap")
            return "WAITING FOR BLOCK";
        if (this.latestEvent && "lag" in this.latestEvent && this.latestEvent.lag > 0)
            return "CATCHING UP";
        return "LIVE";
    }
    draw() {
        if (this.stopped || !this.latestSnapshot || !this.latestEvent)
            return;
        const columns = Math.max(20, process.stdout.columns || 100);
        const rows = Math.max(6, process.stdout.rows || 30);
        const now = Date.now();
        const snapshot = this.latestSnapshot;
        const statusEvent = this.latestEvent;
        const dataEvent = this.latestDataEvent ?? statusEvent;
        const state = this.connectionState(now);
        if (state !== this.previousState) {
            this.addEvent(`Connection: ${this.previousState} -> ${state}`);
            this.previousState = state;
        }
        const endpoint = this.nodeLabel();
        if (endpoint !== this.previousEndpoint) {
            this.addEvent(this.previousEndpoint ? `Node switched: ${this.previousEndpoint} -> ${endpoint}` : `Using node: ${endpoint}`);
            this.previousEndpoint = endpoint;
        }
        const panelWidth = !this.options.compact && columns >= 120 ? Math.min(40, Math.floor(columns * 0.3)) : 0;
        const mainWidth = columns - (panelWidth ? panelWidth + 3 : 0);
        const compact = Boolean(this.options.compact || mainWidth < 70);
        const panelLines = panelWidth ? dynamicPropertiesPanel(dataEvent, panelWidth) : [];
        const health = this.options.transactionStatusClient?.health;
        const lastBlock = snapshot.blocks[0];
        const blockAge = lastBlock ? `${Math.max(0, Math.floor((now - lastBlock.timestamp.getTime()) / 1000))}s ago` : "waiting";
        const rpcAge = health?.lastResponseAt === undefined ? "" : ` / ${Math.max(0, Math.floor((now - health.lastResponseAt) / 1000))}s ago`;
        const mainLines = [
            color(" HIVEtop ", "white", "red") + " " + headerSummary(statusEvent, this.view),
            `${state} | block ${blockAge} | RPC ${health?.latencyMs === undefined ? "-" : `${health.latencyMs}ms`}${rpcAge}`,
            `node ${endpoint} | window ${this.options.windowSeconds}s | uptime ${formatDuration(now - this.startedAt)}`,
            `${state === "STALE" || state === "RECONNECTING" || state === "PAUSED" ? "cached " : ""}blk/s ${snapshot.blockRate.toFixed(2)} | tx/s ${snapshot.transactionRate.toFixed(2)} | ops/s ${snapshot.operationRate.toFixed(2)}${compact ? "" : ` | vops/s ${snapshot.virtualOperationRate.toFixed(2)}`}`,
        ];
        const errors = Object.keys(statusEvent.panelErrors ?? {});
        if (errors.length)
            mainLines.push(`Unavailable/stale: ${errors.join(", ")} (? help, e events)`);
        if (this.witnessFilter)
            mainLines.push(`Witness filter: ${this.witnessFilter} (Esc clears)`);
        mainLines.push(horizontal(mainWidth));
        const controls = this.searchInput !== undefined ? `/ Witness: ${this.searchInput}_ (Enter applies, Esc cancels)`
            : this.notice || (compact ? "q quit  v view  / find  Enter inspect  ? help  e events" : "q quit  p pause  r head  v view  / witness  Enter inspect  ? help  e events");
        const footer = [horizontal(mainWidth), `Top ops: ${snapshot.operationTypes.slice(0, 4).map(([name, count]) => `${name}:${count}`).join("  ") || "none"}`,
            `Witnesses: ${snapshot.witnesses.slice(0, 5).map(([name, count]) => `${name}:${count}`).join("  ") || "none"}`, controls];
        const tableBudget = Math.max(1, rows - mainLines.length - footer.length);
        const tableRows = Math.max(1, tableBudget - (this.view === "round" ? 4 : this.view === "txstatus" ? 5 : 1));
        this.tableCapacity = tableRows;
        const selection = { selectedBlock: this.selectedBlock, witnessFilter: this.witnessFilter, blockNumbers: [], scroll: this.scroll };
        this.measureBlockSizes();
        let tableLines;
        if (this.overlay) {
            const content = this.overlay === "help" ? helpLines()
                : this.overlay === "events" ? ["EVENT HISTORY (UTC, newest first; up to 100)", ...this.eventHistory.map((event) => `${new Date(event.time).toISOString().slice(11, 19)} ${event.message}`)]
                    : blockDetailLines(this.detailBlock, this.txStatusMonitor);
            const wrapped = content.flatMap((line) => wrapLine(line, mainWidth));
            this.overlayScroll = Math.min(this.overlayScroll, Math.max(0, wrapped.length - tableBudget));
            tableLines = wrapped.slice(this.overlayScroll, this.overlayScroll + tableBudget);
        }
        else if (this.view === "round") {
            tableLines = roundTableLines(dataEvent, snapshot.blocks, this.displayedRoundSchedule, this.displayedRoundScheduleMinBlock, this.observedRoundRows, this.revealedFutureRows, this.retractingPredictedRows, this.spinnerFrame, this.scroll, tableRows, mainWidth, selection, compact);
        }
        else if (this.view === "txstatus") {
            tableLines = txStatusTableLines(this.txStatusMonitor, this.scroll, tableRows, mainWidth, selection, Boolean(this.options.ascii || this.noColor));
        }
        else if (this.view === "sizes") {
            tableLines = blockSizeChartLines(snapshot.blocks, this.options.windowSeconds, tableBudget - (this.sizeError ? 1 : 0), mainWidth, Boolean(this.options.ascii), this.witnessFilter, this.noColor);
            if (this.sizeError)
                tableLines.splice(1, 0, `Size RPC: ${this.sizeError}`);
        }
        else {
            tableLines = blockTableLines(dataEvent, snapshot.blocks, this.scroll, tableRows, mainWidth, selection, compact);
        }
        if (!this.overlay) {
            this.tableBlockNumbers = selection.blockNumbers;
            this.scroll = selection.scroll;
        }
        mainLines.push(...tableLines.slice(0, tableBudget));
        while (mainLines.length < rows - footer.length)
            mainLines.push("");
        mainLines.push(...footer);
        let output = mainLines.slice(0, rows).map((line, index) => {
            const main = fit(line, mainWidth);
            return panelWidth ? `${main}   ${fit(panelLines[index] ?? "", panelWidth)}` : main;
        }).join("\n");
        if (this.noColor)
            output = stripAnsi(output);
        if (this.options.ascii)
            output = output.replace(/√/g, "+").replace(/─/g, "-").replace(/↑/g, "^").replace(/↓/g, "v").replace(/…/g, "~").replace(/[^\x00-\x7f]/g, "?");
        process.stdout.write("\x1b[H" + output + "\x1b[J");
    }
    nodeLabel() {
        return typeof this.options.node === "function" ? this.options.node() : this.options.node;
    }
    measureBlockSizes() {
        if (this.view !== "sizes" || this.overlay) {
            this.sizeAbort?.abort();
            return;
        }
        if (this.sizeAbort || Date.now() < this.sizeRetryAt)
            return;
        const block = this.latestSnapshot?.blocks.find((candidate) => candidate.sizeBytes === undefined && candidate.witness.includes(this.witnessFilter));
        if (!block)
            return;
        const client = this.options.transactionStatusClient;
        if (!client?.getBlockSize) {
            this.sizeError = "Block-size API unavailable";
            return;
        }
        const abort = this.sizeAbort = new AbortController();
        void client.getBlockSize(block.number, abort.signal).then((size) => {
            if (abort.signal.aborted)
                return;
            if (size === undefined || !Number.isFinite(size) || size < 0)
                throw new Error(`Size unavailable for block ${block.number}`);
            block.sizeBytes = size;
            this.sizeError = "";
            this.sizeRetryAt = Date.now() + 1000; // Keep backfilling history below one measurement per second.
        }).catch((error) => {
            if (abort.signal.aborted)
                return;
            this.sizeError = error instanceof Error ? error.message : String(error);
            this.sizeRetryAt = Date.now() + 30_000;
            this.addEvent(`Block-size RPC: ${this.sizeError}`);
        }).finally(() => { this.sizeAbort = undefined; this.draw(); });
    }
    updateDisplayedRoundSchedule(event, blocks) {
        this.scheduleTracker.update(dynamicGlobalProperties(event), witnessSchedule(event), blocks, event.missedBlocks);
    }
    recordObservedRoundRow(event, blocks) {
        if (event.type !== "block")
            return;
        const schedule = this.displayedRoundSchedule ?? event.witnessSchedule;
        if (!schedule?.current_shuffled_witnesses?.length)
            return;
        const rows = scheduledRoundRows(event.block.number, schedule, blocks, event.missedBlocks, roundRowsOptions(dynamicGlobalProperties(event), blocks, this.displayedRoundScheduleMinBlock));
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
        const activeRows = scheduledRoundRows(displayHeadBlock, schedule, blocks, event.missedBlocks, roundRowsOptions(dynamicGlobalProperties(event), blocks, this.displayedRoundScheduleMinBlock));
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
    if (view === "txstatus")
        return "sizes";
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
    abort = new AbortController();
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
        this.abort.abort();
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
            if (this.warning?.startsWith("transaction status retryable error:"))
                this.warning = undefined;
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
                for (const item of batch) {
                    this.checking.delete(item.id);
                    if (!this.queued.has(item.id)) {
                        this.queue.push(item);
                        this.queued.add(item.id);
                    }
                }
                this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 1000);
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
                return await this.client.findTransactions(batch, this.abort.signal);
            }
            catch (error) {
                if (isTransactionStatusApiUnavailable(error, error instanceof Error ? error.message : String(error)))
                    throw error;
                this.batchUnavailable = true;
                this.warning = "transaction status batch unsupported; using single requests";
            }
        }
        return Promise.all(batch.map((item) => this.client.findTransaction(item.id, item.expiration, this.abort.signal)));
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
    return /unknown api|method not found|could not find api|does not exist|no method with name/i.test(message);
}
export function blockSizeChartLines(blocks, windowSeconds, rows, width, ascii = false, witnessFilter = "", noColor = false) {
    const filtered = blocks.filter((block) => block.witness.includes(witnessFilter));
    const measured = filtered.filter((block) => Number.isFinite(block.sizeBytes) && block.sizeBytes >= 0);
    const lines = ["BLOCK SIZE (bytes)"];
    if (!measured.length)
        return [...lines, "Waiting for block-size measurements..."].slice(0, rows);
    const values = measured.map((block) => block.sizeBytes);
    const peak = Math.max(...values);
    const latest = measured.reduce((a, b) => a.number > b.number ? a : b);
    lines.push(`Latest ${formatBytes(latest.sizeBytes)} | Mean ${formatBytes(values.reduce((a, b) => a + b, 0) / values.length)}`, `Min ${formatBytes(Math.min(...values))} | Peak ${formatBytes(peak)} | ${measured.length}/${filtered.length} blocks`);
    if (rows < 6)
        return lines.slice(0, rows);
    const height = rows - 5;
    const columns = Math.max(1, width - 10);
    const end = Math.max(...blocks.map((block) => block.timestamp.getTime()));
    const duration = Math.max(1, windowSeconds) * 1000;
    const start = end - duration;
    const scale = Math.max(1024, Math.ceil(peak / 1024) * 1024);
    const buckets = Array(columns).fill(undefined);
    const owners = Array(columns).fill(undefined);
    // A block covers the three-second slot ending at its timestamp. Empty slots stay blank.
    // When several blocks share a column, keep the peak rather than hide a size spike.
    for (const block of measured) {
        const time = block.timestamp.getTime();
        if (time <= start || time > end)
            continue;
        const left = Math.max(0, Math.min(columns - 1, Math.floor((time - 3000 - start) / duration * columns)));
        const right = Math.max(left + 1, Math.min(columns, Math.ceil((time - start) / duration * columns)));
        for (let column = left; column < right; column++) {
            if (block.sizeBytes > (buckets[column] ?? -1) || (block.sizeBytes === buckets[column] && block.number > owners[column])) {
                buckets[column] = block.sizeBytes;
                owners[column] = block.number;
            }
        }
    }
    for (let row = 0; row < height; row++) {
        const label = row === 0 || row === Math.floor(height / 2) ? formatBytes(scale * (height - row) / height) : "";
        let previousShade;
        const cells = buckets.map((size, column) => {
            const parts = size === undefined ? 0 : Math.ceil(size / scale * height * 8);
            const fill = Math.max(0, Math.min(8, parts - (height - row - 1) * 8));
            const glyph = ascii ? (fill ? "#" : " ") : " ▁▂▃▄▅▆▇█"[fill];
            if (!fill || noColor)
                return glyph;
            // Shade the right edge of each block, even when adjacent blocks have equal sizes.
            // A one-column bar keeps its light face so compressed history remains readable.
            const shadow = column > 0 && owners[column - 1] === owners[column] && owners[column + 1] !== owners[column];
            const shade = shadow ? 244 : 252;
            const style = shade === previousShade ? "" : `\x1b[38;5;${shade}m`;
            previousShade = shade;
            return style + glyph;
        }).join("");
        lines.push(`${label.padStart(8)} |${cells}${previousShade === undefined ? "" : "\x1b[39m"}`);
    }
    lines.push(`${"0 B".padStart(8)} +${"-".repeat(columns)}`);
    const firstTime = new Date(start).toISOString().slice(11, 19);
    const lastTime = new Date(end).toISOString().slice(11, 19);
    lines.push(`${"UTC".padStart(8)}  ${columns >= 17 ? firstTime + " ".repeat(columns - 16) + lastTime : lastTime.padStart(columns)}`);
    return lines;
}
function formatBytes(bytes) {
    return bytes < 1024 ? `${Math.round(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}
function helpLines() {
    return [
        "HELP / LEGENDS (Esc returns; arrows scroll)", "",
        "v        Cycle blocks, round, transaction status, sizes",
        "Up/Down  Select a row (j/k also work)",
        "PgUp/Dn  Move one page; Home/g returns to live rows",
        "Enter    Inspect a produced block; Esc closes details",
        "/        Filter by witness; Enter applies; Esc clears",
        "e        Event history: misses, node changes, RPC issues",
        "p        Pause/resume following; r resets to head",
        "q/Ctrl-C Quit; ? toggles this help", "",
        "Round: > current round, * selected row",
        "Round status: +/check = produced as scheduled; x = missed",
        "? = unverified; - = predicted; spinner = next block",
        "Witness color: green feed <=6h, yellow <24h, red >=24h",
        "Inverted witness: running the majority version", "",
        "Transaction colors: cyan checking, green irreversible,",
        "white reversible, yellow pending/unknown, red expired/old",
        "ASCII/NO_COLOR: * checking, I irreversible, R reversible,",
        ". pending, ? unknown, M mempool, E expired, T old, ! mismatch",
        "Stretched cells share one transaction's status.", "",
        "Sizes: time runs left to right; vertical scale adapts.",
        "Empty slots stay blank; combined columns show the peak.", "",
        "STALE: no fresh head/data for 15 seconds.",
        "RECONNECTING: the block RPC failed; retry is in progress.",
        "Cached rates describe the last received block window.",
        "Unavailable side panels retry every 30 seconds.",
    ];
}
function blockDetailLines(block, monitor) {
    if (!block)
        return ["Block unavailable (Esc returns)"];
    return [
        `BLOCK ${block.number} (Esc returns; arrows scroll)`,
        `Witness: ${block.witness} | UTC: ${block.timestamp.toISOString()}`,
        ...(block.sizeBytes === undefined ? [] : [`Serialized size: ${block.sizeBytes} bytes (${formatBytes(block.sizeBytes)})`]),
        `Transactions: ${block.transactionCount} | Operations: ${block.operationCount} | Virtual: ${block.virtualOperationCount}`,
        "", "OPERATIONS",
        ...[...block.operationTypes].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type}: ${count}`),
        "", "TRANSACTIONS",
        ...(block.transactions ?? []).flatMap((tx, index) => {
            const status = monitor?.statusFor(tx.id);
            return [`${index + 1}. ${tx.id}`,
                `   ${tx.primaryOperationType ?? "unknown"} | ${status?.status ?? status?.category ?? "unchecked"} | expires ${tx.expiration ?? "-"}`];
        }),
        ...(!block.transactions?.length ? [block.transactionCount ? "Transaction IDs unavailable from node." : "No transactions."] : []),
    ];
}
function wrapLine(line, width) {
    // Keep full transaction IDs and event messages available on narrow screens.
    const text = stripAnsi(line).replace(/[\x00-\x1f\x7f]/g, " ");
    return text.match(new RegExp(`.{1,${Math.max(1, width)}}`, "gu")) ?? [""];
}
function selectedTableStart(selection, scroll, rowCount) {
    if (!selection)
        return scroll;
    const selectedIndex = selection.blockNumbers.indexOf(selection.selectedBlock ?? -1);
    let start = Math.max(0, Math.min(scroll, selection.blockNumbers.length - rowCount));
    if (selectedIndex >= 0 && selectedIndex < start)
        start = selectedIndex;
    if (selectedIndex >= start + rowCount)
        start = selectedIndex - rowCount + 1;
    selection.scroll = start;
    return start;
}
function blockTableLines(event, blocks, scroll, rowCount, width, selection, compact = false) {
    const lines = [fit(compact ? "  BLOCK       WITNESS              TX/OPS/VOPS" : "  BLOCK       (RANK) WITNESS           TX     OPS    VOPS", width)];
    const feedAgeReference = chainTime(event);
    blocks = blocks.filter((block) => block.witness.includes(selection?.witnessFilter ?? ""));
    if (selection)
        selection.blockNumbers = blocks.map((block) => block.number);
    const start = selectedTableStart(selection, scroll, rowCount);
    for (const block of blocks.slice(start, start + rowCount)) {
        const witnessWidth = compact ? Math.max(8, Math.min(22, width - 32)) : 22;
        const counts = compact ? `${block.transactionCount}/${block.operationCount}/${block.virtualOperationCount}`
            : `${String(block.transactionCount).padStart(5)} ${String(block.operationCount).padStart(7)} ${String(block.virtualOperationCount).padStart(7)}`;
        lines.push(fit(` ${selection?.selectedBlock === block.number ? "*" : " "}${String(block.number).padEnd(11)} ${fit(formatRankedWitnessCell(block.witness, event.witnessRanks, event.witnessFeedUpdates, feedAgeReference, event.witnessVersions, event.majorityWitnessVersion, witnessWidth), witnessWidth)} ${counts}`, width));
    }
    if (!blocks.length)
        lines.push("No matching blocks yet.");
    return lines;
}
function txStatusTableLines(monitor, scroll, rowCount, width, selection, ascii = false) {
    const lines = [fit("  BLOCK       TX   STATUS MAP", width)];
    if (!monitor) {
        lines.push(fit("transaction status monitor unavailable", width));
        return lines;
    }
    const blocks = monitor.displayBlocks().filter((block) => block.witness.includes(selection?.witnessFilter ?? ""));
    if (selection)
        selection.blockNumbers = blocks.map((block) => block.number);
    const start = selectedTableStart(selection, scroll, rowCount);
    for (const block of blocks.slice(start, start + rowCount)) {
        const prefix = ` ${selection?.selectedBlock === block.number ? "*" : " "}${String(block.number).padEnd(11)} ${String(block.transactionCount).padStart(3)}  `;
        const mapWidth = Math.max(0, width - stripAnsi(prefix).length);
        lines.push(fit(prefix + formatTransactionStatusMap(block, monitor, mapWidth, ascii), width));
    }
    const diagnostic = monitor.diagnostic();
    if (diagnostic)
        lines.push(fit(ansiStyle(diagnostic, "orange", false), width));
    lines.push(fit(monitor.budgetLine(), width));
    lines.push(fit(ascii ? "* checking I irreversible R reversible . pending ? unknown" : `${ansiStyle("█", "cyan", false)} checking  ${ansiStyle("█", "green", false)} irreversible  ${ansiStyle("█", "white", false)} reversible  ${ansiStyle("█", "orange", false)} pending/unknown  ${ansiStyle("█", "red", false)} expired/old`, width));
    if (ascii)
        lines.push(fit("M mempool E expired T old ! mismatch (? help)", width));
    return lines;
}
export function formatTransactionStatusMap(block, monitor, width, ascii = false) {
    if (width <= 0)
        return "";
    if (block.transactions.length === 0)
        return "-";
    if (block.transactions.length > width) {
        return Array.from({ length: width }, (_, index) => {
            const start = Math.floor((index * block.transactions.length) / width);
            const end = Math.max(start + 1, Math.floor(((index + 1) * block.transactions.length) / width));
            return formatTransactionStatusCell(mergeTransactionStatusEntries(block.transactions.slice(start, end).map((transaction) => monitor.statusFor(transaction.id))), 1, ascii);
        }).join("");
    }
    const cellWidths = justifiedCellWidths(block.transactions.length, width);
    return block.transactions.map((transaction, index) => formatTransactionStatusCell(monitor.statusFor(transaction.id), cellWidths[index] ?? 1, ascii)).join("");
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
export function formatTransactionStatusCell(entry, width = 1, ascii = false) {
    const cell = (ascii ? entry.glyph : "█").repeat(width);
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
function roundTableLines(event, blocks, displayedSchedule, displayedScheduleMinBlock, observedRoundRows, revealedFutureRows, retractingPredictedRows, spinnerFrame, scroll, rowCount, width, selection, compact = false) {
    const lines = [fit(compact ? "  BLOCK       SCHEDULED WITNESS        STATUS" : "  BLOCK       SCHEDULED WITNESS        STATUS   VERSION   FEED", width)];
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
        lines.unshift(fit(compact ? `Round ${displayHeadBlock - roundStart + 1}/${witnessCount}: ${roundStart}-${roundEnd} | > current`
            : `Current round ${roundStart}-${roundEnd} (${displayHeadBlock - roundStart + 1}/${witnessCount}) | > current`, width));
    }
    const activeRoundRows = stabilizeObservedRoundRows(scheduledRoundRows(displayHeadBlock, schedule, blocks, event.missedBlocks, roundRowsOptions(dynamicGlobalProperties(event), blocks, displayedScheduleMinBlock)), observedRoundRows);
    const roundRows = scrollingRoundRows(activeRoundRows, observedRoundRows, displayHeadBlock);
    const visibleRoundRows = mergeRetractingPredictions(revealPredictedRows(roundRows, displayHeadBlock, revealedFutureRows), retractingPredictedRows, displayHeadBlock).filter((row) => row.scheduledWitness.includes(selection?.witnessFilter ?? "") || Boolean(row.producedWitness?.includes(selection?.witnessFilter ?? "")));
    if (selection)
        selection.blockNumbers = visibleRoundRows.map((row) => row.blockNumber);
    const headIndex = visibleRoundRows.findIndex((row) => row.blockNumber <= displayHeadBlock);
    const liveStart = selection?.selectedBlock === undefined && headIndex >= 0 ? Math.max(0, headIndex - Math.floor(rowCount / 2)) : scroll;
    const rowStart = selectedTableStart(selection, clampedScrollStart(visibleRoundRows, liveStart, rowCount), rowCount);
    for (const row of visibleRoundRows.slice(rowStart, rowStart + rowCount)) {
        const roundMarker = roundStart !== undefined && roundEnd !== undefined && row.blockNumber >= roundStart && row.blockNumber <= roundEnd
            ? ansiStyle(">", "cyan", false) : " ";
        const selectionMarker = selection?.selectedBlock === row.blockNumber ? "*" : " ";
        const witnessWidth = compact ? Math.max(8, Math.min(22, width - 24)) : 22;
        const scheduled = row.settling
            ? "settling".padEnd(22)
            : formatRankedWitnessCell(row.scheduledWitness, event.witnessRanks, event.witnessFeedUpdates, chainTime(event), event.witnessVersions, event.majorityWitnessVersion, witnessWidth);
        const producedStatus = formatRoundProducedStatus(row, displayHeadBlock, spinnerFrame, event.missedBlocks);
        const producedStatusCell = formatProducedStatusCell(producedStatus, 8);
        lines.push(fit(`${roundMarker}${selectionMarker}${String(row.blockNumber).padEnd(11)} ${fit(scheduled, witnessWidth)} ${producedStatusCell}${compact ? "" : ` ${formatVersion(row.settling ? undefined : event.witnessVersions[row.scheduledWitness]).padEnd(9)} ${formatFeedAge(row.settling ? undefined : event.witnessFeedUpdates[row.scheduledWitness], chainTime(event)).padStart(6)}`}`, width));
    }
    const warning = roundScheduleWarning(activeRoundRows, [], event.missedBlocks);
    if (event.panelErrors?.schedule)
        lines.push(fit(`schedule unavailable/stale: ${event.panelErrors.schedule.message}`, width));
    if (warning)
        lines.push(fit(ansiStyle(warning, "orange", false), width));
    if (event.scheduleDiagnostics?.message) {
        lines.push(fit(ansiStyle(event.scheduleDiagnostics.message, "orange", false), width));
    }
    return lines;
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
function trimObservedRows(rows, maxSize) {
    while (rows.size > maxSize) {
        const oldest = rows.keys().next().value;
        if (oldest === undefined)
            return;
        rows.delete(oldest);
    }
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
    lines.push(...rcPanel(event.rcInfo, event.panelErrors?.rc?.message));
    lines.push("");
    lines.push(...hardforkPanel(event.hardforkInfo, event.panelErrors?.hardfork?.message));
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
function rcPanel(info, error) {
    const lines = [color(" rc ", "white", "red") + " resource credits"];
    if (error)
        lines.push(`${info ? "stale" : "unavailable"}: ${error}`);
    if (!info) {
        if (!error)
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
function hardforkPanel(info, error) {
    const lines = [color(" hardfork ", "white", "red") + " latest / next"];
    if (error)
        lines.push(`${info ? "stale" : "unavailable"}: ${error}`);
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
