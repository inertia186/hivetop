# Hill-climbing goals

Baseline investigation: 2026-10-24, `4610edf` (v1.10.0), Apple M2 / macOS arm64,
Node 24.16.0. The starting suite had 122 passing tests. Results below were
recorded on 2026-10-25. The suite reached 129 tests after consolidation and
new asynchronous/retention regressions. The block-size hill adds four cases,
bringing the current suite to 133 tests.

Raw measurements and full session notes remain local in the ignored
`benchmarks/` directory. They are not committed. This file preserves the scores,
constraints, decisions, and commands; measurement scripts generate fresh reports
without requiring those local artifacts.

## Evaluation rules

1. Fix workload, expected results, resource ceilings, and target before editing.
   Control clocks for correctness; use a monotonic clock for elapsed time.
2. Change one thing at a time. Warm both versions and alternate at least seven
   paired runs before accepting a performance improvement. Report each case.
3. Preserve completion, identity, cancellation, errors, and full metrics history.
   Count HTTP calls, RPC operations, and actual concurrency separately.
4. Keep only gains exceeding measurement variation. Stop at the target or after
   three consecutive unsuccessful experiments. Preserve rejected results locally.
5. Keep the dependency-free runtime. Run tests and coverage, and commit generated
   `dist/` files with accepted source changes. Live observations are not controlled
   before/after performance comparisons.

## 1. Resolve transaction statuses sooner within the RPC budget

**Score:** p95 observation-to-display time, including checking dwell, with
completion coverage and unresolved age reported alongside it.

**Baseline:** The fixed steady trace completes 1,200/1,200 transactions with
3,050 ms p95, 4 peak HTTP calls/s, 4 peak RPC operations/s, and 1 request in
flight. The normal trace uses a 120-second window, 250 ms request spacing,
100 ms response bodies, and 200 ms checking dwell. The replay also covers bursts,
errors, rejected batches, queue/retention limits, shutdown, all views, and view
switching. A separate live capture resolved 2,529/2,529 measured transactions
with 79.85 s p95, showing substantial queue wait; it is not a controlled score.

**Target:** 30% lower steady p95 (at most 2,135 ms), with no reduced completion,
worse unresolved age, or increased per-case request/concurrency ceilings.

**Decision: parked; no scheduler change retained.** Three early-batching policies
were rejected. Unpaced batches reduce steady p95 to 800 ms but raise peak RPC
operations to 12/s. Operation-paced batches of eight or four reach 2,300 ms,
but retry fallback still reaches 32 HTTP calls/s and 8 concurrent requests,
versus baseline limits of 4/s and 1. Unavailable-API traffic also increases.

The original target is below the scheduling-only bound for this fixture:
twelve simultaneous arrivals need three groups of at most four operations in
sliding one-second windows. At least four cannot start before 2,000 ms; adding
the unchanged response and checking dwell gives 2,300 ms. Revisit the target or
requirements before trying further scheduling-only changes. Future work must
account for individual fallback request starts and probe API availability before
sending a larger initial batch.

```sh
npm run baseline:txstatus -- --output /tmp/hivetop-status.json
npm run baseline:txstatus -- --verify
# Optional read-only live capture, about eleven minutes:
npm run baseline:live -- --output /tmp/hivetop-status-live.json
npm run baseline:live -- --verify
```

The shutdown fixture assumes a request is in flight at its fixed checkpoint;
paced policies can be idle then. That limitation was recorded for rejected
candidates rather than claimed as successful cancellation validation.

## 2. Keep block delivery moving while schedules are slow

**Score:** p95 additional block-delivery delay relative to matching healthy
metadata; also record worst delay, head lag, schedule age, and failover recovery.

**Target:** Healthy block delivery within one 1,000 ms poll of the healthy trace,
without delaying healthy schedule updates. Keep the recorded total-request and
concurrency ceilings, endpoint coherence, virtual-operation evidence, and distinct
dashboard/diagnostic gap and limit policies.

