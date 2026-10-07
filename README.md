# hivetop

![hivetop logo](logo.png)

[![Tests](https://github.com/inertia186/hivetop/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/inertia186/hivetop/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/hivetop.svg)](https://www.npmjs.com/package/hivetop)
[![CC0-1.0](https://img.shields.io/badge/license-CC0--1.0-lightgrey.svg)](LICENSE)

`hivetop` is an htop-like terminal monitor for the Hive blockchain.

It follows blocks through Hive JSON-RPC, aggregates recent block/transaction/operation rates, and renders a live terminal dashboard.

For screenshots and discussion, see the
[launch post on PeakD](https://peakd.com/hive-139531/@inertia/hivetop--a-cli-hive-monitor).

## Installation

Requires **Node 24 or newer**. With nvm, run `nvm install 24`.

Install the command from [npm](https://www.npmjs.com/package/hivetop):

```bash
npm install --global hivetop
hivetop
```

Or run it without a global install:

```bash
npx hivetop
```

## Usage

Run `hivetop --help` for command-line options.
Run `hivetop` from any directory. Examples:

```bash
hivetop --view round
hivetop --view sizes
hivetop --view txstatus --compact --ascii
hivetop --node https://api.hive.blog
hivetop --start 98765432
hivetop --window 120 --poll-ms 1000
hivetop --follow --node https://api.hive.blog --limit 42
NO_COLOR=1 hivetop
```

The four views are blocks, the witness schedule (`round`), transaction
status (`txstatus`, the defrag view), and block-size history (`sizes`).
`--view` chooses the starting view.
The witness view previews the announced next round and marks the current round
with `>`, its block range, and progress. Its live position keeps the latest
produced block visible alongside predictions.

The `sizes` view plots uncompressed serialized block bytes over the rolling
`--window` (120 seconds by default), oldest on the left and newest on the right.
It shows the latest measured size, mean, minimum, and peak. The vertical scale
adapts to the peak in the window; axes use KiB (1024 bytes) and UTC time.
Blocks sharing a chart column use their peak size. Empty or unmeasured slots
stay blank. `--ascii` uses `#` for the filled chart.
Light bar faces and darker right edges give each block a shadow, including
adjacent blocks of equal size. `--no-color` keeps the chart monochrome.

Size measurements run in the background only while this view is visible.
Each block needs an extra block fetch and one `get_transaction_hex` call;
operations are serialized together, with the original transaction headers,
signatures, signed block header, and transaction count included in the total.
Backfilling is limited to at most one measurement per second.
The measured/total block count shows progress while recent history fills in.
Failures appear in the view and event history, retry after 30 seconds, and
leave block tracking running. Measured sizes remain available in block details.

`--compact` hides the sidebar and reduces the number of columns. Narrow terminals
adapt automatically. `--ascii` replaces graphical status cells with distinct
letters. `--no-color` or a nonempty `NO_COLOR` disables colors and also uses
status letters, so the transaction map remains readable.

By default, `hivetop` asks [PeakD Beacon](https://beacon.peakd.com/api/nodes)
for available Hive API nodes. It follows `api.hive.blog` while its Beacon score
is at least `90`; below that threshold, it switches to the highest-scored node
that advertises `get_rc_stats`. During runtime it uses the same Beacon-ordered
node list for basic failover when RPC calls fail. Pass `--node` to pin a
specific endpoint and disable Beacon failover.

Each RPC request, including its response body, has a 10-second deadline;
override it with `--rpc-timeout-ms MS`. The header shows the age of the latest
received block and the most recent RPC response time. `STALE` means the node's
head or the last data update is over 15 seconds old; `RECONNECTING` means the
block RPC failed and is being retried. Cached rates describe the last received
block window. While catching up, the block age refers to the followed block.

RC stats, hardfork info, and witness ranks refresh independently of block
tracking. Failed metadata requests retain last-known values, display an
unavailable/stale notice, and retry after 30 seconds. The schedule is fetched
with the block context; if unavailable, blocks still advance and the last-known
schedule remains subject to its normal prediction expiry.

The dashboard uses the terminal's alternate screen and restores the cursor and
normal input mode when you quit, press Ctrl-C, or send SIGTERM. Redirected output
requires `--follow`.

Use `--follow` for investigation: it prints one JSON diagnostic record per
block instead of opening the terminal UI. Pair it with `--limit NUM` to stop
after a bounded number of produced block records.

JSON diagnostics use the same accepted schedule, absolute slot, and shuffle
boundary logic as the display. `future_block` and `future_scheduled` identify
the first predicted block in the next round. `reported_schedule_sig` and
`reported_next_shuffle_block_num` preserve what the node reported when it differs
from the accepted schedule. `--limit` counts produced blocks and terminal gaps;
an unavailable block is skipped after three retries in diagnostic mode.

Keyboard controls:

- `q` or `Ctrl-C`: quit
- `p`: pause/resume rendering and block fetching
- `r`: reset the follower to the current head block
- `v`: cycle blocks, witness round, transaction status, and block sizes
- Arrow keys / `j` / `k`: select a row (`*` marks the selection)
- PageUp / PageDown: move by a page; Home / `g`: return to live rows
- Enter: inspect the selected produced block, its transactions, and operation counts
- `/`: filter by witness name; Enter applies the filter
- `?`: help and legends
- `e`: scrollable event history, newest first
- Esc: close help/details/history, cancel input, or clear the witness filter

Block details use data already received from the node. Future blocks become
inspectable after production. The local event history retains the latest 100
entries for this session: missed blocks, node changes, connection states, RPC
errors, metadata failures, and schedule discrepancies. It is not written to disk.

ASCII transaction legend: `*` checking, `I` irreversible, `R` reversible,
`.` pending, `?` unknown, `M` mempool, `E` expired, `T` old, `!` block mismatch.
Stretched cells share one transaction's status. In the witness view, `√` (ASCII
`+`) means the expected witness produced, `x` means a miss backed by chain
evidence, and `?` means the schedule is unverified.
The VERSION cell is highlighted yellow when it differs from the majority
witness version. The FEED cell is highlighted yellow after 6 hours and red
at 24 hours, so the reason for a witness's different appearance is visible.

## Troubleshooting

### The `hivetop` command is not found

With nvm, global commands belong to the selected Node installation. Run
`nvm use 24`, then `npm install --global hivetop`. For a local checkout, run
`npm link` from the repository instead.

### Colors or status cells look wrong

Try `hivetop --ascii --no-color`. For cramped layouts, add `--compact`.
When reporting display problems, include your terminal app, font, and a
screenshot, since rendering can differ between terminals.

### The dashboard shows `STALE` or `RECONNECTING`

Press `e` to inspect recent RPC errors and node changes. Automatic node
selection retries requests and fails over when needed; an explicit `--node`
pins the endpoint. Restart without `--node` to restore automatic selection.

For a short diagnostic capture:

```bash
hivetop --follow --limit 5
```

## Development

The runtime is dependency-free and checked into `dist/` so it can run without installing packages. TypeScript source lives in `src/`; after installing dependencies, `npm run build` regenerates `dist/`.

To install the command from this checkout:

```bash
nvm use
npm ci
npm link
```

The command links to this checkout, so pulling updates also updates the command.
With nvm, the link belongs to the selected Node installation; use `nvm use 24`
in new shells if needed. `npm start` also runs the app directly from the checkout.

```bash
npm test
npm run build
```

GitHub Actions runs the tests on Node 24 and verifies that rebuilding does not
change the checked-in `dist/` files. Run `npm ci` after cloning to install the
development tools. Runtime dependencies are provided by Node itself.

## Contributing

Bug reports, feature requests, and pull requests are welcome on
[GitHub](https://github.com/inertia186/hivetop). When
[opening an issue](https://github.com/inertia186/hivetop/issues), include the
command you ran, your Node version (`node --version`), and steps to reproduce
the problem.

Before submitting a pull request, run `npm test`. It rebuilds `dist/` before
running the tests; include any regenerated runtime files with source changes.

## Publishing

From this repository with Node 24 or newer:

```bash
npm ci
npm login
npm publish --access public
```

Publishing builds the runtime and runs the tests first. The package includes
only `dist/`, `package.json`, this README, the logo, and the license. Use
`npm pack --dry-run` to review the file list before publishing.

## Get in touch!

If you're using hivetop, I'd love to hear from you. Drop me a line and tell me
what you think! I'm [@inertia](https://hive.blog/@inertia) on Hive.

## License

I don't believe in intellectual "property". If you do, consider hivetop as
licensed under [Creative Commons CC0 1.0 Universal](LICENSE).
