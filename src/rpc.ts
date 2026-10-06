import http from "node:http";
import https from "node:https";
import type {
  AppliedOperation,
  DynamicGlobalProperties,
  HiveBlock,
  NextScheduledHardfork,
  RcStatsResponse,
  TransactionRef,
  TransactionStatusResponse,
  WitnessByVote,
  WitnessSchedule,
} from "./types.js";

interface RpcRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

interface RpcResponse {
  ok: boolean;
  status: number;
  headers?: RpcHeaders;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init: RpcRequestInit) => Promise<RpcResponse>;
type RpcHeaders = Record<string, string | undefined>;

export interface HiveRpcReadable {
  readonly endpoint: string;
  getDynamicGlobalProperties(signal?: AbortSignal): Promise<DynamicGlobalProperties>;
  getBlock(blockNumber: number, signal?: AbortSignal): Promise<HiveBlock | null>;
  getVirtualOperationsInBlock(blockNumber: number, signal?: AbortSignal): Promise<AppliedOperation[]>;
  getHardforkVersion(signal?: AbortSignal): Promise<string>;
  getNextScheduledHardfork(signal?: AbortSignal): Promise<NextScheduledHardfork>;
  getWitnessSchedule(signal?: AbortSignal, includeFuture?: boolean): Promise<WitnessSchedule>;
  getWitnessesByVote(start?: string, limit?: number, signal?: AbortSignal): Promise<WitnessByVote[]>;
  getRcStats(signal?: AbortSignal): Promise<RcStatsResponse>;
  findTransaction(transactionId: string, expiration?: string, signal?: AbortSignal): Promise<TransactionStatusResponse>;
  findTransactions?(transactions: TransactionRef[], signal?: AbortSignal): Promise<TransactionStatusResponse[]>;
}

export interface StableEndpointHiveRpcReadable extends HiveRpcReadable {
  withStableEndpoint<T>(read: (client: HiveRpcReadable) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class HiveRpcError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HiveRpcError";
  }
}

export class HiveRpcClient implements HiveRpcReadable {
  private id = 0;

  constructor(public readonly endpoint: string, private readonly fetchImpl: FetchLike = defaultFetch) {}

  async getDynamicGlobalProperties(signal?: AbortSignal): Promise<DynamicGlobalProperties> {
    return this.call<DynamicGlobalProperties>("condenser_api.get_dynamic_global_properties", [], signal);
  }

  async getBlock(blockNumber: number, signal?: AbortSignal): Promise<HiveBlock | null> {
    return this.call<HiveBlock | null>("condenser_api.get_block", [blockNumber], signal);
  }

  async getVirtualOperationsInBlock(blockNumber: number, signal?: AbortSignal): Promise<AppliedOperation[]> {
    return this.call<AppliedOperation[]>("condenser_api.get_ops_in_block", [blockNumber, true], signal);
  }

  async getHardforkVersion(signal?: AbortSignal): Promise<string> {
    return this.call<string>("condenser_api.get_hardfork_version", [], signal);
  }

  async getNextScheduledHardfork(signal?: AbortSignal): Promise<NextScheduledHardfork> {
    return this.call<NextScheduledHardfork>("condenser_api.get_next_scheduled_hardfork", [], signal);
  }

  async getWitnessSchedule(signal?: AbortSignal, includeFuture = false): Promise<WitnessSchedule> {
    const response = await this.callResponse<WitnessSchedule>("condenser_api.get_witness_schedule", includeFuture ? [true] : [], signal);
    return annotateWitnessSchedule(response.result, this.endpoint, response.headers);
  }

  async getWitnessesByVote(start = "", limit = 250, signal?: AbortSignal): Promise<WitnessByVote[]> {
    return this.call<WitnessByVote[]>("condenser_api.get_witnesses_by_vote", [start, limit], signal);
  }

  async getRcStats(signal?: AbortSignal): Promise<RcStatsResponse> {
    return this.call<RcStatsResponse>("rc_api.get_rc_stats", {}, signal);
  }

  async findTransaction(transactionId: string, expiration?: string, signal?: AbortSignal): Promise<TransactionStatusResponse> {
    return this.call<TransactionStatusResponse>(
      "transaction_status_api.find_transaction",
      expiration ? { transaction_id: transactionId, expiration } : { transaction_id: transactionId },
      signal,
    );
  }

