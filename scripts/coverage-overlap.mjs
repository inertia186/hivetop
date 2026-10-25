import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const exactName = name => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const difference = (a, b) => new Set([...a].filter(value => !b.has(value)));
const union = sets => new Set(sets.flatMap(set => [...set]));
const metricNames = ["totalLineCount", "coveredLineCount", "totalBranchCount", "coveredBranchCount", "totalFunctionCount", "coveredFunctionCount"];

// The same file is a Node reporter in child processes and the collector CLI in its parent.
export default async function* reporter(events) {
  for await (const { type, data } of events) {
    if (["test:pass", "test:fail", "test:summary"].includes(type)) {
      yield JSON.stringify({ type, data, error: data.details?.error?.message }) + "\n";
    } else if (type === "test:coverage") {
      yield JSON.stringify({ type, files: data.summary.files.map(file => ({ path: file.path,
        metrics: Object.fromEntries(metricNames.map(key => [key, file[key]])),
        lines: file.lines.filter(line => line.count > 0).map(line => line.line) })) }) + "\n";
    }
  }
}

async function capture(workspace, files, scratch, label, filter = []) {
  workspace = await realpath(workspace);
  const directory = join(scratch, label);
  await mkdir(directory);
  const args = ["--test", "--experimental-test-coverage", "--test-coverage-include=dist/**/*.js",
    `--test-reporter=${script}`, ...filter, ...files];
  try {
    const { stdout } = await execute(process.execPath, args, { cwd: workspace, timeout: 60000, maxBuffer: 16 * 1024 ** 2,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, NODE_V8_COVERAGE: directory } });
    const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const summaries = events.filter(event => event.type === "test:summary").map(event => event.data);
    assert.ok(summaries.length && summaries.every(summary => summary.success), `${label}: suite must pass`);
    assert.ok(summaries.every(({ counts }) => !counts.failed && !counts.cancelled && !counts.skipped && !counts.todo && !counts.suites),
      `${label}: only passing, unskipped, top-level test cases are supported`);
    const cases = events.filter(event => event.type === "test:pass").map(event => event.data)
      .filter(test => test.name !== relative(workspace, test.file)) // Node reports empty filtered files as passing wrappers.
      .map(test => {
        assert.equal(test.nesting, 0, "Nested cases need separate selection before using this collector");
        return { name: test.name, file: relative(workspace, test.file), line: test.line, durationMs: test.details.duration_ms };
      });
    assert.equal(cases.length, summaries.filter(summary => summary.file).reduce((sum, summary) => sum + summary.counts.tests, 0));
    const coverage = events.findLast(event => event.type === "test:coverage");
    assert.ok(coverage, `${label}: missing coverage report`);
    const lines = new Set(), native = {}, functions = new Map();
    for (const file of coverage.files) {
      const path = relative(workspace, file.path);
      native[path] = file.metrics;
      for (const line of file.lines) lines.add(`${path}:${line}`);
    }
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      for (const entry of JSON.parse(await readFile(join(directory, name), "utf8")).result) {
        if (!entry.url.startsWith("file:")) continue;
        const path = relative(workspace, fileURLToPath(entry.url));
        if (!path.startsWith("dist/") || !path.endsWith(".js")) continue;
        for (const fn of entry.functions) {
          const first = fn.ranges[0], key = `${path}:${first.startOffset}:${first.endOffset}`;
          const item = functions.get(key) ?? { file: path, name: fn.functionName, start: first.startOffset, end: first.endOffset, records: [] };
          item.records.push(fn.ranges);
          functions.set(key, item);
        }
      }
    }
    return { label, cases, durationMs: summaries.at(-1).duration_ms, native, lines, functions };
  } catch (error) {
    const failures = (error.stdout ?? "").split("\n").filter(line => line.includes('"type":"test:fail"'));
    throw new Error(`${label}: ${error.message.split("\n")[0]}\n${failures.join("\n")}\n${(error.stderr ?? "").slice(0, 2000)}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function featureSpace(runs) {
  const functions = new Map();
  for (const run of runs) for (const [key, fn] of run.functions) {
    const value = functions.get(key) ?? { ...fn, boundaries: new Set() };
    for (const ranges of fn.records) for (const range of ranges) {
      value.boundaries.add(range.startOffset); value.boundaries.add(range.endOffset);
    }
    functions.set(key, value);
  }
  const features = [...union(runs.map(run => run.lines))].sort().map(key => ({ kind: "line", key }));
  for (const [key, fn] of [...functions].sort(([a], [b]) => a.localeCompare(b))) {
    features.push({ kind: "function", key, file: fn.file, name: fn.name, start: fn.start, end: fn.end });
    const bounds = [...fn.boundaries].sort((a, b) => a - b);
    for (let i = 1; i < bounds.length; i++) features.push({ kind: "block", key, file: fn.file, start: bounds[i - 1], end: bounds[i] });
  }
  return features;
}

function covered(run, feature) {
  if (feature.kind === "line") return run.lines.has(feature.key);
  const fn = run.functions.get(feature.key);
  if (!fn) return false;
  return fn.records.some(ranges => {
    if (feature.kind === "function") return ranges[0].count > 0;
    // Missing inner ranges inherit their nearest containing range's count.
    // Partitioning at every observed boundary makes comparisons independent of V8's varying range shapes.
    const containing = ranges.filter(range => range.startOffset <= feature.start && range.endOffset >= feature.end)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return containing.length > 0 && containing[0].count > 0;
  });
}

function analyze(full, controls, isolated, extra = []) {
  const features = featureSpace([full, ...controls, ...isolated, ...extra]);
  const hit = run => new Set(features.flatMap((feature, id) => covered(run, feature) ? [id] : []));
  const importOnly = union(controls.map(hit));
  const hits = run => difference(hit(run), importOnly);
  const perTest = isolated.map(hits), owners = features.map(() => []);
  perTest.forEach((set, index) => { for (const id of set) owners[id].push(index); });
  const counts = ids => Object.fromEntries(["line", "function", "block"].map(kind => [kind, [...ids].filter(id => features[id].kind === kind).length]));
  const ranked = isolated.map((run, index) => {
    const ids = perTest[index], unique = [...ids].filter(id => owners[id].length === 1);
    const remaining = new Set(ids), coveringTests = [];
    while (remaining.size) {
      const options = perTest.map((set, other) => ({ other, shared: [...remaining].filter(id => set.has(id)).length }))
        .filter(option => option.other !== index && option.shared > 0)
        .sort((a, b) => b.shared - a.shared || perTest[a.other].size - perTest[b.other].size || a.other - b.other);
      if (!options.length) break;
      const best = options[0];
      coveringTests.push({ test: best.other, features: best.shared });
      for (const id of perTest[best.other]) remaining.delete(id);
    }
    return { test: index, ...run.cases[0], covered: counts(ids), unique: counts(unique),
      overlapFraction: ids.size ? (ids.size - unique.length) / ids.size : null,
      featureIds: [...ids], uniqueFeatureIds: unique, coveringTests };
  }).sort((a, b) => a.uniqueFeatureIds.length - b.uniqueFeatureIds.length || b.featureIds.length - a.featureIds.length || a.test - b.test);
  const allIsolated = union(perTest), fullHits = hits(full);
  return { features, ranked, importOnlyFeatureIds: [...importOnly], fullFeatureIds: [...fullHits],
    fullOnlyFeatureIds: [...difference(fullHits, allIsolated)], isolatedOnlyFeatureIds: [...difference(allIsolated, fullHits)],
    hits, counts };
}

async function sourceHashes(workspace) {
  const paths = ["package.json", "scripts/coverage-overlap.mjs"];
  async function collect(directory) {
    for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (/\.(ts|js|mjs)$/.test(path)) paths.push(path);
    }
  }
  for (const directory of ["src", "dist", "test"]) await collect(directory);
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path,
    createHash("sha256").update(await readFile(join(workspace, path))).digest("hex")])));
}

async function measure(output) {
  await access(output).then(() => { throw new Error(`Output already exists: ${output}`); }, error => { if (error.code !== "ENOENT") throw error; });
  const startedAt = new Date().toISOString(), hashes = await sourceHashes(root);
  const scratch = await mkdtemp(join(tmpdir(), "hivetop-overlap-"));
  try {
    const files = (await readdir(join(root, "test"))).filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`);
    const full = await capture(root, files, scratch, "full");
    const names = full.cases.map(test => test.name);
    assert.equal(new Set(names).size, names.length, "Test names must be unique for exact leave-one-out selection");
    const runtime = (await readdir(join(root, "dist"))).filter(name => name.endsWith(".js") && name !== "types.js").map(name => `dist/${name}`).sort();
    assert.deepEqual(Object.keys(full.native).sort(), runtime, "All executable runtime modules must be covered by the inventory");
    const controls = [];
    for (const [index, file] of files.entries()) {
      const control = await capture(root, [file], scratch, `imports-${index}`, ["--test-name-pattern=(?!)"]);
      assert.equal(control.cases.length, 0);
      controls.push(control);
    }
    const isolated = [];
    for (const [index, test] of full.cases.entries()) {
      const run = await capture(root, [test.file], scratch, `test-${index}`, [`--test-name-pattern=${exactName(test.name)}`]);
      assert.equal(run.cases.length, 1, `Expected exactly one case: ${test.name}`);
      assert.equal(run.cases[0].name, test.name);
      isolated.push(run);
      if ((index + 1) % 10 === 0 || index + 1 === names.length) console.error(`Measured ${index + 1}/${names.length} cases`);
    }
    const initial = analyze(full, controls, isolated);
    const candidates = initial.ranked.filter(row => row.featureIds.length && !row.uniqueFeatureIds.length).slice(0, 5);
    const checks = [];
    for (const candidate of candidates) {
      console.error(`Checking full suite without: ${candidate.name}`);
      const run = await capture(root, files, scratch, `without-${candidate.test}`, [`--test-skip-pattern=${exactName(candidate.name)}`]);
      assert.deepEqual(run.cases.map(test => test.name).sort(), names.filter(name => name !== candidate.name).sort());
      checks.push({ test: candidate.test, run });
    }
    const finalFull = await capture(root, files, scratch, "full-repeat");
    assert.deepEqual(finalFull.cases.map(test => test.name).sort(), [...names].sort());
    const analysis = analyze(full, controls, isolated, [...checks.map(check => check.run), finalFull]);
    const reference = new Set(analysis.fullFeatureIds);
    const validations = checks.map(({ test, run }) => ({ test, cases: run.cases.length, durationMs: run.durationMs,
      lostFeatureIds: [...difference(reference, analysis.hits(run))], addedFeatureIds: [...difference(analysis.hits(run), reference)], native: run.native }));
    const repeat = { lostFeatureIds: [...difference(reference, analysis.hits(finalFull))],
      addedFeatureIds: [...difference(analysis.hits(finalFull), reference)], native: finalFull.native };
    assert.deepEqual(await sourceHashes(root), hashes, "Source changed during measurement");
    const { stdout: commit } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
    const { stdout: diff } = await execute("git", ["diff", "--", "src", "dist", "test"], { cwd: root });
    const { hits, counts, ...data } = analysis;
    const report = { schema: 1, startedAt, endedAt: new Date().toISOString(), sourceCommit: commit.trim(), sourceDiff: diff, hashes,
      environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model },
      method: "Each top-level test runs alone in its file using an exact escaped name. File-load controls run zero cases; their union is subtracted. Native covered lines and raw V8 function offsets are combined with function-scoped code segments partitioned at every observed V8 range boundary. Segments inherit the smallest containing range's count; subprocess hits are unioned. These segments are not native branch counts. Unique means no other isolated test covers the feature. Up to five initially zero-unique candidates get full-suite leave-one-out checks; their collective removal is not tested. This measures execution overlap, including fixtures and callbacks, not assertion equivalence. Native totals are retained separately. Durations are single observations, not a speed benchmark.",
      testCount: names.length, native: full.native, fullDurationMs: full.durationMs,
      controls: controls.map(run => ({ file: files[controls.indexOf(run)], cases: run.cases.length, durationMs: run.durationMs })),
      ...data, validations, fullRepeat: repeat };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(`Saved ${names.length} cases to ${output}`);
    console.log(`${analysis.ranked.filter(row => row.featureIds.length && !row.uniqueFeatureIds.length).length} cases have no unique measured coverage; ${validations.filter(row => !row.lostFeatureIds.length).length}/${validations.length} leave-one-out checks lost no measured features.`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function verify() {
  const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
  const fixture = records => ({ cases: [{ name: "fixture" }], lines: new Set(), functions: new Map([["dist/a.js:0:100",
    { file: "dist/a.js", name: "f", start: 0, end: 100, records }]]) });
  const full = fixture([[range(0, 100, 1), range(20, 40, 0)]]);
  const feature = { kind: "block", key: "dist/a.js:0:100", start: 25, end: 30 };
  assert.equal(covered(full, feature), false);
  assert.equal(covered(fixture([[range(0, 100, 1)]]), feature), true);
  assert.equal(covered(fixture([[range(0, 100, 0)], [range(0, 100, 1)]]), feature), true);
  const analysis = analyze(full, [fixture([[range(0, 100, 0)]])], [full, full]);
  assert.ok(analysis.ranked[0].featureIds.length);
  assert.ok(analysis.ranked.every(row => row.uniqueFeatureIds.length === 0));
  assert.deepEqual(analysis.ranked[0].coveringTests.map(row => row.test), [1]);
  const unique = analyze(full, [], [full, fixture([[range(0, 100, 0)]])]);
  assert.ok(unique.ranked.find(row => row.test === 0).uniqueFeatureIds.length);
  assert.equal(analyze(full, [full], [full]).ranked[0].featureIds.length, 0);
  assert.ok(new RegExp(exactName("name (a+b) [x].")).test("name (a+b) [x]."));
  assert.ok(!new RegExp(exactName("name (a+b) [x].")).test("name aaab x!"));
  const workspace = await mkdtemp(join(tmpdir(), "hivetop-overlap-check-"));
  try {
    await mkdir(join(workspace, "dist")); await mkdir(join(workspace, "test"));
    await writeFile(join(workspace, "package.json"), '{"type":"module"}');
    await writeFile(join(workspace, "dist", "a.js"), "export function choose(x) { if (x) return 1; return 0; }\n");
    await writeFile(join(workspace, "test", "a.test.mjs"), `import test from 'node:test'; import assert from 'node:assert/strict'; import {choose} from '../dist/a.js';
test('left (a+b)',()=>assert.equal(choose(true),1)); test('right',()=>assert.equal(choose(false),0));\n`);
    const files = ["test/a.test.mjs"];
    const all = await capture(workspace, files, workspace, "all");
    const empty = await capture(workspace, files, workspace, "empty", ["--test-name-pattern=(?!)"]);
    const left = await capture(workspace, files, workspace, "left", [`--test-name-pattern=${exactName("left (a+b)")}`]);
    const right = await capture(workspace, files, workspace, "right", ["--test-skip-pattern=^left \\(a\\+b\\)$"]);
    assert.equal(all.cases.length, 2); assert.equal(empty.cases.length, 0);
    assert.equal(left.cases.length, 1); assert.equal(right.cases.length, 1);
    const measured = analyze(all, [empty], [left, right]);
    assert.ok(measured.ranked.every(row => row.unique.block > 0), "Opposite branches must contribute different coverage");
    assert.equal(measured.fullOnlyFeatureIds.length, 0);
    assert.ok(measured.importOnlyFeatureIds.length > 0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
  console.log("Coverage overlap self-checks passed: nested ranges, subprocess union, unique/shared coverage, import subtraction, exact selection, and opposite branches.");
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node >=24");
  assert.ok(args.length === 1 && args[0] === "--verify" || args.length === 2 && args[0] === "--output",
    "Usage: node scripts/coverage-overlap.mjs --verify | --output report.json");
  (args[0] === "--verify" ? verify() : measure(resolve(args[1]))).catch(error => { console.error(error); process.exitCode = 1; });
}
