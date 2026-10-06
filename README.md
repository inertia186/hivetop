# hivetop

`hivetop` is an htop-like terminal monitor for the Hive blockchain.

It follows blocks through Hive JSON-RPC, aggregates recent block/transaction/operation rates, and renders a live terminal dashboard.

## Usage

```bash
npm start
npm start -- --node https://api.hive.blog
npm start -- --start 98765432
npm start -- --window 120 --poll-ms 1000
npm start -- --follow --node https://api.hive.blog --limit 42
```

By default, `hivetop` asks [PeakD Beacon](https://beacon.peakd.com/api/nodes)
for available Hive API nodes. It follows `api.hive.blog` while its Beacon score
is at least `90`; below that threshold, it switches to the highest-scored node
that advertises `get_rc_stats`. During runtime it uses the same Beacon-ordered
node list for basic failover when RPC calls fail. Pass `--node` to pin a
specific endpoint and disable Beacon failover.

Use `--follow` for investigation: it prints one JSON diagnostic record per
block instead of opening the terminal UI. Pair it with `--limit NUM` to stop
after a bounded number of produced block records.

Keyboard controls:

- `q` or `Ctrl-C`: quit
- `p`: pause/resume rendering and block fetching
- `r`: reset the follower to the current head block
- `v`: switch between block and scheduled-round views
- Arrow keys / PageUp / PageDown: scroll recent blocks

## Development

The runtime is dependency-free and checked into `dist/` so it can run without installing packages. TypeScript source lives in `src/`; after installing dependencies, `npm run build` regenerates `dist/`.

```bash
npm test
npm run build
```