**Accepted:** One background schedule refresh per endpoint, cancellation guards,
last-known data with 30-second error backoff, and request-slot reuse for block
and virtual-operation reads. Diagnostics continue through schedule-only failures
and report `schedule_error`. Idle diagnostic polling wakes when metadata arrives.

The fixture starts at block 18 and follows 50 records at three-second intervals.
Healthy RPC bodies take 100 ms; slow schedules take 5,000 ms; timeout cases stall
for 15,000 ms against unchanged 10,000 ms deadlines. The clock advances in 20 ms
steps. Cases include startup, round changes, persistent slow metadata, slow side
panels, block errors, failover, and null blocks. Seven alternating warmed pairs
produce identical repeated results and identical healthy output/schedule ages.

| Case | Dashboard p95, baseline → accepted | Diagnostics p95, baseline → accepted |
| --- | ---: | ---: |
| Startup | 500 → 100 ms | 500 → 200 ms |
| Round changes | 4,800 → 300 ms | 4,900 → 600 ms |
| Timeouts | 9,800 → 700 ms | Stops before first block → 700 ms, all 50 blocks |
| Persistent slow metadata | 5,400 → 400 ms | 103,200 → 800 ms |

Worst additional slow-metadata delay is 700 ms for the dashboard and 1,000 ms for
diagnostics. All traces stay within the predeclared per-path ceilings: dashboard
295 total HTTP calls / 6 concurrent; diagnostics 454 total calls / 2 concurrent.
These ceilings are maxima across baseline cases, not per-case or per-second
budgets. Healthy dashboard concurrency increases from 5 to 6 within that ceiling.

Tradeoffs: cached diagnostic schedules can reach 13.4 seconds old under slow
metadata; normal prediction expiry still applies. Dashboard failover recovery
increases from 300 to 400 ms, while diagnostics stay at 300 ms. The first candidate
had a 1,100 ms worst diagnostic delay; waking idle polling brought it to target.
Tests cover late endpoint responses, cancellation, backoff, both request-slot
release orders, pending metadata, pause/resume/reset, record limits, and wakeup.

```sh
mkdir -p /tmp/hivetop-metadata-original
git archive 4610edf dist package.json | tar -x -C /tmp/hivetop-metadata-original
npm run build
node scripts/metadata-baseline.mjs /tmp/hivetop-metadata-original /tmp/hivetop-metadata.json
```

## 3. Make hour-long windows cheaper without losing history

**Score:** Full event-processing CPU per simulated minute, with exact output and
state equivalence. Cover 120-, 600-, and 3,600-second windows, empty and 12-transaction
blocks, all four views, statuses, replacements, repeated-head reset, size updates,
window eviction, and input. Target: 30% less hour-window CPU, with no repeatable
fixed-default-window CPU or input-p95 regression above 5%.

**Accepted:** Sort retained block numbers once per overflowing sync rather than
once per deletion. Preserve the original no-overflow size comparison and existing
300-block status cap. Full metrics history still retains all 1,201 hour-window
records. No persistent cache, extra index, RPC policy, or drawing policy changes.

The baseline is the accepted metadata implementation at `5235ada`. The 160×50
color replay runs one simulated minute per case, with three-second blocks,
one-second status/block delivery, 250 ms steps, and 240 input samples. After
warmup, seven alternating pairs yield 336 measured traces. Exact ANSI output,
metrics/state hashes, status calls, queues, cached statuses, and retained block
identities match in every pair. Size data is prefilled; no network is involved.

| View | Empty blocks: CPU ms/min, baseline → accepted | 12 transactions/block: CPU ms/min, baseline → accepted |
| --- | ---: | ---: |
| Blocks | 655 → 69 | 1,221 → 576 |
| Round | 720 → 122 | 1,287 → 654 |
| Transaction status | 659 → 69 | 1,338 → 709 |
| Sizes | 708 → 118 | 1,291 → 651 |

Hour-window medians improve 47–90%. In every case the candidate's slowest sample
is below 70% of the baseline's fastest. Retention trimming falls from roughly
590–615 to 2–3 ms/min; metrics aggregation costs only 3–10 ms/min. Phase timings
are nested and include the first render; primary CPU starts after that render.
CPU includes harness checks, hashing, instrumentation, and scheduling.

