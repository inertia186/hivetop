import assert from "node:assert/strict";
import test from "node:test";
import { chooseBeaconNode, orderedBeaconEndpoints, selectHiveNode } from "../dist/beacon.js";

const fallbackEndpoint = "https://api.hive.blog";
const rcFeatures = ["get_rc_stats"];

test("chooseBeaconNode prefers api.hive.blog when its score meets the threshold", () => {
  const selected = chooseBeaconNode(
    [
      node("api.hive.blog", fallbackEndpoint, 90, 10, 100),
      node("api.openhive.network", "https://api.openhive.network", 100, 24, 105),
    ],
    fallbackEndpoint,
  );

  assert.equal(selected.endpoint, fallbackEndpoint);
});

test("chooseBeaconNode switches to the next best node when api.hive.blog is below threshold", () => {
  const selected = chooseBeaconNode(
    [
      node("api.hive.blog", fallbackEndpoint, 89, 24, 105),
      node("api.openhive.network", "https://api.openhive.network", 100, 23, 104),
      node("techcoderx.com", "https://techcoderx.com", 100, 24, 103),
    ],
    fallbackEndpoint,
  );

  assert.equal(selected.endpoint, "https://techcoderx.com");
});

test("chooseBeaconNode ignores nodes that do not advertise RC stats", () => {
  const selected = chooseBeaconNode(
    [
      node("api.hive.blog", fallbackEndpoint, 80, 24, 105),
      { ...node("api.fast.invalid", "https://api.fast.invalid", 100, 24, 106), features: [] },
      node("api.openhive.network", "https://api.openhive.network", 95, 23, 104),
    ],
    fallbackEndpoint,
  );

  assert.equal(selected.endpoint, "https://api.openhive.network");
});

test("orderedBeaconEndpoints puts the selected node first and deduplicates candidates", () => {
  const endpoints = orderedBeaconEndpoints(
    [
      node("api.hive.blog", fallbackEndpoint, 89, 24, 105),
      node("api.openhive.network", "https://api.openhive.network", 100, 23, 104),
      node("techcoderx.com", "https://techcoderx.com", 100, 24, 103),
      node("techcoderx.com", "https://techcoderx.com", 100, 24, 103),
    ],
    fallbackEndpoint,
  );

  assert.deepEqual(endpoints, ["https://techcoderx.com", "https://api.openhive.network", fallbackEndpoint]);
});

test("selectHiveNode falls back to api.hive.blog when Beacon cannot be read", async () => {
  const selected = await selectHiveNode({
    fallbackEndpoint,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });

  assert.deepEqual(selected, { endpoint: fallbackEndpoint, source: "fallback", endpoints: [fallbackEndpoint], nodes: [] });
});

test("selectHiveNode reads Beacon and returns the chosen endpoint", async () => {
  const selected = await selectHiveNode({
    fallbackEndpoint,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return [node("api.hive.blog", fallbackEndpoint, 50, 24, 105), node("api.openhive.network", "https://api.openhive.network", 100, 23, 104)];
      },
    }),
  });

  assert.equal(selected.endpoint, "https://api.openhive.network");
  assert.equal(selected.source, "beacon");
  assert.deepEqual(selected.endpoints, ["https://api.openhive.network", fallbackEndpoint]);
});

function node(name, endpoint, score, success, lastBlock) {
  return { name, endpoint, score, success, lastBlock, features: rcFeatures };
}
