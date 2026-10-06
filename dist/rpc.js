import http from "node:http";
import https from "node:https";
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
    id = 0;
    constructor(endpoint, fetchImpl = defaultFetch) {
        this.endpoint = endpoint;
        this.fetchImpl = fetchImpl;
    }
    async getDynamicGlobalProperties(signal) {
        return this.call("condenser_api.get_dynamic_global_properties", [], signal);
    }
    async getBlock(blockNumber, signal) {
        return this.call("condenser_api.get_block", [blockNumber], signal);
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
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(request),
                signal,
            });
        }
        catch (error) {
            throw new HiveRpcError(`RPC request failed for ${method}`, method, error);
        }
        if (!response.ok) {
            throw new HiveRpcError(`RPC request failed with HTTP ${response.status} for ${method}`, method);
        }
        const payload = (await response.json());
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
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requests),
                signal,
            });
        }
        catch (error) {
            throw new HiveRpcError(`RPC batch request failed for ${calls[0]?.method ?? "unknown"}`, calls[0]?.method ?? "unknown", error);
        }
        const method = calls[0]?.method ?? "unknown";
        if (!response.ok) {
            throw new HiveRpcError(`RPC batch request failed with HTTP ${response.status} for ${method}`, method);
        }
        const payload = (await response.json());
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
}
export class FailoverHiveRpcClient {
    currentIndex = 0;
    clients;
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
    if (typeof globalThis.fetch === "function") {
        return globalThis.fetch(url, init);
    }
    return nodeFetch(url, init);
}
function nodeFetch(url, init) {
    return new Promise((resolve, reject) => {
        const endpoint = new URL(url);
        const transport = endpoint.protocol === "http:" ? http : https;
        let abortHandler;
        const cleanup = () => {
            if (abortHandler)
                init.signal?.removeEventListener("abort", abortHandler);
        };
        const request = transport.request(endpoint, {
            method: init.method,
            agent: endpoint.protocol === "http:" ? keepAliveHttpAgent : keepAliveHttpsAgent,
            headers: {
                ...init.headers,
                "content-length": Buffer.byteLength(init.body),
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                cleanup();
                const body = Buffer.concat(chunks).toString("utf8");
                resolve({
                    ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
                    status: response.statusCode ?? 0,
                    headers: normalizeNodeHeaders(response.headers),
                    async json() {
                        return JSON.parse(body);
                    },
                });
            });
        });
        request.on("error", (error) => {
            cleanup();
            reject(error);
        });
        if (init.signal) {
            abortHandler = () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                request.destroy(error);
            };
            init.signal.addEventListener("abort", abortHandler, { once: true });
        }
        request.end(init.body);
    });
}
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
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
function normalizeNodeHeaders(headers) {
    const output = {};
    for (const [key, value] of Object.entries(headers)) {
        output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
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