**Default-control caveat:** The mixed-window matrix's tiny empty/default/block
case remains 11.9% higher by CPU ratio of medians, 12.8% by median paired ratio.
That short-case result is not claimed to pass. Longer fixed-window controls
use ten simulated minutes, all four empty-block views, seven alternating pairs,
and 2,400 input samples per trace. Maximum median paired CPU increase is 1.6%;
maximum median paired input-p95 increase is 0.6%. Transaction-heavy default cases
also pass the CPU guard. All matrix/control median input-p95 comparisons stay
within 5%. An identical-code A/A check shows one-minute default paired CPU ratios
from 0.86 to 1.08; hour CPU medians differ by 0.1%. It does not establish the
cause of the mixed-matrix bias. Acceptance uses longer fixed-window controls for
the small default guard, without a blanket claim about every workload history.

**Memory:** Before editing, fix a 128 MiB sampled-heap ceiling and at most 4 MiB
post-GC growth across the last three turnovers. A supplementary trace runs four
hour-window turnovers in ten-block catch-up bursts every 30 seconds, rendering
each burst without the independent health timer. All blocks are recorded; output
and state match. Sampled heap peaks at 86.0 MiB baseline / 72.1 MiB candidate.
Candidate post-GC boundary samples are 17.466, 17.506, 17.522, and 17.524 MiB.
These include benchmark modules and saved records, not isolated live-app memory.

```sh
mkdir -p /tmp/hivetop-window-original
git archive 5235ada dist package.json | tar -x -C /tmp/hivetop-window-original
npm run build
node --expose-gc scripts/window-baseline.mjs /tmp/hivetop-window-original /tmp/hivetop-window.json
node --expose-gc scripts/window-baseline.mjs /tmp/hivetop-window-original /tmp/hivetop-window-controls.json --controls
node --expose-gc scripts/window-baseline.mjs /tmp/hivetop-window-original /tmp/hivetop-window-aa.json --aa
```

The default mode runs the full matrix and turnover checks. `--controls` runs
longer empty/default-window comparisons; `--aa` creates and removes a second
identical baseline runtime copy for calibration. Neither diagnostic mode runs
turnover checks or needs old raw reports. Performance scripts require Node
24.16.0. Real terminal painting, follower transport cost, and live traffic are
outside these measurements.

## 4. Measure block sizes with fewer duplicate fetches

**Baseline:** 2026-10-25 at `0b882ed`. `getBlockSize` refetches a block that the
follower may have just received, then requests serialized operations for
nonempty blocks. The unchanged runtime was captured before editing.

**Score and target:** For newly followed payloads, reduce additional calls from
two to one for nonempty blocks and one to zero for empty blocks. Cold backfill
must not become slower or more expensive. Take the baseline before editing.

Preserve exact serialized bytes, block identity through replacements/endpoints,
chart gaps and peaks, cancellation, one-per-second backfill, and error backoff.
Set a memory ceiling before retaining raw payloads. Test signatures, header
extensions, empty blocks, large transaction counts, serialization failures,
view changes, filtering, replacements, and retries.

Candidate constraints fixed before editing: keep at most one serialized payload
per endpoint client, with at most 524,288 UTF-16 code units (1 MiB string storage,
excluding object headers and transient serialization). Reuse only for the exact
followed block ID and endpoint, consume once, and refetch on retries. Oversized
blocks use the original path. Cold measurements must keep their request count
and serial dependency depth; added follower p95 processing must remain below
5 ms in the fixed fixtures. Seven alternating warmed pairs compare exact sizes,
requests and measured elapsed time; modeled latency assumes 100 ms RPC bodies.

**Accepted:** Cache the latest fetched block as a bounded serialized string.
Carry block ID and endpoint through follower records into size requests. Match
both identities and the block number before consuming the payload; the next
followed-block read invalidates it, and late or aborted reads cannot replace it. Serialization
failures/cancellation consume the entry, so subsequent measurements refetch.
Cold size reads bypass cache creation. Existing backfill pacing, filtering,
chart rendering, and error backoff remain unchanged.

