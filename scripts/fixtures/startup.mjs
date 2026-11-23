import { stripVTControlCharacters } from "node:util";

const dashboard = process.env.HIVETOP_BENCH_MODE === "dashboard";
const send = value => process.send?.(value);
let props = 0, first = false, second = false, inputDone = false;
if (dashboard) {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 160, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
  process.stdin.setRawMode = () => {};
}

globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://fixture.test") throw new Error(`Unexpected network request ${url}`);
  const request = JSON.parse(init.body);
  send({ type: "request", method: request.method });
  const names = Array.from({ length: 21 }, (_, n) => `fixture-w${n}`);
  let result;
  switch (request.method) {
    case "condenser_api.get_dynamic_global_properties":
      result = { head_block_number: 10000 + props++, time: "2026-10-25T12:00:00", current_aslot: 10000 }; break;
    case "condenser_api.get_block":
      result = { block_id: request.params[0].toString(16).padStart(40, "0"), timestamp: "2026-10-25T12:00:00", witness: names[0], transactions: [] }; break;
    case "condenser_api.get_ops_in_block": result = []; break;
    case "condenser_api.get_witness_schedule": result = { current_shuffled_witnesses: names, future_shuffled_witnesses: names, next_shuffle_block_num: 10017, num_scheduled_witnesses: 21 }; break;
    case "condenser_api.get_hardfork_version": result = "1.28.0"; break;
    case "condenser_api.get_next_scheduled_hardfork": result = {}; break;
    case "condenser_api.get_witnesses_by_vote": result = [{ owner: names[0] }]; break;
    case "rc_api.get_rc_stats": result = { rc_stats: {} }; break;
    default: throw new Error(`Unexpected RPC ${request.method}`);
  }
  return { ok: true, status: 200, async json() {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
      const timer = setTimeout(() => { init.signal.removeEventListener("abort", abort); resolve({ id: request.id, result }); }, 10);
      init.signal.addEventListener("abort", abort, { once: true });
      if (init.signal.aborted) abort();
    });
  } };
};

const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const result = write(chunk, ...args), text = stripVTControlCharacters(String(chunk));
  const matches = number => dashboard ? text.includes(String(number)) && text.includes("fixture-w0")
    : text.includes(`"type":"block"`) && text.includes(`"block":${number},`) && text.includes(`"produced":"fixture-w0"`);
  if (!first && matches(10000)) {
    first = true; send({ type: "first" });
    if (dashboard) setImmediate(() => {
      const at = performance.now();
      process.stdin.emit("keypress", "j", { name: "j" });
      inputDone = true; send({ type: "input", elapsedMs: performance.now() - at });
    });
  }
  if (first && !second && matches(10001)) {
    second = true; send({ type: "second" });
    if (dashboard) setImmediate(() => {
      if (!inputDone) throw new Error("Input control did not run");
      process.emit("SIGINT");
    });
  }
  return result;
};
