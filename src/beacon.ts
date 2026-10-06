import http from "node:http";
import https from "node:https";

export const BEACON_NODES_URL = "https://beacon.peakd.com/api/nodes";
export const PREFERRED_NODE_NAME = "api.hive.blog";
export const PREFERRED_NODE_SCORE_THRESHOLD = 90;

interface BeaconResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type BeaconFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<BeaconResponse>;

export interface BeaconNode {
  name?: string;
  endpoint?: string;
  score?: number;
  lastBlock?: number | null;
  success?: number;
  fail?: number;
  features?: string[];
}

export interface NodeSelection {
  endpoint: string;
  source: "beacon" | "fallback";
  node?: BeaconNode;
  endpoints: string[];
  nodes: BeaconNode[];
}

export async function selectHiveNode(options: {
  fallbackEndpoint: string;
  beaconUrl?: string;
  fetchImpl?: BeaconFetch;
  signal?: AbortSignal;
}): Promise<NodeSelection> {
  try {
    const nodes = await fetchBeaconNodes(options.beaconUrl ?? BEACON_NODES_URL, options.fetchImpl ?? defaultFetch, options.signal);
    const selected = chooseBeaconNode(nodes, options.fallbackEndpoint);
    const endpoints = orderedBeaconEndpoints(nodes, options.fallbackEndpoint);
    if (selected?.endpoint) return { endpoint: selected.endpoint, source: "beacon", node: selected, endpoints, nodes };
  } catch {
    return fallbackSelection(options.fallbackEndpoint);
  }

  return fallbackSelection(options.fallbackEndpoint);
}

export function chooseBeaconNode(nodes: BeaconNode[], preferredEndpoint: string): BeaconNode | undefined {
  const candidates = nodes.filter(isUsableNode).sort(compareBeaconNodes);
  const preferred = candidates.find((node) => node.name === PREFERRED_NODE_NAME || node.endpoint === preferredEndpoint);
  if (preferred && scoreOf(preferred) >= PREFERRED_NODE_SCORE_THRESHOLD) return preferred;
  return candidates[0];
}

export function orderedBeaconEndpoints(nodes: BeaconNode[], preferredEndpoint: string): string[] {
  const selected = chooseBeaconNode(nodes, preferredEndpoint);
  const candidates = nodes.filter(isUsableNode).sort(compareBeaconNodes);
  const endpoints = [selected, ...candidates]
    .map((node) => node?.endpoint)
    .filter((endpoint): endpoint is string => typeof endpoint === "string" && endpoint.length > 0);
  return uniqueEndpoints(endpoints);
}

async function fetchBeaconNodes(url: string, fetchImpl: BeaconFetch, signal?: AbortSignal): Promise<BeaconNode[]> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`Beacon request failed with HTTP ${response.status}`);

  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("Beacon returned an unexpected payload");
  return payload as BeaconNode[];
}

function isUsableNode(node: BeaconNode): boolean {
  return typeof node.endpoint === "string" && node.endpoint.length > 0 && scoreOf(node) > 0 && (node.features ?? []).includes("get_rc_stats");
}

function compareBeaconNodes(a: BeaconNode, b: BeaconNode): number {
  return scoreOf(b) - scoreOf(a) || successOf(b) - successOf(a) || lastBlockOf(b) - lastBlockOf(a) || String(a.name).localeCompare(String(b.name));
}

function scoreOf(node: BeaconNode): number {
  return typeof node.score === "number" && Number.isFinite(node.score) ? node.score : 0;
}

function successOf(node: BeaconNode): number {
  return typeof node.success === "number" && Number.isFinite(node.success) ? node.success : 0;
}

function lastBlockOf(node: BeaconNode): number {
  return typeof node.lastBlock === "number" && Number.isFinite(node.lastBlock) ? node.lastBlock : 0;
}

function uniqueEndpoints(endpoints: string[]): string[] {
  return Array.from(new Set(endpoints));
}

function fallbackSelection(endpoint: string): NodeSelection {
  return { endpoint, source: "fallback", endpoints: [endpoint], nodes: [] };
}

function defaultFetch(url: string, init?: { signal?: AbortSignal }): Promise<BeaconResponse> {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, init) as Promise<BeaconResponse>;
  }

  return nodeFetch(url, init);
}

function nodeFetch(url: string, init?: { signal?: AbortSignal }): Promise<BeaconResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const transport = endpoint.protocol === "http:" ? http : https;
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      if (abortHandler) init?.signal?.removeEventListener("abort", abortHandler);
    };
    const request = transport.request(endpoint, { method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        cleanup();
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
          status: response.statusCode ?? 0,
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
    if (init?.signal) {
      abortHandler = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        request.destroy(error);
      };
      init.signal.addEventListener("abort", abortHandler, { once: true });
    }
    request.end();
  });
}