  async findTransactions(transactions: TransactionRef[], signal?: AbortSignal): Promise<TransactionStatusResponse[]> {
    if (transactions.length === 0) return [];
    return this.callBatch<TransactionStatusResponse>(
      transactions.map((transaction) => ({
        method: "transaction_status_api.find_transaction",
        params: transaction.expiration ? { transaction_id: transaction.id, expiration: transaction.expiration } : { transaction_id: transaction.id },
      })),
      signal,
    );
  }

  async withStableEndpoint<T>(read: (client: HiveRpcReadable) => Promise<T>, _signal?: AbortSignal): Promise<T> {
    return read(this);
  }

  private async call<T>(method: string, params: unknown[] | Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return (await this.callResponse<T>(method, params, signal)).result;
  }

  private async callResponse<T>(method: string, params: unknown[] | Record<string, unknown>, signal?: AbortSignal): Promise<{ result: T; headers: RpcHeaders }> {
    const request = {
      jsonrpc: "2.0",
      method,
      params,
      id: ++this.id,
    };

    let response: RpcResponse;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new HiveRpcError(`RPC request failed for ${method}`, method, error);
    }

    if (!response.ok) {
      throw new HiveRpcError(`RPC request failed with HTTP ${response.status} for ${method}`, method);
    }

    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) {
      throw new HiveRpcError(payload.error.message ?? `RPC error for ${method}`, method, payload.error);
    }

    return { result: payload.result as T, headers: responseHeaders(response) };
  }

  private async callBatch<T>(calls: Array<{ method: string; params: unknown[] | Record<string, unknown> }>, signal?: AbortSignal): Promise<T[]> {
    const requests = calls.map((call) => ({
      jsonrpc: "2.0",
      method: call.method,
      params: call.params,
      id: ++this.id,
    }));

    let response: RpcResponse;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requests),
        signal,
      });
    } catch (error) {
      throw new HiveRpcError(`RPC batch request failed for ${calls[0]?.method ?? "unknown"}`, calls[0]?.method ?? "unknown", error);
    }

    const method = calls[0]?.method ?? "unknown";
    if (!response.ok) {
      throw new HiveRpcError(`RPC batch request failed with HTTP ${response.status} for ${method}`, method);
    }

    const payload = (await response.json()) as Array<{ id?: number; result?: T; error?: { message?: string } }> | { error?: { message?: string } };
    if (!Array.isArray(payload)) {
      throw new HiveRpcError(`RPC batch response was not an array for ${method}`, method, payload);
    }

    const responses = new Map(payload.map((item) => [item.id, item]));
    return requests.map((request) => {
      const item = responses.get(request.id);
      if (!item) throw new HiveRpcError(`RPC batch response missing id ${request.id} for ${method}`, method);
      if (item.error) throw new HiveRpcError(item.error.message ?? `RPC batch error for ${method}`, method, item.error);
      return item.result as T;
    });
  }
}

export class FailoverHiveRpcClient implements HiveRpcReadable {
  private currentIndex = 0;
  private readonly clients: HiveRpcReadable[];

  constructor(
    endpoints: string[],
    clientFactory: (endpoint: string) => HiveRpcReadable = (endpoint) => new HiveRpcClient(endpoint),
  ) {
    const uniqueEndpoints = Array.from(new Set(endpoints.filter((endpoint) => endpoint.length > 0)));
    if (uniqueEndpoints.length === 0) throw new Error("FailoverHiveRpcClient requires at least one endpoint");
    this.clients = uniqueEndpoints.map(clientFactory);
  }

  get endpoint(): string {
    return this.current.endpoint;
  }

  async getDynamicGlobalProperties(signal?: AbortSignal): Promise<DynamicGlobalProperties> {
    return this.withStableEndpoint((client) => client.getDynamicGlobalProperties(signal), signal);
  }

  async getBlock(blockNumber: number, signal?: AbortSignal): Promise<HiveBlock | null> {
    return this.withStableEndpoint((client) => client.getBlock(blockNumber, signal), signal);
  }

  async getVirtualOperationsInBlock(blockNumber: number, signal?: AbortSignal): Promise<AppliedOperation[]> {
    return this.withStableEndpoint((client) => client.getVirtualOperationsInBlock(blockNumber, signal), signal);
  }

