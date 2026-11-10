# @useblacksmith/vitest experiment

Test bed for measuring and validating `@useblacksmith/vitest` (0.4.0) on this fork
(uuid-rocks/t3code). Never push to or open PRs against pingdotgg/t3code, and never
push to the fork's `main`.

## Branches

| branch                | what                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bsv/main`            | PR base for every experiment. `ci.yml` keeps only `changes`, `test`, `test_web`, `test_server` and `check`, and runs on pushes to `bsv/main` so a merge seeds the plugin cache the way a push to `main` would. |
| `bsv/vite-plus-1.5.1` | vite-plus 1.4.0 → 1.5.1 (Vitest 5.1.0), merged as PR #6.                                                                                                                                                       |
| `bsv/plugin`          | Plugin wiring (`vitest-selection.ts`, config imports, CI switches, this file), merged as PR #8.                                                                                                                |
| `bsv/probe-noop`      | Throwaway: README-only change (PR #10, closed).                                                                                                                                                                |
| `bsv/probe-leaf`      | Throwaway: comment appended to `packages/client-runtime/src/delayedStatus.ts` (PR #11, closed).                                                                                                                |

Experiments: branch off `bsv/main`, open a PR with
`gh pr create -R uuid-rocks/t3code --base bsv/main`. `bsv/main` merges PRs with
`gh pr merge -R uuid-rocks/t3code --merge`; each push to it runs CI in the
current mode and saves cache entries under the pushed SHA.

**Cache entries are not scoped by branch.** The plugin restores the newest entry
under a key prefix (`blacksmith-vitest-v5-<root/projects hash>-<shard>-`), and on
Blacksmith that lookup returns entries saved by any run in the repository, other
PRs included. Seen in this repo: the push run on `bsv/main` restored PR #8's
entries, and the no-op PR #10 restored entries the leaf PR #11 had saved a minute
earlier, so it reran `delayedStatus.test.ts`. With several experiment PRs running
at once, each run's baseline is whichever run saved last. The key's last segment
is the head SHA the entry was saved at; check `restored dependency cache …-<sha>`
in the log to see which run a selection was computed against.

## What is wired

- `vitest-selection.ts` (repo root) returns the plugin for the current `BSV_MODE`
  plus a reporter that prints one `BSV_SELECTION` line per vitest invocation.
- The root `vite.config.ts` uses it. `apps/server` inherits the root plugins
  through `mergeConfig`, and every package whose `test` script is
  `vp test run --config ../../vite.config.ts --dir .` uses the root config
  directly. `apps/web`, `apps/desktop`, `apps/mobile` and
  `packages/client-runtime` have their own configs and add it themselves.
- Checked locally: every node project (web unit, mobile unit/react, desktop,
  client-runtime, root-config packages) has the plugin's `record-reads.js` in
  its resolved `setupFiles`. Browser projects (web browser/renders) do not, by
  the plugin's design.

## Switches (top of `.github/workflows/ci.yml`)

```yaml
env:
  BSV_MODE: select # off | select | shadow | all
  BSV_BYPASS_CHANGES: "true"
  BSV_SERVER_TEST_CACHED: "false"
```

| variable                 | values                                                | effect                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BSV_MODE`               | `off` (default when unset), `select`, `shadow`, `all` | `off`: no plugin. `select`: the plugin's `--changed` selection. `shadow`: run everything, log what selection would have run and which failures it would have missed. `all`: `runAllTests`, runs everything but still records and saves the cache (a cache warm-up). |
| `BSV_BYPASS_CHANGES`     | `true` / anything else                                | `true` makes `.github/actions/ci-changes` decide as for a push (`--full`), so every test job and every package runs and only the plugin selects.                                                                                                                    |
| `BSV_SERVER_TEST_CACHED` | `true` / anything else                                | `true` runs `test_server` through `scripts/test-cached.ts` (vite-plus task cache, per-file groups) with `BSV_MODE=off` forced for that step. Otherwise `cd apps/server && vp test run --shard i/8`.                                                                 |

Common combinations:

| measurement                                    | BSV_MODE | BSV_BYPASS_CHANGES | BSV_SERVER_TEST_CACHED |
| ---------------------------------------------- | -------- | ------------------ | ---------------------- |
| upstream behavior (test:cached + changes)      | `off`    | `false`            | `true`                 |
| no selection at all                            | `off`    | `true`             | `false`                |
| plugin alone                                   | `select` | `true`             | `false`                |
| plugin plus changes gating                     | `select` | `false`            | `false`                |
| plugin soundness check (runs all, logs misses) | `shadow` | `true`             | `false`                |

Never combine the plugin with `test:cached`: each per-file group covers only part
of the project, so the plugin never writes its first snapshot, and
`--uncached`/`--verify-hits` bypass only the vite-plus task cache, not the
plugin's selection. The workflow forces `BSV_MODE=off` on that path.