The deterministic fetch/serializer double assigns two serialized bytes per
operation and uses signed headers, signatures, header extensions, 128-transaction
blocks, and 500,000-/600,000-character operation payloads. Each trace measures
100 blocks, except longer cold controls with 10,000 measurements. Seven warmed,
alternating pairs per fixture produce 84 measured traces with identical sizes.

| Fixture | Additional calls/block, baseline → accepted | Modeled size-request latency |
| --- | ---: | ---: |
| Fresh empty | 1 → 0 | 100 → 0 ms |
| Fresh, 128 transactions | 2 → 1 | 200 → 100 ms |
| Fresh empty, header extensions | 1 → 0 | 100 → 0 ms |
| Fresh, large cacheable operation | 2 → 1 | 200 → 100 ms |
| Cold backfill | 2 → 2 | 200 → 200 ms |
| Oversized, uncached | 2 → 2 | 200 → 200 ms |

Including the original follower fetch, total requests for 100 fresh empty blocks
fall 200 → 100; nonempty blocks fall 300 → 200. Longer cold controls keep 20,000
requests, a median paired elapsed ratio of 0.984, and unchanged serial request
depth. The initial 100-measurement cold sample took under 1 ms and showed a small
timing difference; longer controls were added rather than treating that sample
as evidence of a speed change.

**Costs and limits:** Cache encoding adds work to followed blocks in every view.
Across the final paired runs, worst fetched-block p95 is 0.577 ms, below the
predeclared 5 ms ceiling. Whole-trace local elapsed ratios are 1.635 for the large
cacheable operation and 1.390 for oversized blocks; no general CPU improvement
is claimed. Peak retained payload string is 1,001,250 bytes by the conservative
two-bytes-per-code-unit accounting; oversized blocks retain none. The cap is per
endpoint client, and does not bound transient allocations or whole-process heap.
Blocks without provenance or whose payload has been evicted use cold backfill.
Real RPC latency, real operation serialization and terminal painting were not
measured; latency figures in the table are request accounting, not elapsed time.

At the time of the cache measurement, all 133 tests passed with coverage,
including identity propagation, endpoint failover, replacements, late responses,
null reads, bounds, serialization errors, cancellation, retries, view changes,
and the existing chart/filter assertions.
The 224-trace metadata replay also passes against the previous accepted runtime.

```sh
mkdir -p /tmp/hivetop-size-original
git archive 0b882ed dist package.json | tar -x -C /tmp/hivetop-size-original
npm run build
node scripts/size-baseline.mjs /tmp/hivetop-size-original /tmp/hivetop-size.json
```

## 5. Remove redundant tests without losing behavior checks

**Baseline:** 122 tests; 89.19% lines, 82.38% branches, and 88.71% functions on the
original runtime. Clock fixes make three batch-transition fixtures deterministic.
Per-test overlap collection found 59 cases with no unique measured coverage.

**Target:** At most 110 distinct cases, preserving covered paths and distinct
assertions. Combining wrappers, skipping rows, or weakening assertions earns no
reduction. Freeze runtime code while making a reduction comparison.

**Result:** 122 → 121 cases by reusing the existing first failover call in the
endpoint-persistence test and retaining its value, order, and active-endpoint
assertions. Native totals and normalized covered identities stayed identical.
Three further omissions preserved execution coverage but lost detection of
faults: dropping the future-schedule parameter, requesting the wrong block, and
leaving the Beacon deadline active. Those tests remain; stop after three rejected
removals. New accepted-runtime regressions bring the current suite to 129.

```sh
npm run test:coverage
npm run coverage:overlap -- --verify
npm run coverage:overlap -- --output /tmp/hivetop-overlap.json
```

Coverage ranks candidates; it does not prove assertion equivalence. Native V8
branch identifiers vary, so the collector also compares normalized source ranges.

## 6. Reject malformed RPC responses before they reach callers

