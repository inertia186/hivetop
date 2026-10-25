# Hill-climbing goals

Baseline investigation: 2026-10-24, `4610edf` (v1.10.0), Apple M2 / macOS arm64,
Node 24.16.0. The starting suite had 122 passing tests. Results below were
recorded on 2026-10-25. The current suite has 129 tests after consolidation and
new asynchronous/retention regressions.

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

**Not started.** `getBlockSize` fetches a block that the follower may have just
received, then requests serialized operations for nonempty blocks.

**Score and target:** For newly followed payloads, reduce additional calls from
two to one for nonempty blocks and one to zero for empty blocks. Cold backfill
must not become slower or more expensive. Take the baseline before editing.

Preserve exact serialized bytes, block identity through replacements/endpoints,
chart gaps and peaks, cancellation, one-per-second backfill, and error backoff.
Set a memory ceiling before retaining raw payloads. Test signatures, header
extensions, empty blocks, large transaction counts, serialization failures,
view changes, filtering, replacements, and retries.

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

## Renderer remains parked

Prior measurements show little opportunity to combine callbacks in some traces.
Reopen only if representative whole-path measurements show material drawing cost.
Use `scripts/tui-ab.mjs` for exact terminal comparisons, establishing a current
baseline before another renderer change.