  async getHardforkVersion(signal?: AbortSignal): Promise<string> {
    return this.withStableEndpoint((client) => client.getHardforkVersion(signal), signal);
  }

  async getNextScheduledHardfork(signal?: AbortSignal): Promise<NextScheduledHardfork> {
    return this.withStableEndpoint((client) => client.getNextScheduledHardfork(signal), signal);
  }

  async getWitnessSchedule(signal?: AbortSignal, includeFuture = false): Promise<WitnessSchedule> {
    return this.withStableEndpoint((client) => client.getWitnessSchedule(signal, includeFuture), signal);
  }

  async getWitnessesByVote(start = "", limit = 250, signal?: AbortSignal): Promise<WitnessByVote[]> {
    return this.withStableEndpoint((client) => client.getWitnessesByVote(start, limit, signal), signal);
  }

  async getRcStats(signal?: AbortSignal): Promise<RcStatsResponse> {
    return this.withStableEndpoint((client) => client.getRcStats(signal), signal);
  }

  async findTransaction(transactionId: string, expiration?: string, signal?: AbortSignal): Promise<TransactionStatusResponse> {
    return this.withStableEndpoint((client) => client.findTransaction(transactionId, expiration, signal), signal);
  }

  async findTransactions(transactions: TransactionRef[], signal?: AbortSignal): Promise<TransactionStatusResponse[]> {
    return this.withStableEndpoint((client) => {
      if (client.findTransactions) return client.findTransactions(transactions, signal);
      return Promise.all(transactions.map((transaction) => client.findTransaction(transaction.id, transaction.expiration, signal)));
    }, signal);
  }

  private get current(): HiveRpcReadable {
    return this.clients[this.currentIndex];
  }

  async withStableEndpoint<T>(read: (client: HiveRpcReadable) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    const startIndex = this.currentIndex;
    for (let attempt = 0; attempt < this.clients.length; attempt += 1) {
      if (signal?.aborted) throw abortError();
      const index = (startIndex + attempt) % this.clients.length;
      const client = this.clients[index];
      try {
        const result = await read(client);
        this.currentIndex = index;
        return result;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        lastError = error;
        if (attempt < this.clients.length - 1) this.currentIndex = (index + 1) % this.clients.length;
      }
    }

    throw lastError;
  }
}

export function withStableEndpoint<T>(client: HiveRpcReadable, read: (client: HiveRpcReadable) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const stableClient = client as Partial<StableEndpointHiveRpcReadable>;
  return stableClient.withStableEndpoint ? stableClient.withStableEndpoint(read, signal) : read(client);
}

function defaultFetch(url: string, init: RpcRequestInit): Promise<RpcResponse> {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, init) as unknown as Promise<RpcResponse>;
  }

  return nodeFetch(url, init);
}

function nodeFetch(url: string, init: RpcRequestInit): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const transport = endpoint.protocol === "http:" ? http : https;
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      if (abortHandler) init.signal?.removeEventListener("abort", abortHandler);
    };
    const request = transport.request(
      endpoint,
      {
        method: init.method,
        agent: endpoint.protocol === "http:" ? keepAliveHttpAgent : keepAliveHttpsAgent,
        headers: {
          ...init.headers,
          "content-length": Buffer.byteLength(init.body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
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
      },
    );

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

function responseHeaders(response: RpcResponse): RpcHeaders {
  const headers = response.headers as RpcHeaders | { forEach?: (callback: (value: string, key: string) => void) => void } | undefined;
  const output: RpcHeaders = {};
  if (!headers) return output;
  if ("forEach" in headers && typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      output[key.toLowerCase()] = value;
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers)) output[key.toLowerCase()] = value;
  return output;
}

function normalizeNodeHeaders(headers: http.IncomingHttpHeaders): RpcHeaders {
  const output: RpcHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}

function annotateWitnessSchedule(schedule: WitnessSchedule, endpoint: string, headers: RpcHeaders): WitnessSchedule {
  schedule.rpcEndpoint = endpoint;
  schedule.rpcRequestId = headers["x-request-id"];
  schedule.rpcParamHash = headers["x-jussi-param-hash"];
  schedule.rpcFetchedAt = new Date().toISOString();
  return schedule;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