**Not started.** Source inspection on 2026-10-25, at `0b882ed` plus the
uncommitted block-size hill, found no explicit `any` return annotations in
`src/`. The RPC boundary accepts `unknown` JSON, then asserts response envelopes
and results as generic `T` without checking the result shape. Removing casts
alone earns no improvement.

**Score:** Percentage of a fixed malformed-response fixture matrix rejected
at the RPC boundary with a method-specific `HiveRpcError`, before an invalid
value reaches a caller. Report the count and outcome for every fixture and RPC
method, alongside valid-response acceptance. The numerical baseline has not
been measured; record its date and exact runtime commit before changing code.

**Target:** Reject 100% of the fixed malformed fixtures and preserve 100% of
valid controls. Freeze fixtures and expected outcomes before implementation.
Cover null/primitive envelopes, missing results, invalid error objects, wrong
consumed field types, malformed nested arrays, and missing, duplicate, or
mismatched batch IDs. Include valid null blocks, empty arrays, optional fields,
unknown extra fields, and out-of-order batch responses as controls.

Validate the envelope and fields callers actually consume for each supported
RPC method; keep untrusted data as `unknown` until checked. Preserve legitimate
empty/null results, response headers, status strings that allow future values,
method context in errors, cancellation, deadlines, failover, and retry/backoff
behavior. Do not introduce requests, silently substitute defaults, or require a
new runtime dependency. Fix a processing-overhead ceiling before implementation
and measure it with representative large valid responses.

**How to measure:** Add a deterministic response-injection runner using the
existing fetch double. Run the frozen matrix against the unchanged baseline
and each candidate, asserting both rejection location/error and valid returned
values. Exercise malformed responses through the follower and failover paths
to check recovery, then run `npm run test:coverage`. Keep raw reports in ignored
`benchmarks/`; record the fixture counts, scores, command, baseline commit, and
accepted tradeoffs here when the hill is run.

## 7. Make existing tests detect more faults

Borrowed from Hyperion hill #10. Freeze eight independently witnessed faults
before scoring: wrong size endpoint, wrong size block ID, late block overwrite,
reversed retention eviction, batch-response ordering, skipped schedule backoff,
late cancelled schedule acceptance, and dropping visible completed blocks.
Apply each only in a disposable runtime copy; syntax errors, timeouts and
unrelated failures do not count as detections. The independent witness must pass
on the unchanged runtime and fail on its mutant before the suite is scored.

**Score and target:** Halve undetected faults, preserving all prior detections,
covered lines/branches, and normal passing tests. Freeze production and panel
inputs while improving tests. Keep suite count at or below the current 133 and
median uninstrumented suite time within 10% of a fresh control. If every fault
is already detected, record saturation rather than replacing the panel to earn
a gain. Baseline date, source hashes, outcomes, and commands follow below.

**Baseline, 2026-10-25:** `0b882ed` plus the uncommitted block-size hill; exact
runtime/test/panel hashes are in the local report. All eight witnesses pass on
the unchanged runtime, fail with assertion exit 42 on their mutant, and each
mutant passes syntax validation. Three clean controls pass all 133 tests with
wall times 1,285, 1,250 and 1,245 ms (median 1,250 ms).

| Fault | Suite outcome |
| --- | --- |
| Wrong size endpoint | Detected |
| Wrong size block ID | Detected |
| Late block overwrites the latest payload | Timeout; not counted as detection |
| Evict newest retained block | Detected |
| Map batch results by response order instead of ID | Missed; suite passes |
| Skip schedule error backoff | Detected |
| Publish cancelled schedule response | Detected |
| Drop completed visible blocks | Detected |

Detection is **6/8**; the two faults without a counted detection set a target of
at least **7/8**, preserving the six current detections. These are test gaps,
not claims that the unchanged application contains the injected faults. The
late-read mutant leaves a mocked fetch pending; Node's 10-second test timeout
terminates it. Timeout/failure logs remain local and the runner does not treat
them as successful detection. A future test improvement should assert the bad
state before it waits indefinitely. Production code and tests were not edited
in this baseline pass.

