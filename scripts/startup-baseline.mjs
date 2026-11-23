import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "scripts/fixtures/startup.mjs");
const files = [...(await readdir(join(root, "dist"))).filter(f => f.endsWith(".js")).map(f => `dist/${f}`), "scripts/fixtures/startup.mjs", "scripts/startup-baseline.mjs"];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async f => [f, createHash("sha256").update(await readFile(join(root, f))).digest("hex")])));
const initial = await hashes();

function trial(mode) {
  return new Promise((resolve, reject) => {
    const at = performance.now(), markers = {}, requests = [];
    let stdout = "", stderr = "";
    const child = spawn(process.execPath, ["--import", fixture, join(root, "dist/cli.js"), "--node", "https://fixture.test", "--start", "10000", "--poll-ms", "1000",
      ...(mode === "follow" ? ["--follow", "--limit", "2"] : [])], {
      cwd: root, env: { ...process.env, HIVETOP_BENCH_MODE: mode, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${mode}: startup timeout`)); }, 10000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("message", message => {
      if (message.type === "request") requests.push(message.method);
      else if (message.type === "input") markers.inputMs = message.elapsedMs;
      else markers[`${message.type}Ms`] = performance.now() - at;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, stderr); assert.equal(signal, null);
        assert.ok(markers.firstMs > 0 && markers.secondMs > markers.firstMs);
        if (mode === "follow") {
          const rows = stdout.trim().split("\n").map(line => JSON.parse(line));
          assert.deepEqual(rows.map(row => row.block), [10000, 10001]);
          assert.ok(rows.every(row => row.produced === "fixture-w0"));
        } else {
          const text = stripVTControlCharacters(stdout);
          assert.ok(text.includes("10000") && text.includes("10001") && text.includes("fixture-w0"));
          assert.ok(Number.isFinite(markers.inputMs));
          assert.ok(stdout.includes("\x1b[?1049l"), "dashboard restores terminal state");
        }
        assert.equal(requests.filter(m => m === "condenser_api.get_block").length, 2);
        resolve({ mode, ...markers, exitMs: performance.now() - at, requests, stdoutBytes: Buffer.byteLength(stdout) });
      } catch (error) { reject(error); }
    });
  });
}

for (const mode of ["follow", "dashboard"]) await trial(mode);
const report = { date: new Date().toISOString(), node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), hashes: initial, trials: [] };
for (let n = 0; n < 21; n++) for (const mode of n % 2 ? ["dashboard", "follow"] : ["follow", "dashboard"]) report.trials.push(await trial(mode));
const p95 = a => a.sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1];
for (const mode of ["follow", "dashboard"]) {
  const rows = report.trials.filter(t => t.mode === mode);
  console.log(`${mode}: first p95 ${p95(rows.map(r => r.firstMs)).toFixed(2)} ms; second p95 ${p95(rows.map(r => r.secondMs)).toFixed(2)} ms; input p95 ${mode === "dashboard" ? p95(rows.map(r => r.inputMs)).toFixed(3) : "n/a"} ms; requests ${Math.min(...rows.map(r => r.requests.length))}-${Math.max(...rows.map(r => r.requests.length))}`);
}
assert.deepEqual(await hashes(), initial);
await writeFile(process.argv[2] ?? "benchmarks/startup-baseline.json", JSON.stringify(report, null, 2) + "\n");
