import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { TerminalScreen } from "../test/helpers/terminal-screen.mjs";

// Keep A immutable while B follows the working tree's rebuilt runtime.
const baseline = "5aaf3c28e41cc9e0a12ff711bd50a13414fe394e";
const baselineHash = "ca95ae5a439b91cc8647157f2b480b4c66f935668a295219b94aa737e263d81c";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const live = args[0] === "--live" ? args[1] : undefined;
if (args.length && !["A", "B"].includes(live)) {
  throw new Error("Usage: npm run ab:tui [-- --live A|B [hivetop options]]");
}
const directory = await mkdtemp(join(tmpdir(), "hivetop-ab-"));

try {
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  const files = execFileSync("git", ["ls-tree", "--name-only", `${baseline}:dist`], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    await writeFile(join(directory, file), execFileSync("git", ["show", `${baseline}:dist/${file}`], { cwd: root }));
  }
  execFileSync("git", ["apply", "-p2", join(root, "scripts/fixtures/tui-ab-baseline.patch")], { cwd: directory });
  assert.equal(createHash("sha256").update(await readFile(join(directory, "tui.js"))).digest("hex"), baselineHash, "A must match the preserved candidate");
  if (live) {
    console.error(`${live}: ${live === "A" ? "baseline with clipping fix and duplicate suppression" : "working-tree candidate"}`);
    const cli = live === "A" ? join(directory, "cli.js") : join(root, "dist/cli.js");
    const child = spawn(process.execPath, [cli, ...args.slice(2)], { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  } else {
    const { TerminalUi: A } = await import(pathToFileURL(join(directory, "tui.js")));
    const { TerminalUi: B } = await import("../dist/tui.js");
    await compare(A, B);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

function fixture(now) {
  const witnesses = ["alice", "bob", "carol"];
  const blocks = Array.from({ length: 40 }, (_, index) => ({
    number: 104 - index, timestamp: new Date(now - index * 3000), witness: witnesses[index % 3],
    transactionCount: 12, transactions: Array.from({ length: 12 }, (_, tx) => ({ id: `${index}-${tx}`, primaryOperationType: "vote" })),
    operationCount: 24, virtualOperationCount: 2, operationTypes: new Map([["vote", 24]]), sizeBytes: 1024 + (index % 7) * 768,
  }));
  return {
    event: { type: "block", block: blocks[0], headBlock: 104, lag: 0,
      dynamicGlobalProperties: { head_block_number: 104, current_aslot: 103, time: new Date(now).toISOString(), last_irreversible_block_num: 84 },
      witnessSchedule: { current_shuffled_witnesses: witnesses, future_shuffled_witnesses: ["dan", "erin", "frank"], next_shuffle_block_num: 105 },
      witnessRanks: { alice: 1, bob: 2, carol: 3 }, witnessFeedUpdates: Object.fromEntries(witnesses.map(name => [name, new Date(now).toISOString()])),
      witnessVersions: { alice: "1.28.3", bob: "1.28.3", carol: "1.28.2" }, majorityWitnessVersion: "1.28.3", missedBlocks: [],
    },
    snapshot: { blocks, blockRate: 1 / 3, transactionRate: 4, operationRate: 8, virtualOperationRate: 2 / 3, operationTypes: [["vote", 960]], witnesses: [["alice", 14], ["bob", 13], ["carol", 13]] },
  };
}

async function compare(A, B) {
  const originalWrite = process.stdout.write;
  const originalNow = Date.now;
  const dimensions = ["columns", "rows"].map(key => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  const epoch = Date.parse("2026-10-12T12:00:00Z");
  let now = epoch;
  let writes = 0;
  let bytes = 0;
  let activeScreen;
  let verified = 0;
  Date.now = () => now;
  process.stdout.write = chunk => {
    const output = String(chunk);
    writes++; bytes += Buffer.byteLength(output);
    activeScreen?.write(output);
    return true;
  };
  const setSize = (columns, rows) => {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
  };
  const freeze = ui => { ui.stopRevealTimer(); ui.stopRetractTimer(); ui.stopSpinnerTimer(); };
  const makeUi = (Ui, options) => {
    now = epoch;
    const { event, snapshot } = fixture(now);
    const ui = new Ui({ node: "https://fixture.test", windowSeconds: 120, ...options, onQuit() {}, onPauseToggle() {}, onReset() {} });
    // Stub monitoring, not rendering: identical deterministic status data, no network or async callbacks.
    ui.txStatusMonitor = { sync() {}, stop() {}, displayBlocks: () => snapshot.blocks,
      statusFor: id => ({ category: Number(id.split("-")[1]) % 2 ? "reversible" : "irreversible", glyph: "I" }),
      diagnostic: () => undefined, budgetLine: () => "status RPC budget 4 request/s  backlog 0" };
    ui.render(event, snapshot);
    freeze(ui);
    ui.revealedFutureRows = 3;
    return ui;
  };
  const measurements = [];
  try {
    for (const [columns, rows] of [[48, 18], [80, 24], [160, 50]]) {
      for (const view of ["blocks", "round", "txstatus", "sizes"]) {
        for (const mode of ["color", "no-color", "ascii"]) {
          setSize(columns, rows);
          const options = { view, noColor: mode !== "color", ascii: mode === "ascii" };
          const pair = [];
          try {
            for (const Ui of [A, B]) {
              const screen = new TerminalScreen(columns, rows);
              activeScreen = screen;
              screen.write("\x1b[?1049h\x1b[?25l");
              pair.push({ screen, ui: makeUi(Ui, options) });
            }
            const check = async (name, action) => {
              for (const { ui, screen } of pair) {
                activeScreen = screen;
                action(ui, screen);
                freeze(ui);
              }
              const [a, b] = await Promise.all(pair.map(({ screen }) => screen.cells()));
              assert.deepEqual(b, a, `${columns}x${rows}/${view}/${mode}/${name}: terminal cells and styles must match`);
              verified++;
            };
            await check("initial", ui => ui.draw());
            await check("unchanged", ui => ui.draw());
            await check("spinner", ui => { ui.spinnerFrame++; ui.draw(); });
            now += 1000;
            await check("clock", ui => ui.draw());
            await check("selection", ui => ui.onKey("j"));
            await check("details", ui => ui.onKey("\r"));
            await check("close details", ui => ui.onKey("\x1b"));
            await check("help", ui => ui.onKey("?"));
            await check("page help", ui => ui.onKey("\x1b[6~"));
            await check("close help", ui => ui.onKey("\x1b"));
            await check("filter input", ui => { ui.onKey("/"); ui.onKey("alice"); });
            await check("filter apply", ui => ui.onKey("\r"));
            await check("filter clear", ui => ui.onKey("\x1b"));
            await check("events", ui => ui.onKey("e"));
            await check("close events", ui => ui.onKey("\x1b"));
            await check("transaction status", ui => {
              ui.txStatusMonitor.statusFor = () => ({ category: "checking", glyph: "*" }); ui.draw();
            });
            await check("view switch", ui => ui.onKey("v"));
            await check("stale", ui => { ui.lastDataReceivedAt = now - 16000; ui.draw(); });
            for (const [width, height] of [[40, 14], [180, 55], [columns, rows]]) {
              setSize(width, height);
              await check(`resize ${width}x${height}`, (ui, screen) => { screen.resize(width, height); ui.onResize(); });
            }
            await check("color removed", ui => { ui.noColor = true; ui.draw(); });
            const plain = await pair[1].screen.text();
            assert.ok(plain.split("\n").length === rows);
            if (mode === "ascii") assert.ok(!/[^\x00-\x7f]/.test(plain));
          } finally {
            activeScreen = undefined;
            for (const { ui, screen } of pair) { ui.stop(); screen.dispose(); }
          }
        }
        // Emulator verification stays outside the timed section. Both variants use the same sink.
        for (const workload of ["4 Hz", "all changed"]) {
          const samples = { A: [], B: [] };
          for (let trial = 0; trial < 7; trial++) {
            for (const label of trial % 2 ? ["B", "A"] : ["A", "B"]) {
              const ui = makeUi(label === "A" ? A : B, { view, noColor: false });
              try {
                for (let i = 0; i < 100; i++) { now += 1000; ui.draw(); }
                now = epoch; ui.onResize();
                writes = 0; bytes = 0;
                const start = performance.now();
                for (let i = 0; i < 400; i++) {
                  now = epoch + (1 + (workload === "4 Hz" ? Math.floor(i / 4) : i)) * 1000;
                  ui.spinnerFrame = i + 1;
                  ui.draw();
                }
                samples[label].push({ ms: performance.now() - start, writes, bytes });
              } finally { ui.stop(); }
            }
          }
          measurements.push({ size: `${columns}x${rows}`, view, workload,
            A: median(samples.A), B: median(samples.B) });
        }
      }
    }
  } finally {
    process.stdout.write = originalWrite;
    Date.now = originalNow;
    for (const [key, descriptor] of dimensions) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else delete process.stdout[key];
    }
  }
  console.log(`A: ${baseline} + scripts/fixtures/tui-ab-baseline.patch (SHA-256 ${baselineHash})`);
  console.log(`B: current dist/ (run through npm run ab:tui to rebuild)\nNode: ${process.version}`);
  console.log(`Correctness: ${verified} screen comparisons passed across 36 view/size/color cases, including cell colors and styles.`);
  console.table(measurements.map(result => ({
    size: result.size, view: result.view, workload: result.workload,
    "A writes": result.A.writes, "B writes": result.B.writes,
    "bytes saved": `${(100 * (1 - result.B.bytes / result.A.bytes)).toFixed(1)}%`,
    "A ms": result.A.ms.toFixed(2), "B ms": result.B.ms.toFixed(2),
  })));
  console.log("Times are medians of 7 alternating-order trials, 400 draws each, after warmup.");
  console.log("This measures frame construction and an in-memory output sink, not terminal paint latency, RPC, or CPU saved by a real terminal.");
}

function median(samples) {
  return [...samples].sort((a, b) => a.ms - b.ms)[Math.floor(samples.length / 2)];
}