```sh
npm run build
node scripts/fault-baseline.mjs benchmarks/fault-baseline.json
```

The driver copies runtime/tests into a temporary directory, links the existing
development dependencies, freezes the panel, and restores/removes the copy in
`finally`. It runs tests directly against each compiled mutant without a build
that would erase it. An initial setup run lacked the terminal test dependency;
a later outer-timeout attempt did not complete the panel. Neither contributes
scores. The completed report and assertion logs provide the baseline above.

**Accepted test improvement, 2026-10-25:** Reverse the response array in the
existing batch-status fixture while preserving its request and returned-status
assertions. The two results have distinct statuses, so associating them by
array position now fails the same test. No test cases or production changes
were added by this pass.

The unchanged frozen panel improves **6/8 → 7/8 detections**; faults without a
counted detection fall **2 → 1**, meeting the halving target. All six original
detections remain. The batch-order mutant now fails specifically in
`HiveRpcClient sends batched transaction status requests`. The late-read mutant
still reaches the 10-second test timeout and does not count as detected. Stop
at the target rather than changing the panel or continuing to tune tests.

Fresh control and candidate both pass **133 tests** in three uninstrumented
runs. Median complete command wall time is **1,266.8 → 1,254.2 ms**, ratio
**0.990**, within the fixed 10% guard; this is not a claim of a reliable speed
improvement. Runtime, panel, witnesses, and mutation hashes are identical.
Only the batch fixture changes among test inputs.

Coverage comparison also runs each complete suite against identical production
source. Both cover **2,746/3,042 lines**, **1,231/1,468 native branch outcomes**,
and **351/389 functions**. No previously covered lines, functions, or normalized
function-scoped V8 segments are lost. Native branch identifiers can vary, so
the comparison uses source-offset partitions as well as reporting native
totals. The maintained coverage collector now supports this cross-check with
`--compare`; its self-check includes detecting a lost source region.

```sh
node scripts/fault-baseline.mjs benchmarks/fault-candidate.json
node scripts/coverage-overlap.mjs --verify
node scripts/coverage-overlap.mjs --compare BASELINE_WORKSPACE --output benchmarks/fault-coverage.json
```

Use the preserved local `sibling-context-2026-10-25` as `BASELINE_WORKSPACE`
for this uncommitted control. Fresh control/candidate fault reports, assertion
logs, coverage comparison, and candidate test/collector snapshots remain in
ignored `benchmarks/`. Broader faults and alternate execution orders were not
measured.

## 8. Keep transaction-status bookkeeping cheap as history grows

Borrowed from Hyperion hill #8. Measure the existing monitor's complete `sync`
path with 100, 1,000 and 10,000 cached transaction IDs distributed across 100
visible blocks. Use settled cache hits and a separate turnover case replacing
ten blocks per sync. Keep the production 300-block retention cap, 500-item
queue cap, and request policy. A fetch double must reject any unexpected RPC.

**Score and target:** Reduce 10,000-ID per-sync p95 by 30%, with no repeatable
100-ID regression above 5%. Fix seven warmed trials of 200 syncs per case.
Check exact status identities, retained blocks, queue state, and eviction after
every turnover; no dropped history or deferred unbounded cleanup. Record
instrumented scan counts separately from timing. Keep sampled heap under
128 MiB and post-GC growth across the last three trials below 4 MiB. This is
monitor bookkeeping, not a replacement for the whole-path window replay guard.

**Baseline, 2026-10-25:** Same `0b882ed` plus block-size working tree and Node
24.16.0. Seven warmed trials per case measure 200 syncs each, with correctness
assertions outside the sync timer. The table reports the median of trial p95s;
all identities, retention, statuses, queue checks, and zero-RPC checks pass.

| Visible transaction IDs | Settled p95 | Turnover p95 |
| --- | ---: | ---: |
| 100 | 0.041 ms | 0.051 ms |
| 1,000 | 0.167 ms | 0.197 ms |
| 10,000 | 0.888 ms | 1.102 ms |

