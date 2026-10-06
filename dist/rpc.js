export class HiveRpcError extends Error {
    method;
    cause;
    constructor(message, method, cause) {
        super(message);
        this.method = method;
        this.cause = cause;
        this.name = "HiveRpcError";
    }
}
export class HiveRpcClient {
    endpoint;
    fetchImpl;
    timeoutMs;
    id = 0;
    health = {};
    constructor(endpoint, fetchImpl = defaultFetch, timeoutMs = 10_000) {
        this.endpoint = endpoint;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    async getDynamicGlobalProperties(signal) {
        return this.call("condenser_api.get_dynamic_global_properties", [], signal);
    }
    async getBlock(blockNumber, signal) {
        return this.call("condenser_api.get_block", [blockNumber], signal);
    }
    async getBlockSize(blockNumber, signal) {
        const block = await this.getBlock(blockNumber, signal);
        if (!block)
            return undefined;
        const headerBytes = signedBlockHeaderBytes(block);
        const transactions = block.transactions ?? [];
        let transactionBytes = 0;
        if (transactions.length) {
            const envelopes = transactions.reduce((total, transaction) => total + transactionEnvelopeBytes(transaction), 0);
            // Pack all operations once. Their encodings are independent of transaction boundaries.
            // This is a serialization query; the synthetic transaction is never broadcast.
            const combined = { ...transactions[0], operations: transactions.flatMap((transaction) => transaction.operations ?? []), extensions: [], signatures: [] };
            const hex = await this.call("condenser_api.get_transaction_hex", [combined], signal);
            if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex))
                throw new Error("Invalid serialized transaction hex");
            transactionBytes = hex.length / 2 - transactionEnvelopeBytes(combined) + envelopes;
            if (transactionBytes < envelopes)
                throw new Error("Incomplete serialized transaction hex");
        }
        return headerBytes + varUintBytes(transactions.length) + transactionBytes;
    }
    async getVirtualOperationsInBlock(blockNumber, signal) {
        return this.call("condenser_api.get_ops_in_block", [blockNumber, true], signal);
    }
    async getHardforkVersion(signal) {
        return this.call("condenser_api.get_hardfork_version", [], signal);
    }
    async getNextScheduledHardfork(signal) {
        return this.call("condenser_api.get_next_scheduled_hardfork", [], signal);
    }
    async getWitnessSchedule(signal, includeFuture = false) {
        const response = await this.callResponse("condenser_api.get_witness_schedule", includeFuture ? [true] : [], signal);
        return annotateWitnessSchedule(response.result, this.endpoint, response.headers);
    }
    async getWitnessesByVote(start = "", limit = 250, signal) {
        return this.call("condenser_api.get_witnesses_by_vote", [start, limit], signal);
    }
    async getRcStats(signal) {
        return this.call("rc_api.get_rc_stats", {}, signal);
    }
    async findTransaction(transactionId, expiration, signal) {
        return this.call("transaction_status_api.find_transaction", expiration ? { transaction_id: transactionId, expiration } : { transaction_id: transactionId }, signal);
    }
    async findTransactions(transactions, signal) {
        if (transactions.length === 0)
            return [];
        return this.callBatch(transactions.map((transaction) => ({
            method: "transaction_status_api.find_transaction",
            params: transaction.expiration ? { transaction_id: transaction.id, expiration: transaction.expiration } : { transaction_id: transaction.id },
        })), signal);
    }
    async withStableEndpoint(read, _signal) {
        return read(this);
    }
    async call(method, params, signal) {
        return (await this.callResponse(method, params, signal)).result;
    }
    async callResponse(method, params, signal) {
        const request = {
            jsonrpc: "2.0",
            method,
            params,
            id: ++this.id,
        };
        const { response, payload: body } = await this.request(request, method, signal);
        const payload = body;
        if (payload.error) {
            throw new HiveRpcError(payload.error.message ?? `RPC error for ${method}`, method, payload.error);
        }
        return { result: payload.result, headers: responseHeaders(response) };
    }
    async callBatch(calls, signal) {
        const requests = calls.map((call) => ({
            jsonrpc: "2.0",
            method: call.method,
            params: call.params,
            id: ++this.id,
        }));
        const method = calls[0]?.method ?? "unknown";
        const { payload: body } = await this.request(requests, method, signal);
        const payload = body;
        if (!Array.isArray(payload)) {
            throw new HiveRpcError(`RPC batch response was not an array for ${method}`, method, payload);
        }
        const responses = new Map(payload.map((item) => [item.id, item]));
        return requests.map((request) => {
            const item = responses.get(request.id);
            if (!item)
                throw new HiveRpcError(`RPC batch response missing id ${request.id} for ${method}`, method);
            if (item.error)
                throw new HiveRpcError(item.error.message ?? `RPC batch error for ${method}`, method, item.error);
            return item.result;
        });
    }
    async request(body, method, signal) {
        signal?.throwIfAborted();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await this.fetchImpl(this.endpoint, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
            });
            if (!response.ok)
                throw new HiveRpcError(`RPC request failed with HTTP ${response.status} for ${method}`, method);
            // Keep the deadline active while receiving and decoding the response body.
            const payload = await response.json();
            this.health.lastResponseAt = Date.now();
            this.health.latencyMs = this.health.lastResponseAt - startedAt;
            return { response, payload };
        }
        catch (error) {
            if (signal?.aborted)
                throw signal.reason;
            if (deadline.signal.aborted)
                throw new HiveRpcError(`RPC timeout after ${this.timeoutMs}ms for ${method}`, method, error);
            if (error instanceof HiveRpcError)
                throw error;
            throw new HiveRpcError(`RPC request failed for ${method}: ${error instanceof Error ? error.message : String(error)}`, method, error);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
export class FailoverHiveRpcClient {
    currentIndex = 0;
    clients;
    get health() { return this.clients[this.currentIndex].health; }
    constructor(endpoints, clientFactory = (endpoint) => new HiveRpcClient(endpoint)) {
        const uniqueEndpoints = Array.from(new Set(endpoints.filter((endpoint) => endpoint.length > 0)));
        if (uniqueEndpoints.length === 0)
            throw new Error("FailoverHiveRpcClient requires at least one endpoint");
        this.clients = uniqueEndpoints.map(clientFactory);
    }
    get endpoint() {
        return this.current.endpoint;
    }
    async getDynamicGlobalProperties(signal) {
        return this.withStableEndpoint((client) => client.getDynamicGlobalProperties(signal), signal);
    }
    async getBlock(blockNumber, signal) {
        return this.withStableEndpoint((client) => client.getBlock(blockNumber, signal), signal);
    }
    async getBlockSize(blockNumber, signal) {
        if (!this.current.getBlockSize)
            throw new Error("Block-size measurements are unavailable on this node");
        return this.current.getBlockSize(blockNumber, signal);
    }
    async getVirtualOperationsInBlock(blockNumber, signal) {
        return this.withStableEndpoint((client) => client.getVirtualOperationsInBlock(blockNumber, signal), signal);
    }
    async getHardforkVersion(signal) {
        return this.withStableEndpoint((client) => client.getHardforkVersion(signal), signal);
    }
    async getNextScheduledHardfork(signal) {
        return this.withStableEndpoint((client) => client.getNextScheduledHardfork(signal), signal);
    }
    async getWitnessSchedule(signal, includeFuture = false) {
        return this.withStableEndpoint((client) => client.getWitnessSchedule(signal, includeFuture), signal);
    }
    async getWitnessesByVote(start = "", limit = 250, signal) {
        return this.withStableEndpoint((client) => client.getWitnessesByVote(start, limit, signal), signal);
    }
    async getRcStats(signal) {
        return this.withStableEndpoint((client) => client.getRcStats(signal), signal);
    }
    async findTransaction(transactionId, expiration, signal) {
        return this.withStableEndpoint((client) => client.findTransaction(transactionId, expiration, signal), signal);
    }
    async findTransactions(transactions, signal) {
        return this.withStableEndpoint((client) => {
            if (client.findTransactions)
                return client.findTransactions(transactions, signal);
            return Promise.all(transactions.map((transaction) => client.findTransaction(transaction.id, transaction.expiration, signal)));
        }, signal);
    }
    get current() {
        return this.clients[this.currentIndex];
    }
    async withStableEndpoint(read, signal) {
        let lastError;
        const startIndex = this.currentIndex;
        for (let attempt = 0; attempt < this.clients.length; attempt += 1) {
            if (signal?.aborted)
                throw abortError();
            const index = (startIndex + attempt) % this.clients.length;
            const client = this.clients[index];
            try {
                const result = await read(client);
                this.currentIndex = index;
                return result;
            }
            catch (error) {
                if (signal?.aborted || isAbortError(error))
                    throw error;
                lastError = error;
                if (attempt < this.clients.length - 1)
                    this.currentIndex = (index + 1) % this.clients.length;
            }
        }
        throw lastError;
    }
}
export function withStableEndpoint(client, read, signal) {
    const stableClient = client;
    return stableClient.withStableEndpoint ? stableClient.withStableEndpoint(read, signal) : read(client);
}
function defaultFetch(url, init) {
    return globalThis.fetch(url, init);
}
function signedBlockHeaderBytes(block) {
    if (!/^[0-9a-f]{40}$/i.test(block.previous ?? "") || !/^[0-9a-f]{40}$/i.test(block.transaction_merkle_root ?? "")
        || !/^[0-9a-f]{130}$/i.test(block.witness_signature ?? ""))
        throw new Error("Incomplete signed block header");
    const witnessBytes = Buffer.byteLength(block.witness, "utf8");
    const extensions = block.extensions ?? [];
    let extensionBytes = varUintBytes(extensions.length);
    for (const extension of extensions) {
        // Hive's header variants are void, version (uint32), and hardfork vote (version + timestamp).
        if (!Array.isArray(extension) || ![0, 1, 2].includes(extension[0]))
            throw new Error("Unsupported block header extension");
        extensionBytes += 1 + [0, 4, 8][extension[0]];
    }
    // Previous ID, timestamp, witness string, merkle root, extensions, compact signature.
    return 20 + 4 + varUintBytes(witnessBytes) + witnessBytes + 20 + extensionBytes + 65;
}
function varUintBytes(value) {
    let bytes = 1;
    while (value >= 128) {
        value = Math.floor(value / 128);
        bytes++;
    }
    return bytes;
}
function transactionEnvelopeBytes(transaction) {
    const signatures = transaction.signatures ?? [];
    if (signatures.some((signature) => !/^[0-9a-f]{130}$/i.test(signature)))
        throw new Error("Invalid transaction signature");
    const extensions = transaction.extensions ?? [];
    if (extensions.some((extension) => !Array.isArray(extension) || extension[0] !== 0))
        throw new Error("Unsupported transaction extension");
    // ref_block_num (uint16), ref_block_prefix + expiration (uint32), vectors, signatures.
    return 10 + varUintBytes(transaction.operations?.length ?? 0) + varUintBytes(extensions.length) + extensions.length
        + varUintBytes(signatures.length) + 65 * signatures.length;
}
function responseHeaders(response) {
    const headers = response.headers;
    const output = {};
    if (!headers)
        return output;
    if ("forEach" in headers && typeof headers.forEach === "function") {
        headers.forEach((value, key) => {
            output[key.toLowerCase()] = value;
        });
        return output;
    }
    for (const [key, value] of Object.entries(headers))
        output[key.toLowerCase()] = value;
    return output;
}
function annotateWitnessSchedule(schedule, endpoint, headers) {
    schedule.rpcEndpoint = endpoint;
    schedule.rpcRequestId = headers["x-request-id"];
    schedule.rpcParamHash = headers["x-jussi-param-hash"];
    schedule.rpcFetchedAt = new Date().toISOString();
    return schedule;
}
function abortError() {
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
