# opus5 validation: mutation false negatives and server shard moves

Measures @useblacksmith/vitest 0.4.0 on this commit. Results are in `results/` (`report.md` is the summary).

- Part A (`part-a-mutations.mjs`): one mutation per picked file in apps/web (unit + browser),
  packages/client-runtime, packages/shared and packages/contracts. For each project that can import the
  file it runs select mode from the seeded record, then `BSV_MODE=all` as ground truth. A false negative
  is a test file that fails under `all` and did not run under `select`.
- Part B (`part-b-shards.mjs`): apps/server with `--shard i/8`, each shard restoring its own seeded
  record (the plugin's local cacheDir is shared by every shard of a checkout). Phases: seed, no-op
  control, one new test file, one changed weight in `src/testUtils/shardWeights.json`, plus a simulation
  of both sequencers over the file list.

Run order: `node bsv/v-opus5/part-a-mutations.mjs seed|pick|run|verify`, `node bsv/v-opus5/part-b-shards.mjs`
(in a separate worktree, since it edits files under apps/server), then `node bsv/v-opus5/report.mjs`.
Use Node 26.12.1: on Node 22 two web unit files and `packages/shared/src/nodeSqliteClient.test.ts` fail
every run, so no snapshot is ever written. Logs and seeded records go to `$BSV_O5_LOGS` (default `~/.cache/agent-tmp/opus5/logs`). Set `TMPDIR`
outside `/tmp` first: on the shared VM `/tmp` is RAM-backed and Chromium keeps its shared memory there.

Host notes (Arch Linux ARM, no system Chromium libraries): `lib.mjs` points `LD_LIBRARY_PATH` and
`FONTCONFIG_FILE` at `~/.cache/agent-tmp/opus5/chromium-libs`, which holds the shared libraries, NSS modules and fonts
copied out of `mcr.microsoft.com/playwright:v1.60.0-noble`. Without the fonts, layout-dependent browser
tests fail; without `libsoftokn3`/`libfreeblpriv3`, Chromium aborts in NSS init mid-run.