Separate instrumentation at 10,000 IDs counts 10,000 cache membership checks,
10,000 visited cache keys and 200 visited retained values for settled syncs;
turnover counts 12,000 / 11,000 / 220. Timed trials have no scan wrappers.
Completed off-screen blocks disappear on the current sync, while their cache
entries disappear on the next sync; the checks preserve that existing behavior.

**Guard failure:** Largest measured sampled heap is **128.53 MiB** in 10,000-ID
turnover, above the unchanged **128 MiB** ceiling. Settled 10,000-ID peak is
123.28 MiB. All post-GC growth guards pass; the turnover case's final three
post-GC samples are 5.26 / 5.27 / 5.27 MiB. Sampling includes harness fixtures
and assertions; this is not isolated application memory or evidence of a leak.
The runner writes the complete report before exiting nonzero for guard
violations. The initial fail-fast attempt was not used as the full baseline.
No performance improvement or guard pass is claimed from this pass.

```sh
mkdir -p benchmarks
node --expose-gc scripts/cache-baseline.mjs benchmarks/cache-baseline.json
# A nonzero exit records a resource-guard failure; inspect the saved report.
```

## 9. Reach the first useful CLI output sooner

Borrowed from Hyperion hill #9. Start fresh Node subprocesses against controlled
RPC responses and measure launch to the first correct block JSON record and
first dashboard frame containing that block. A connecting frame does not count.
Use explicit-node selection to isolate module/startup cost; measure automatic
Beacon selection separately before making any claim about default startup.

**Score and target:** Reduce startup p95 by 20% without a repeatable first/second
block or dashboard-input regression above 5%, extra requests, or lost output.
Freeze Node version, 160×50 terminal dimensions, fixtures and 10 ms RPC latency;
warm once per mode then measure 21 alternating fresh-process runs per mode.
Include module import cost; report follow and dashboard separately, with process
exit and request counts. Dashboard uses a TTY-capable fixture; real terminal
painting and cold filesystem caches are outside the initial baseline. Keep the
dependency-free runtime and existing cancellation and error behavior.

**Baseline, 2026-10-25:** Same runtime context, Node 24.16.0, warm filesystem
cache. Each mode has one unmeasured warmup and 21 alternating measured fresh
processes. The preload fixture blocks unexpected network calls, supplies 10 ms
RPC bodies, and simulates TTY properties/input for the dashboard. Launch timing
includes Node, preload, module imports, rendering and IPC delivery; it is not
an isolated import benchmark. p95 is the nearest-rank 20th of 21 samples.

| Mode | First useful block p95 | Second block p95 from launch | HTTP calls | Exit |
| --- | ---: | ---: | ---: | --- |
| JSON follow | 74.56 ms | 99.20 ms | 8 | 0 in every run |
| Dashboard | 87.50 ms | 111.86 ms | 12 | 0 in every run |

Dashboard keypress-to-handler-completion p95 is **0.260 ms**, including its
synchronous drawing work. Both modes check block numbers 10,000 and 10,001 and
the expected producer, exactly two block requests, and successful shutdown;
dashboard runs also check terminal restoration. Connecting output never earns
a completion marker. Useful-frame detection inspects emitted ANSI text rather
than an actual terminal screen. Automatic Beacon discovery, cold filesystem
caches, and real terminal painting remain unmeasured. No startup change was
made; the first-output targets are 59.65 ms follow and 70.00 ms dashboard.

```sh
mkdir -p benchmarks
node scripts/startup-baseline.mjs benchmarks/startup-baseline.json
```

The fault, cache, and startup runners write their reports under ignored
`benchmarks/` when invoked as above. To rerun them, use a checkout containing
the block-size cache and run `npm ci` and `npm run build` first. The local
`sibling-context-2026-10-25` snapshot with its SHA-256 manifest preserves the
inputs for the original measurements.

## Renderer remains parked

Prior measurements show little opportunity to combine callbacks in some traces.
Reopen only if representative whole-path measurements show material drawing cost.
Use `scripts/tui-ab.mjs` for exact terminal comparisons, establishing a current
baseline before another renderer change.
