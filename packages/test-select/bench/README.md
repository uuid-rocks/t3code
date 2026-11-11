# test-select bench

The evaluation harness of DESIGN.md §14. It judges a selector on a seed's cases against an oracle that shares no code or data with the selector: Vitest results from an oracle reporter, V8 coverage (`NODE_V8_COVERAGE` in Node, CDP in the browser), `strace -f`, a preload in every Node process, git, and the TypeScript compiler API.

## Running it

```sh
export TMPDIR=$HOME/.cache/agent-tmp/bench; mkdir -p "$TMPDIR"
export PATH=$HOME/.local/share/mise/installs/node/26.12.1/bin:$PATH
node packages/test-select/bench/run.ts --seed 7 \
  --selector "node packages/test-select/bench/selectors/stub.ts all"
```

| Option           | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `--seed N`       | Case generation seed (required).                                                                              |
| `--selector CMD` | Selector command line (see below). Relative paths that exist in this checkout resolve against it.             |
| `--base REV`     | Base commit, default `DEFAULT_BASE` (`lib/env.ts`). Units that fail or flake at base are excluded and listed. |
| `--minimum N`    | At least N cases per run, no-op included (default 40).                                                        |
| `--limit N`      | Keep N generated cases, one per category in turn (validation and smoke runs).                                 |
| `--packages a,b` | Restrict the test universe to these package dirs (iteration runs; the report says so).                        |
| `--label NAME`   | Write `results/<seed>-<NAME>.json\|md` instead of `results/<seed>.json\|md`.                                  |
| `--list-cases`   | Print the cases after the base runs and exit.                                                                 |

The base is pinned to a commit without selector code, and the selector runs from this checkout, so selector commits reuse cached baselines, ground truth and stores of unchanged selector code. Move `DEFAULT_BASE` when the tree under test itself has to change, for example when t3code's configs load the selector.

Requirements: `strace` on `PATH`, Node 26.12.1 (and 24.21.0, 22.23.4 for the Node-version cases) under mise, pnpm, and, on hosts without Chromium's libraries, `setup-browser-libs.sh`. `TMPDIR` must not be under `/tmp`.

The harness runs one Vitest process at a time with `--maxWorkers=6`, in one scratch worktree at `~/.cache/agent-tmp/test-select-bench/wt`. The path is fixed because the web browser project hashes it into a port. The worktree is removed when the run ends, and on SIGINT/SIGTERM after its child is stopped. Logs go to `~/.cache/agent-tmp/test-select-bench/logs/<run>/` and are removed when every case completed without an error.

## Selector interface

A selector is a command. The harness appends a subcommand and flags, runs it with the case's environment (env vars, Node on `PATH`) and the scratch worktree as cwd, and requires exit 0.

```sh
<cmd> record --repo DIR --base SHA --store DIR
<cmd> select --repo DIR --base SHA --store DIR --out FILE
```

- `record` runs once per (selector command, base) in the base state. It may write anything under `--store`, for example the records of a passing run. The store is cached in `~/.cache/test-select-bench/stores/`.
- `select` runs per case in the head state: head committed in `--repo` on top of `--base`, git-ignored files written, env and Node applied. It gets a fresh copy of the store and writes `--out`:

```json
{
  "all": false,
  "selected": [{ "project": "apps/web#browser", "file": "apps/web/src/a.browser.test.tsx" }],
  "reasons": { "apps/web#browser|apps/web/src/a.browser.test.tsx": "imports src/a.tsx" }
}
```

A unit is one test file in one Vitest project. `project` is `<package dir>` for single-project packages and `<package dir>#<project name>` otherwise (`apps/web#unit`, `apps/web#browser`, `apps/mobile#unit`, `apps/mobile#react`); `file` is repo-relative. `all: true` selects every unit at head. `reasons`, keyed `project|file`, is optional; the report shows it for over-selected units.

`selectors/stub.ts` implements the interface with `all` (select everything) and `none` (select nothing).

## Cases

`generateCases` (`lib/cases.ts`) turns a seed into at least `--minimum` cases:

- one mutation per test project: a covered source location (most), a location in one of its test files, or a location no unit executed at base (expected Standing). Locations are runtime tokens of files the project's units executed in the base instrumented run, sampled by executed length. Operators are those of §14.4; a mutant must parse and change runtime tokens;
- one case per non-code row of §14.4: fixtures and data, child-process files, config, `include` patterns, `package.json`, tsconfig, lockfile, env vars, `.env` files, Node version, git-ignored inputs, comment/whitespace/type-only edits, resolution edge cases, Tailwind, selector self-change;
- more mutations, round-robin over projects, until the minimum;
- the no-op case (head = base), which defines Standing.

Every `regressions/*.json` file is added to every run. Its schema is `Case` in `lib/schema.ts`: `edits` become the head commit, `ignored` are git-ignored files written after it, `env.set`/`env.unset` and `node` change the head environment, and `install` reruns `pnpm install`. A miss found by any round belongs here.

## Oracle

Per base (cached under `~/.cache/test-select-bench/base/<tree>-<env>/<package>/`, keyed by the base tree without `bench/`, `research/` and `DESIGN.md`, and by the job environment):

- two uninstrumented runs of every package's test script (`run1`, `run2`). Units whose outcome differs between them are flaky; units not passing in both are failing at base. Both are excluded from every check;
- two instrumented runs (`trace1`, `trace2`). Each records, per unit, the executed source ranges of every repo module (V8 block coverage mapped through Vite's inline source maps, or file offsets for modules Node loaded itself), the repo paths its worker and child processes opened, stat'd, exec'd, probed or listed (`strace -f`), the env names its Node processes read, and a comment-free hash of each module's transformed code. Per project, it records the Vitest main process's reads and env before the first worker starts (config load) and after. Browser units get CDP coverage from `oracle/browser-setup.ts`, added through `oracle/web-config.ts` with `fileParallelism: false`.

Per case (cached under `~/.cache/test-select-bench/truth/<case key>/`, keyed by case id, head tree, environment, Node and universe):

- **Ground truth (§14.2).** The full head run of every package, exactly as the package script runs it. A unit is a candidate when its outcome (file state, per-test states, whether errors exist) differs from base, or it is new at head and does not pass. A run-level error with no file is bisected over the package's units. Each candidate is rerun twice; it is Changed when both reruns also differ from base, and case-flaky otherwise.
- **Misses** = Changed \ Selected.
- **Evidence (§14.3)** for each selected unit, first match wins: E0 Changed; E4 Node version, membership, or the project's serialized config (per-run keys removed); E2 a non-module input read at config load, or a changed path or listing the unit's processes touched; E3 a changed env var the unit's Node processes or the config load read; E1 an executed range of the unit intersecting a changed runtime range. E1–E3 are checked on both base instrumented runs with base-side ranges. A unit with no base evidence gets a head instrumented run when the main process read a changed non-module input after config load (scripts too in projects that load CSS, for Tailwind); that run adds head-side E1–E3, E2 for a module whose transformed code or resolved id changed, and E5 for a different executed-file or path set beyond the variation between the two base runs.
- **Extras** = selected units with no evidence. **Over** = extras \ Standing.
- **Soft recall** = units with evidence that were not selected and did not change outcome, for review.

Changed runtime ranges (`lib/tokens.ts`) come from TypeScript-parsed token streams with comments (pragmas kept) and type-only syntax dropped, diffed with Myers' algorithm. A pure insertion or deletion maps to the innermost enclosing block on the side where it has no tokens.

## Where this differs from §14

- Reruns of candidates run the candidate files of the project, not the whole project.
- E1–E3 come from the base instrumented runs, with head instrumented runs only for the units described above. A unit that executed and read nothing that changed at base runs the same code on the same inputs at head. Soft recall uses the same base evidence for every case, not head runs of all units.
- Env reads come from a `process.env` proxy in Node processes, not `--trace-env`. Reads by non-Node children and native `getenv` are not observed.
- Not yet generated: the real upstream commits row and lockfile cases that need a different package version (`install` is supported for regression cases).

## Results

`results/<seed>.json` holds every case: Changed, misses, extras with the selector's reasons, Over, the evidence for each selected unit, unverified units (no observation), soft recall, selection seconds and test-seconds. `results/<seed>.md` summarizes them by case, category and project.

## Cost

On the bench host (18 cores, `--maxWorkers=6`), one uninstrumented full run takes about 17 minutes (server 11.5), and an instrumented one about 2.5 times that. A new base costs two of each. A new case costs one full run plus reruns of its candidates; cases and base runs are cached, so a new selector version on old cases costs only its `select` calls and the head instrumented runs of its new selections.
