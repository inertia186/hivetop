import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "benchmarks/fault-baseline.json");
const panelPath = join(root, "scripts/fixtures/fault-panel.json");
const panel = JSON.parse(await readFile(panelPath, "utf8"));
const hash = text => createHash("sha256").update(text).digest("hex");
const files = [...(await readdir(join(root, "dist"))).filter(f => f.endsWith(".js")).map(f => `dist/${f}`),
  ...(await readdir(join(root, "test"))).filter(f => f.endsWith(".mjs")).map(f => `test/${f}`),
  "scripts/fault-baseline.mjs", "scripts/fault-witness.mjs", "scripts/fixtures/fault-panel.json"];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await readFile(join(root, f)))])));
const initial = await hashes();
const scratch = await mkdtemp(join(tmpdir(), "hivetop-fault-"));
const run = (args, cwd = scratch) => {
  const start = performance.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, `process infrastructure failure: ${result.error}`);
  assert.equal(result.signal, null, "signals/timeouts are not detections");
  return { code: result.status, elapsedMs: performance.now() - start, stdout: result.stdout, stderr: result.stderr };
};
const tests = files.filter(f => f.startsWith("test/"));
const report = { date: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version, hashes: initial, controls: [], faults: [] };
await mkdir(resolve(output, ".."), { recursive: true });
try {
  for (const f of ["dist", "test", "package.json"]) await cp(join(root, f), join(scratch, f), { recursive: true });
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
  for (const fault of panel) {
    const original = await readFile(join(scratch, fault.file), "utf8");
    assert.equal(original.split(fault.before).length - 1, 1, `${fault.id}: mutation must match once`);
    assert.equal(run([join(root, "scripts/fault-witness.mjs"), scratch, fault.id]).code, 0, `${fault.id}: unchanged witness`);
  }
  // Three uninstrumented controls establish suite runtime, not a tail estimate.
  for (let n = 0; n < 3; n++) {
    const result = run(["--test", "--test-timeout=10000", "--test-reporter=tap", ...tests]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    await writeFile(`${output}.control-${n}.log`, result.stdout + result.stderr);
    report.controls.push({ elapsedMs: result.elapsedMs });
  }
  for (const fault of panel) {
    const path = join(scratch, fault.file), original = await readFile(path, "utf8");
    try {
      const mutated = original.replace(fault.before, fault.after);
      await writeFile(path, mutated);
      assert.equal(run(["--check", path]).code, 0, `${fault.id}: invalid syntax`);
      const witness = run([join(root, "scripts/fault-witness.mjs"), scratch, fault.id]);
      assert.equal(witness.code, 42, `${fault.id}: mutation lacks a behavioral witness: ${witness.stderr}`);
      const result = run(["--test", "--test-timeout=10000", "--test-reporter=tap", ...tests]);
      assert.ok(result.code === 0 || result.code === 1);
      const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
      if (result.code === 1) assert.ok(failures.length, "failure must be a reported test assertion");
      const timedOut = result.stdout.includes("testTimeoutFailure");
      await writeFile(`${output}.${fault.id}.log`, result.stdout + result.stderr);
      const outcome = timedOut ? "timeout (not a detection)" : result.code === 1 ? "detected" : "missed";
      report.faults.push({ id: fault.id, mutatedHash: hash(mutated), witnessed: true, detected: result.code === 1 && !timedOut, outcome, failures, elapsedMs: result.elapsedMs });
      console.log(`${fault.id}: ${outcome}`);
    } finally { await writeFile(path, original); }
  }
  assert.deepEqual(await hashes(), initial, "original runtime/tests/panel must remain unchanged");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Detected ${report.faults.filter(f => f.detected).length}/${panel.length}; report ${output}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