On the fork the vite-plus remote task cache is off (`setup-ci-deps` enables it
only for `pingdotgg/t3code`), so `test:cached` here caches nothing across runners.

## Reading counts and timings

Each vitest invocation prints, and appends to the step summary:

```
BSV_SELECTION root=packages/contracts shard=- mode=select selected=4 total=32
```

- `selected`: test modules that ran in this invocation (after `--shard`).
- `total`: test specifications this invocation owns (the glob, filtered by the
  configured sequencer's `shard()` when sharded).
- Both count specifications, i.e. file × project: `apps/web` and `apps/mobile`
  have several projects, and a file in two projects counts twice.
- `selected=0` is the success case for a no-op change.

Each test step ends with one line that sums its `BSV_SELECTION` lines:

```
BSV_JOB label="test_server 3/8" mode=select server_test_cached=false vitest_runs=1 selected=0 total=61 step_seconds=21
```

`step_seconds` is the wall time of the Test step's shell. `BSV_JOB` with
`vitest_runs=0` means no vitest ran through the reporter. That happens under
`test:cached`, where the reporter is off because that script reports its own
counts.

Plugin lines start with `[blacksmith]`. Grep a run:

```sh
gh run view <run-id> -R uuid-rocks/t3code --log | grep -E 'BSV_(JOB|SELECTION)|\[blacksmith\]'
bsv/job-times.sh <run-id>   # job wall time and Test step time per job
```

Cache lines to expect: `restored dependency cache blacksmith-vitest-…`,
`no dependency cache: no entry under …`, `saved dependency cache … (N bytes)`,
`dependency cache not saved: … already exists or was refused` (a key is the
commit SHA, so a rerun of the same commit does not overwrite). In shadow mode:
`shadow: would have run X of Y test files (…)`.

## Local workflow

Selection works locally without the Actions cache. With `ACTIONS_RESULTS_URL`
unset the plugin only skips the restore/save; the record and anchor live in
Vitest's cache directory and the next local run compares the working tree
against them, committed or not.

Per package (cwd = the package):

```sh
cd packages/client-runtime && BSV_MODE=select vp test run
cd apps/server && BSV_MODE=select vp test run            # long: files run one at a time
cd apps/web && BSV_MODE=select vp test run --project unit --project browser
cd apps/mobile && BSV_MODE=select vp test run --project unit --project react
cd apps/desktop && BSV_MODE=select vp test run
cd packages/contracts && BSV_MODE=select vp test run --config ../../vite.config.ts --dir .
```

`vp run --filter <package> test` from the repo root runs the same command as CI
and passes `BSV_MODE` and `ACTIONS_RESULTS_URL` through to vitest.

From the repo root, the root config routes to package projects
(`vp test list --filesOnly` shows them: `t3`, `@t3tools/web (unit)`,
`@t3tools/client-runtime`, `root`, …):

```sh
BSV_MODE=select vp test run --project @t3tools/client-runtime
```

A repo-root run is a different config root from a per-package run, so it keeps
its own record (see below). The first run of each records; selection starts on
the second.

Where the record lives: `<config root>/node_modules/.vite/vitest/<hash>/`
holds `dependencies.json` (Vitest's per-test dependency record) and
`blacksmith.json` (the plugin's anchor: file hashes, head, shard, projects).
A run narrowed with `--project` writes `blacksmith.<12-hex>.json` instead.
Examples: `packages/contracts/node_modules/.vite/vitest/da39a3…/blacksmith.json`,
`node_modules/.vite/vitest/da39a3…/blacksmith.d2b0e6416c4b.json` for a root run
with `--project @t3tools/client-runtime`.

Reset:

```sh
rm -rf <config root>/node_modules/.vite/vitest            # one package
find . -path ./node_modules/.pnpm -prune -o -type d -path '*/node_modules/.vite/vitest' -print -exec rm -rf {} +   # all
```

Deleting only `blacksmith*.json` also forces the next run to run everything. When
mutating `package.json` or the lockfile between local runs, delete
`node_modules/.vite/vitest` as well. A stale transform cache can serve old
modules.

Example local session (packages/contracts):

```
$ BSV_MODE=select vp test run --config ../../vite.config.ts --dir .
[blacksmith] no dependency snapshot, running every test of the unsharded run
BSV_SELECTION root=packages/contracts shard=- mode=select selected=32 total=32
$ BSV_MODE=select vp test run --config ../../vite.config.ts --dir .
[blacksmith] 0 files changed since 3007c5a01e44, 0 test files not covered by it
BSV_SELECTION root=packages/contracts shard=- mode=select selected=0 total=32
$ echo '// probe' >> src/acpRegistry.ts && BSV_MODE=select vp test run --config ../../vite.config.ts --dir .
[blacksmith] 1 files changed since 3007c5a01e44, 0 test files not covered by it
BSV_SELECTION root=packages/contracts shard=- mode=select selected=4 total=32
```

`shadow` locally prints `shadow: nothing to compare against (ACTIONS_RESULTS_URL
is not set)`: shadow compares only against the Actions cache, not the local
record.

## Gotchas

- **A failing run writes no snapshot.** The plugin records only when the run
  passes. Locally on Node 22 (`engines` asks for 26.12.1), two `apps/web` unit
  files fail with or without the plugin (`chatRouteCommands.test.ts`,
  `pcmWorklet.test.ts`), so web selection never starts locally until they pass.
  Use Node 26 or `--project`/exclusions.
- **Partial runs write no snapshot.** A file filter (`vp test run src/x.test.ts`)
  or `-t` covers less than the project, so the anchor does not advance.
- **One local record per config root, not per shard.** Running `--shard 2/3`
  after an unsharded run reruns everything (`dependency snapshot is for unsharded
  run`), and the shard run replaces the record. CI keys the cache per shard.
- **apps/server sharding.** `WeightedShardSequencer` balances by recorded weight;
  the plugin wraps it to keep assignments independent of the selection, but adding
  a test file or changing `shardWeights.json` can move files between shards, and
  a moved file reruns.
- **Any lockfile change reruns everything** (`pnpm-lock.yaml changed, running
  every test`). So does a change to a config file or its imports
  (`vitest-selection.ts`, `vite.config.ts`, `scripts/lib/*` imported by configs).
- **Inputs the plugin cannot see:** files read by child processes (e.g.
  `apps/server/src/cliCompileCache.test.ts` runs the CLI in a subprocess),
  gitignored files (`.env*`, generated files, `node_modules`), and env vars.
  Declare file inputs with the plugin's `dependencies` option in
  `vitest-selection.ts`. Reviews in `/tmp/bsv-reviews/` list the candidates.
- **apps/mobile is CommonJS.** Vite bundles its config to CJS, and interop wraps
  the ESM-only plugin's default export a second time (`default is not a
  function`). `vitest-selection.ts` unwraps it.
- **Browser projects always rerun.** Vitest records no dependencies for browser
  tests, so the plugin treats them as uncovered: every select run logs
  `193 test files not covered by it` for `apps/web` and runs all 193
  browser/renders files (Test Web ≈ 50 s of its ≈ 55 s Test step).
- **Transfer budget artifact.** `check` requires the `thread-transfer-results`
  artifact only when the transfer test is guaranteed to run (`BSV_MODE` is not
  `select`, or `test:cached` is on).
- **`[skip ci]`** in a commit message suppresses push and PR runs for that head.

## Reference runs

Test step seconds (job seconds). All jobs ran in every run.

| run                                                                          | what                                                             | Test      | Test Web | Test Server 1–8   | run wall |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------- | -------- | ----------------- | -------- |
| [42895681295](https://github.com/uuid-rocks/t3code/actions/runs/42895681295) | PR #6: vite-plus 1.5.1, no plugin, test:cached + changes         | 125 (161) | 87 (125) | 105–145 (153–190) | 217      |
| [42897551222](https://github.com/uuid-rocks/t3code/actions/runs/42897551222) | PR #8: shadow, empty cache (records everything; cold-cache cost) | 102 (134) | 80 (106) | 58–123 (87–151)   | 176      |
| [42898138694](https://github.com/uuid-rocks/t3code/actions/runs/42898138694) | PR #8: select, cache from the shadow run                         | 11 (42)   | 58 (85)  | 1–2 (28–30)       | 126      |
| [42898763432](https://github.com/uuid-rocks/t3code/actions/runs/42898763432) | push to `bsv/main` after merging #8: select                      | 14 (68)   | 54 (80)  | 2 (27–37)         | 123      |
| [42899706908](https://github.com/uuid-rocks/t3code/actions/runs/42899706908) | PR #10 no-op README change: select                               | 11 (49)   | 47 (73)  | 1–2 (27–32)       | 115      |
| [42899712142](https://github.com/uuid-rocks/t3code/actions/runs/42899712142) | PR #11 leaf change: select                                       | 11 (41)   | 52 (79)  | 1–2 (26–32)       | 121      |

The shadow run is the cold-cache measurement: no entry existed, every test ran
with dependency recording on, and it saved the first entries. The first select
run on `bsv/main` was not cold, because it restored PR #8's entries (see above).
Selection: no-op PR selected 0 of 983 in Test (plus 1 from the leaf PR's entry),
0 in every server shard, 193 of 541 in Test Web; leaf PR selected exactly
`src/delayedStatus.test.ts` (client-runtime 1 of 156), 0 in every server shard.
