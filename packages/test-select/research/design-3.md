# Design 3: hybrid selection with proof

Angle: a runtime record from a passing run is the proof that a test file is unaffected; a static declaration graph supplies candidates, covers the channels a runtime record cannot observe, and tells coverage which code a change touched; every input a test can observe is listed with a rule; CI runs a plan job that decides, per job and shard, whether anything runs.

Inputs: `research/plugin.md`, `research/ripple.md`, `research/t3code.md`, and the findings report (`/home/jh/src/artifacts/useblacksmith-vitest-findings.md`). Section numbers like "F2" refer to the report's issue numbers; "Fl" means its low-priority list.

## 1. Definitions

- **Test**: one test file in one Vitest project, run under one runtime identity. Vitest's unit of scheduling is the file, so selection is per file; all cases in a selected file run.
- **Project key**: repo-relative config file path plus project name (`apps/web/vite.config.ts#browser`). A test belongs to the project whose resolved `include`/`exclude` match it.
- **Runtime identity `R`**: a hash of `process.version`, `process.platform`, `process.arch`, libc family, the installed Vitest and vite-plus versions, the test-select package version plus its record schema version, and, for browser projects, the Playwright provider version and the browser executable's version string.
- **Input**: anything whose value the test's execution observed. Section 4 lists every kind with its rule.
- **Identity** of an input: a value that is equal exactly when the observed value is equal (content id of a file, value hash of an env var, `absent`, the name list a `readdir` returned, ...). Section 5 defines each.
- **Record** `Rec(T, R)`: the set of (input, identity) pairs observed by one passing run of `T` under `R`, plus duration and, optionally, coverage summaries. A record exists only if the whole invocation that produced it exited 0 (section 10).
- **Proof of non-affectedness**: a record `Rec(T, R)` whose every input has the same identity now, under the same `R`, and which is marked complete (no unobservable channel was used during the run).

### What "affected" means

`T` is **affected** by the current state `S` (working tree or CI head commit plus the job's environment) exactly when there is no proof for `T` under the `R` it will run with. Equivalently, `T` is selected when any of these holds:

1. `T` has no usable record for `R` (new file, never passed under `R`, last result failed, record incomplete or unreadable);
2. some recorded input's identity differs between the record and `S`, and coverage pruning (section 6.4) cannot show that the difference lies entirely in code `T` did not execute;
3. a static union term (section 6.3) adds `T` for a channel the record could not observe;
4. `T` is listed in `always` (section 8.6).

The soundness argument for skipping: a test is a deterministic program of the values it observes. If every observation the passing run made has the same value now, the execution takes the same path, makes the same observations in the same order, and produces the same outcome. Observations it did not make cannot influence it. This holds under three assumptions, and each place where an assumption fails is handled by a rule, not ignored:

- **Completeness**: every channel through which the test, its worker, its child processes and the Vite main process feed it data is recorded. Channels that cannot be recorded mark the test opaque (always runs) or are covered by a static union term.
- **Determinism**: the outcome does not depend on wall-clock time, randomness, scheduling, or external services. External network access marks the test opaque (section 4, row 18). Time and randomness are not modeled: a test whose outcome depends on them is flaky under any selector.
- **Isolation**: no state passes between test files. True in t3code (no `isolate: false` anywhere). A project with `isolate: false` is selected as a unit: any affected test runs the whole project (section 7.5).

Static analysis never removes a test by itself. It can only add tests (union terms) or narrow the meaning of a recorded difference (coverage pruning, which still requires the runtime record). The reason: static analysis misses computed paths, computed member access, reads by packages and aliased writes (`ripple.md` §11, §15), so it is not a proof.

## 2. Architecture

```text
                    ┌──────────────── CI plan job (no install) ───────────────┐
 git (base, head) → │ store restore (exact keys) → identities of recorded     │
 records store    → │ inputs at head → static facts for changed blobs →        │
 workflow files   → │ verdict per test: skip | run | verify → job matrix       │
                    └───────────────────────────┬──────────────────────────────┘
                                                │ per job / shard: file list + verify list
                    ┌───────────────────────────▼──────────────────────────────┐
                    │ test job: checkout, install, `test-select run -- vp test` │
                    │  1. re-evaluate `verify` tests with the full workspace    │
                    │     (ignored files, packages on disk, exact env, R)       │
                    │  2. transform proof for config-only differences           │
                    │  3. spawn Vitest with the final file list (or exit 0      │
                    │     without starting Vitest when empty and include valid) │
                    │  4. recorders stage observations; reporter stages results │
                    │  5. on exit 0 only: re-verify identities, commit records  │
                    └───────────────────────────┬──────────────────────────────┘
                                                │ trusted pushes only
                    ┌───────────────────────────▼──────────────────────────────┐
                    │ collect job: merge job stores onto parent's store,        │
                    │ save `test-select-v1-<sha>`                               │
                    └──────────────────────────────────────────────────────────┘
```

Components of `packages/test-select`:

| Component | Runs in | Job |
| --- | --- | --- |
| `test-select plan` | CI plan job; also locally for `--dry-run` | Restores the store, computes identities at the head commit from git objects, runs the static analyzer on changed blobs, emits verdicts and the job matrix |
| `test-select run -- <cmd>` | test jobs, local shells | Exact selection with the full workspace, spawns the Vitest command with a file list, owns the commit decision |
| `test-select/vitest` plugin | Vite/Vitest main process | Inert unless `TEST_SELECT_RUN_DIR` is set. Turns on `experimental.recordDependencies`, prepends the worker recorder to node projects' `setupFiles`, adds the browser recorder and its server command to browser projects, adds the staging reporter, records the resolved project config. Changes nothing else: no `passWithNoTests`, no sequencer, no `changed`, no `vcsProvider` |
| worker recorder | Vitest node workers (forks, threads, vm pools) | Wraps `fs`, `process.env`, `child_process`, `worker_threads.Worker`, `node:sqlite`, `process.dlopen`, `net`/`fetch`, `Function.prototype.toString`; optional V8 function coverage; writes one observation file per test file |
| child recorder | Node child processes spawned by tests | Loaded with `NODE_OPTIONS=--import=<child-recorder>`; `module.registerHooks` resolve/load, the same `fs`/env wrappers; writes to a per-test side directory |
| main recorder | the Vitest main process | Loaded with `--import` by `test-select run`; records config-time and `globalSetup` `fs`/env reads per project |
| browser recorder | the tester iframe of each browser test file | Collects the iframe's resource list and sends it to a server command that maps URLs to modules |
| static analyzer | plan job and `run` | oxc-parser facts per blob id: runtime imports with per-tsconfig elision, path strings, computed paths, `import.meta.glob` calls, `vi.mock` specifiers, function body spans and runtime-token hashes |
| store | Actions cache (CI), `node_modules/.cache/test-select` (local) | Records per (project, test, R), static facts per blob id, negative markers |

The recorders have no dependencies (Node built-ins only), so they add nothing to the module graph they observe and load fast in every worker and child. The CLI and analyzer use Effect Schema to parse the store, observation files and workflow YAML; anything that fails to parse is treated as absent (section 10).

## 3. What is recorded or analyzed, and when

| When | What | Where it goes |
| --- | --- | --- |
| Worker, while a test file runs | Module ids Vitest evaluated for the file (Vitest's own `recordDependencies` set, which includes setup files and the closure of modules prepared before the first file); every `fs` read with path and stat at read time; env reads; spawns, worker threads, native openers, addon loads, network connects, `toString` on functions; optionally function coverage | `<runDir>/obs/<project>/<testHash>.<pid>.json`, written in an `afterAll` the recorder registers at the top of the setup file, and finalized by a process `exit` hook for anything later |
| Child process, during its life | Modules resolved and loaded (via `registerHooks`), `fs` reads, env reads, its own spawns; a start marker is written before user code runs and an end marker at exit | `<runDir>/obs/<project>/<testHash>/children/<pid>.json` |
| Main process, config load and `globalSetup` | JS-side `fs` and env reads while the project's config evaluates and while `globalSetup` runs; Vite's `configFileDependencies`; env files Vite loaded (existence checked whether or not git ignores them); the resolved, serialized project config (Vitest's `serializedConfig` plus each plugin's name and the package or file that provided it) | `<runDir>/projects/<project>.json` |
| Main process, transform | Per transformed module: the tsconfig chain Vite used, the hash of the transformed code, `import.meta.glob` calls with their match lists | `<runDir>/modules.json` |
| Browser iframe, end of file | `performance.getEntriesByType('resource')` names (buffer raised with `setResourceTimingBufferSize` at setup start); server commands (`readFile`, ...) the file called, recorded on the server side with the command context's test path | merged into the test's observation file by the server command handler |
| Reporter, end of run | Per test module: state, duration, attributed errors; run-level unhandled errors; whether the run was partial | `<runDir>/results.json` |
| `test-select run`, after Vitest exits | Exit code and signal; then, if 0, identities of every observed input (content hashed now, with stat compared against the stat taken at read time) | committed records in the store |
| Plan job, per CI run | Static facts for blobs that changed between the record's commit and head, and for blobs of modules named by union terms; facts are cached by blob id plus analyzer version | the facts section of the store |

Identities are not hashed at read time (cost), but the stat taken at read time (size, mtime in ns, inode) is compared with the stat at commit. A mismatch means the file changed during the run, and that test's record is not committed (Fl run-end hashing).

## 4. Input catalog

Every input kind, how it is identified, how it is attributed, and the rule. "Plan" is what the plan job can decide from git objects and the workflow; "in-job" is what `test-select run` decides with the installed workspace.

| # | Input | Identity | Attributed to | Plan | In-job | Rule |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Source module loaded in a worker (Vitest's recorded module ids, including setup files) | content id (section 5) | test | yes, from the head tree | yes | Changed → run, unless coverage pruning clears it (6.4) |
| 2 | File read through `fs` in a worker or child (read, open, stream, copy, `realpath`, `readlink`) inside the repository, ignored or not | content id; symlink: link text and target's identity | test | tracked: yes; ignored or generated: no → `verify` | yes | Changed → run. Paths the same process tree wrote or created earlier in the same test are not inputs |
| 3 | `stat`/`lstat`/`access`/`exists` on a repo path | `absent`, or file type, mode bits and content id (size follows from content) | test | as row 2 | yes | Changed → run. mtime, ctime and inode are not inputs: they differ on every checkout, so a test that depended on them would already be nondeterministic |
| 4 | Directory listing (`readdir`, `opendir`, glob libraries built on them) | the names (and types with `withFileTypes`) the call returned, for the depth the call covered | test | tracked dirs: yes from `ls-tree`; dirs with ignored entries: `verify` | yes | Changed listing → run. A non-recursive call is not anchored by its recursive contents (Fl directory reads) |
| 5 | Path outside the repository (`$HOME/.config/...`, `/etc/ssl/...`), excluding `os.tmpdir()`, `/proc`, `/sys`, `/dev`, and paths the test created | content id plus the runner image version in CI | test | yes when the plan runner has the same image version (it reads the same file), else `verify` | yes | Changed → run. Volatile kernel paths are not inputs; a test whose outcome depends on them is nondeterministic |
| 6 | Third-party package code (any path whose realpath is under `node_modules/.pnpm/<dir>/`) in worker, child, or browser (optimized deps mapped back through the optimizer's metadata) | the pnpm dependency path that `<dir>` encodes (`name@version(peers)`, including `(patch_hash=…)`), plus its integrity from `pnpm-lock.yaml` | test | yes, from the head lockfile | yes | Dependency path missing or integrity changed → run. Lockfiles are never inputs themselves (F9); lockfiles outside the workspace being tested are never read |
| 7 | Bare-specifier resolution from workspace code | the `importers[<package dir>]` subtree of `pnpm-lock.yaml`, and the layout settings in `pnpm-workspace.yaml`/`.npmrc` (`nodeLinker`, hoisting patterns, `injectWorkspacePackages`, `dedupePeers`) | module (charged to every test that loaded it) | yes | yes | Changed → run tests that loaded a module of that package. Layout-setting change → run every test that loaded a third-party package |
| 8 | `package.json` consulted by resolution or transform: the nearest manifest of each loaded module, and the manifest of each package an import resolved into (workspace `exports`, `imports`, self-reference) | hash of the resolution view: `name`, `type`, `main`, `module`, `browser`, `exports`, `imports`, and the dependency field names | module | yes | yes | View changed → run tests that loaded the module. Fields outside the view (`scripts`, `engines`, `version`, `description`) do not affect resolution or transform. A test that reads a manifest with `fs` (57 test files mention `package.json`) has the whole file as a row-2 input, and the web config's `APP_VERSION` define reads it as a config input (row 11) |
| 9 | tsconfig applying to each transformed module | the tsconfig chain Vite used (nearest `tsconfig.json`, `references` match, `extends` chain), and the hash of the transform view: the compiler options Vite's oxc transform reads (`jsx*`, `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields`, `target` when it decides that default, `verbatimModuleSyntax`, `preserveValueImports`, `importsNotUsedAsValues`), plus `baseUrl`/`paths` when the project enables `tsconfigPaths` | module | yes: re-derive the chain on the head tree (a new `tsconfig.json` between the module and its old config changes the chain) | yes | View changed → run tests that loaded the module. Options outside the view (`strict`, `noUnusedLocals`, `types`) cannot change runtime code. The exact view is taken from vite-plus-core's tsconfig loader and pinned by a test |
| 10 | Resolution candidates | for each relative or `paths` specifier of a loaded module: presence of every candidate Vite tries before the one it chose (extensions in `resolve.extensions` order, `/index.*`); for each `vi.mock(spec)` without a factory: presence of the `__mocks__` candidates | module / test | yes | yes | Any candidate's presence changed → run (Fl new resolution candidate). Candidates come from static facts, so no probe needs observing in the Rust resolver |
| 11 | Project config | identities of the config closure (Vite's `configFileDependencies`), env files Vite loads, JS-side files read at config time and by `globalSetup`, config-time env reads (row 13), and the serialized resolved config | project | files: yes; env values: see row 13; serialized config: no | yes | Closure unchanged → nothing. Changed → every test of the project is `verify`; in-job, if the serialized config is identical, the transform proof (6.5) decides per test; otherwise the project runs |
| 12 | Transformed code of each loaded module | hash of the code Vite served to the runner | module | no | yes (transform proof) | Used only to clear differences in rows 8, 9, 11 and 13 that reach a test solely through Vite's transform (`define`, `import.meta.env`, tsconfig, resolution) |
| 13 | Environment variables | per name: value hash or `absent`, taken from the worker's initial environment for names the test read before writing; `ownKeys` enumeration records the hash of the name set. Names the test or setup files wrote or deleted before reading are not inputs (t3code's `providerEnv.ts` deletes provider prefixes) | test (worker, children) or project (config time) | see section 8.3 | yes | Changed → run. Per-run CI names (`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_RUN_NUMBER`, `GITHUB_SHA`, `GITHUB_JOB`, `RUNNER_NAME`, `RUNNER_TEMP`, `ACTIONS_*` tokens and URLs, `INVOCATION_ID`) compare by presence only: their values differ on every run by definition, so a test whose outcome depended on the value would already be nondeterministic |
| 14 | Node version, platform, arch, tool versions | part of `R` | record | `R` of the target job is predicted from root `engines.node` (the setup action installs it) and the lockfile's Vitest/vite-plus versions; mismatch or unknown → `verify` | exact | No record under the job's `R` → run (F3) |
| 15 | Child process: `node` (`process.execPath`, `tsx`, `vp`, any Node shebang) | its own rows 1–6, 10, 13 via the child recorder | test that spawned it | as those rows | yes | Merged into the test's record. A child with a start marker and no end marker (killed, SIGKILL) makes the record incomplete: not committed (F4) |
| 16 | Child process: non-Node executable (`git`, `cc`, `sh -c`, `python`) | the executable file's content id (row 5) | test | as row 5 | yes | If its cwd or any argument names a repository path the test did not create, or it is a shell whose command line does, the test is opaque unless a static union term covers it (6.3). Otherwise the binary identity is the only input (`git init` in a temp dir). A spawn that passes an explicit `env` is rewritten to carry the recorder variables; if that is impossible the child is treated as non-Node |
| 17 | Native readers: `node:sqlite` `DatabaseSync(path)`, `new Worker(path)`, `.node` addons loaded with `process.dlopen` | path as row 2/6; addons: package identity, and opaque unless vetted | test | as row 2/6 | yes | Wrapped constructors record the path. An addon outside the vetted list (addons known to read no files, such as `oxc-parser`) makes the test opaque, because its file access is invisible (Fl `node:sqlite`) |
| 18 | Network to a non-loopback address (`net.connect`, `tls.connect`, `fetch`, `dns.lookup` of a non-local name) | none | test | — | — | Opaque: always runs. Its outcome can change with no change in the repository |
| 19 | Snapshot files (`__snapshots__/*.snap`, `toMatchFileSnapshot` targets, `resolveSnapshotPath` results) | content id or `absent` | test | yes | yes | Recorded by Vitest when touched and by convention when absent (a missing snapshot fails under `CI`) |
| 20 | `import.meta.glob` calls | the match list (re-expanded with the same library and options Vite uses) | module | yes, re-expanded on the head tree | yes | Match list changed → run (Fl new glob match) |
| 21 | Browser module graph | each URL the iframe fetched, mapped through the browser project's client module graph to files, plus each module's non-JS watch files (CSS sources, `addWatchFile`), plus optimized deps' packages | test | as rows 1, 2, 6 | yes | As rows 1, 2, 6 (F8). CSS generated from whole-tree scans (Tailwind) is cleared by the transform proof when the generated CSS is unchanged |
| 22 | CI environment construction | `E_job`: hash of the job's definition in the workflow file, the local composite actions it uses, and the runner label | record (CI only) | yes | — | Used only to predict env values at plan time (8.3) |
| 23 | The selector itself | test-select version and schema version | `R` | yes | yes | Any change to `packages/test-select` runs everything once per `R` |

Tests that are opaque are not recorded; they run every time, with the reason logged. The opaque count is a measured number in the benchmark (section 14) because rows 16–18 can make it large.

## 5. Change model

A **change** is an identity difference for an input in a record, between the value the passing run observed and the value the test would observe now. It is not a commit diff and not an mtime comparison:

- The base commit only decides which records are trusted and looked up (section 9). Because records are content-addressed, a record written at an ancestor of the base, or carried forward through commits that did not run the test, is as valid as one written at the base.
- Local dirty trees, untracked and ignored files, and generated files are compared by their bytes, so selection is the same whether a difference comes from a commit or an edit.

Content id of a file: git's blob id, in the repository's object format (SHA-1 here; SHA-256 repositories use SHA-256), computed over the raw bytes with no clean filters, streamed in chunks with 64-bit sizes (no whole-file reads, no 2 GiB limit). Shortcuts that give the same value without reading the file:

- A tracked path whose working-tree stat matches the stat cached in the index and whose attributes apply no conversion uses the index's blob id. With `* text=auto eol=lf`, LF files check out byte-identical; a CRLF-only edit changes the stat, so the file is hashed raw (Fl CRLF). `*.cmd`/`*.bat` (`eol=crlf`) are always hashed raw.
- In the plan job, a tracked path's head identity is its `ls-tree` blob id under the same no-conversion condition; paths with conversion, ignored paths and generated paths are `verify`.

Directory identity is the listing returned (row 4), never a recursive hash. Symlinks record the link text and the target identity (Fl symlink target). Paths are stored as repo-relative strings in `Map`s and interned tables; all git I/O uses `-z` (Fl `toString`, newline paths).

Why this model: it is the minimal one under which the soundness argument in section 1 holds. Comparing more (whole commits, lockfiles, every env var) over-selects; comparing less (only tracked files, only modules) is how the plugin missed F2, F3, F6 and F9.

## 6. Selection algorithm

### 6.1 Verdicts

Each test gets one verdict:

- `skip`: proof exists (section 1), after pruning.
- `run`: no usable record, a negative marker, an opaque or `always` test, a union term, or a recorded difference that pruning cannot clear.
- `verify`: the plan job cannot compute some identity (ignored or generated inputs, packages that need the installed tree, env values it cannot predict, a different predicted `R`, config differences that need the transform proof). The test job resolves `verify` to `run` or `skip`.

### 6.2 Procedure

```text
plan(head, event):
  bases     = [base_sha] + first_parent_ancestors(base_sha, 20)
  store     = restore_exact(bases)                      // first hit wins; none → empty store
  tree      = ls_tree(head) ∪ ls_tree(record commits)   // blob ids; blob:none fetch, blobs on demand
  projects  = projects_from_store ∪ projects_in_changed_configs
  for project P:
    files_now = glob(P.recorded_include, P.recorded_exclude, P.root) on head tree
    if P.config_closure changed or files_now == ∅: mark P.tests `verify`; continue
    for test T in files_now:
      R' = predict_R(job_of(P))
      rec = store.record(P, T, R')
      if !rec or store.negative(P, T, R') or T in always: run
      else:
        diff = { i ∈ rec.inputs : identity_head(i) ≠ rec.identity(i) }
        unknown = { i ∈ rec.inputs : identity_head(i) is not computable }
        diff = diff \ prunable(diff, rec)                // 6.4
        if diff ≠ ∅: run
        elif unknown ≠ ∅: verify
        else: skip
  run ∪= union_terms(head, base)                         // 6.3; may also turn skip into run
  emit matrix(jobs, shards, file lists, verify lists)    // section 8
```

`test-select run` performs the same loop for its own projects with exact identities (working tree, installed packages, real env, real `R`), then the transform proof (6.5) for tests whose only differences are rows 8, 9, 11, 13 that reach the test through Vite. Cost is dominated by hashing inputs that are not covered by the index shortcut; the union of all records' inputs is hashed once per invocation.

### 6.3 Static union terms

The static analyzer builds a file-level graph from runtime imports (type-only imports elided by each file's tsconfig rule: with `verbatimModuleSyntax`, `import { A }` and `import { type B }` still load their module, `research/ripple.md` §13), path strings and computed paths. It adds tests in these cases only:

- **Opaque child entry points**: a non-Node child, or a Node child the recorder could not reach, whose entry point is named by a path string (`new URL("./bin.ts", import.meta.url)`, `path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts")`). The static load closure of that entry, plus data files named by path strings in it, becomes the child's input set, and the test is no longer opaque. If no path string resolves, the test stays opaque.
- **Resolution changes**: specifiers whose resolved target differs between the record's tree and head under the static resolver (workspace `exports`, tsconfig `paths`, new candidates). This duplicates rows 8 and 10 as an independent check; when the two disagree the test runs and the disagreement is logged as a model gap.
- **Configured `always` tests** (section 8.6).

The graph also serves the plan job as the candidate set for reporting (`why T`: the shortest path from `T` to a changed declaration, as in ripple) and for the audit in section 14: a test the static graph lists as affected but the record proves unaffected is a precision win and is counted; a recorded module the static graph cannot reach from the test is a static-model gap and is counted.

### 6.4 Coverage pruning

A recorded module that changed does not affect `T` if `T` never executed the changed code. This is where declaration-level analysis and runtime coverage combine:

1. Static side: tokenize base and head with oxc, drop comments, whitespace and type-only syntax (ripple's runtime-token hash), and compute the changed hunks. For each hunk, find the innermost enclosing function in base and in head.
2. Runtime side: the worker recorder runs `Profiler.startPreciseCoverage({ callCount: false, detailed: false })` (function granularity) per worker, takes coverage at the start and end of each test file, maps executed function ranges to source positions through the transform's source map, and stores, per loaded module, the set of function body spans `T` never entered.
3. The module is cleared for `T` when every hunk lies strictly inside the body braces of one function that `T` never entered, the same function encloses the hunk in head (same name and position in its parent: class, object literal, or module), and none of these hold:
   - the hunk changes the line or column of any later token and `T` materialized a stack trace with a frame in this module (the recorder wraps the final `Error.prepareStackTrace` and records the files of call sites);
   - `T` called `Function.prototype.toString` on a non-native function (recorded by the wrapper; disables pruning for the whole test);
   - the module is in a project without a source map for the transform.

   A hunk at module top level, in a parameter list, in a class field initializer (V8 reports it as `<instance_members_initializer>`, which runs on construction), or that adds or removes a function, is never cleared: top-level code always runs.

Comment-only and type-only edits produce no runtime-token hunks; they are cleared under the same position rule.

Coverage is measured on t3code before it is turned on (section 14). Without it, every rule above still holds at file granularity; pruning only removes selections.

### 6.5 Transform proof

For a test whose remaining differences are config, tsconfig, manifest or env inputs that reach it only through Vite (rows 8, 9, 11, 13 at config time), `test-select run` starts the project's Vite server through Vitest's node API (the same server the run would start), calls `transformRequest` for each module in the test's record, and compares the hash of each transformed code with the recorded one. All equal, the serialized config equal, and no worker-side difference → `skip`. A transform that throws or a module that no longer resolves → `run`. This turns edits such as `noUnusedLocals` in `tsconfig.base.json`, or an unrelated `define` change, into no-ops while `useDefineForClassFields: false` (F2's probe) changes transformed code and runs.

## 7. Vitest 5 integration

### 7.1 Wiring

Each config adds `testSelect()` to its plugins: the root `vite.config.ts` (and through it `apps/server` and the 28 borrowing packages), `apps/web`, `apps/mobile`, `apps/desktop`, `packages/client-runtime`. The package ships ESM and CJS entries whose CJS export is the function itself (`module.exports = testSelect; testSelect.default = testSelect`), so `apps/mobile`'s CommonJS config loads it (Fl CommonJS configs). Without `TEST_SELECT_RUN_DIR` the plugin returns no hooks, so `vp test run` behaves as today.

Package scripts change from `vp test run …` to `test-select run -- vp test run …`. `test-select run` passes through every argument, adds the selected files as absolute paths, sets `TEST_SELECT_RUN_DIR`, and adds `--import=<main-recorder>` to `NODE_OPTIONS` for the Vitest process. Vitest treats file arguments as substring filters; `/a/x.test.ts` also matches `/a/x.test.tsx`, which can only add a file (it is then recorded like any other).

### 7.2 Node projects

- Module records come from Vitest's own `recordDependencies` data (read from the in-memory cache by the staging reporter in `onTestRunEnd`, which runs after `cache._update`, `plugin.md` §1.3); the worker recorder adds everything else.
- The recorder installs `fs` wrappers with `syncBuiltinESMExports` and the vm pools' per-context resync, as the plugin did, and wraps `child_process` the same way.
- Before each file the recorder sets `TEST_SELECT_CHILD_DIR=<runDir>/obs/<project>/<testHash>/children` and appends `--import=<child-recorder>` to `NODE_OPTIONS` in `process.env`; spawns with an explicit `env` get both merged in.
- `jsdom` projects (mobile `react`) run in node workers and are recorded the same way; the Babel transform's inputs are the config closure (`babel.config.js` is read by `createRequire` at config time, so the main recorder sees it), the Babel packages (row 6), and `T3_MOBILE_TEST_PLATFORM` (row 13, config time).

### 7.3 Browser projects

`@vitest/browser` 5.1.0 runs each file of an isolated project in a fresh iframe, one at a time (`orchestrator` `runIsolatedTestInIframe`), and never reports module dependencies. The plugin adds:

- a setup file, first in the browser project's `setupFiles`, that raises the resource timing buffer and, in `afterAll`, sends the iframe's same-origin resource URLs to a custom browser command;
- the command handler, which maps each URL with `vite.environments.client.moduleGraph.getModuleByUrl` to a module file, adds that module's non-JS imported modules (CSS sources, watch files), maps `node_modules/.vite/deps/*?v=` to the source packages through the optimizer metadata, and writes the result into the test's observation file;
- wrappers around the built-in file commands (`readFile`, `writeFile`, `removeFile`) that record reads under the command context's test path.

The browser executable's version is part of `R`; viewport and provider options are in the serialized config. Whether resource timing lists every module fetch of an iframe, including memory-cache hits, is verified on 5.1.0 before relying on it; the fallback is CDP precise coverage through the Playwright provider's CDP session, which lists scripts per iframe.

### 7.4 Partial runs and exit status

- A run is partial when the global or a per-spec name pattern, `tagsFilter`, test lines or ids are set, or any task has mode `only`. Partial runs commit nothing (Fl `tagsFilter`). File filters and `--project` are not partial: records are per file.
- The commit decision is made by `test-select run` after the Vitest child exits: exit code 0 and no signal. Inside Vitest, the staging reporter also records `onTestRunEnd`'s `errors`; any run-level error blocks the commit even if `dangerouslyIgnoreUnhandledErrors` made the exit code 0 (F1). Coverage thresholds, which Vitest decides after `onTestRunEnd`, are covered by the exit code.

### 7.5 `passWithNoTests`, empty selections, `isolate: false`

- The tool never sets `passWithNoTests` (F5).
- Empty selection: `test-select run` exits 0 without starting Vitest only when the project's include globs, re-expanded on the working tree with the recorded resolved patterns, match at least one file and the config closure is unchanged. Otherwise it runs the original command unchanged, so a broken `include` fails exactly as it does today.
- A project with `isolate: false` (none in t3code) records the union of its files' inputs as one project record; any difference runs the whole project.

## 8. CI integration

### 8.1 Jobs

```text
plan (2 vCPU, no install) ──► test (matrix over package groups)   ─┐
                         ├──► test_web (matrix: unit, browser×k)   ├─► check
                         ├──► test_server (matrix: k shards)       ─┤
                         └──────────────────────────────► collect (push to main/bsv/main only)
```

- `plan` replaces `changes`. Checkout with `filter: blob:none`, fetch the base and 20 first-parent ancestors (commits and trees only), sparse working tree limited to `packages/test-select`, workflow files and manifests. Node from the setup action's cache, no `pnpm install`. The CLI is a single bundled ESM file plus the `oxc-parser` binding, restored from an Actions cache keyed by the hash of `packages/test-select/**` and the lockfile entries of its dependencies; on a miss, `pnpm install --filter @t3tools/test-select --prod --frozen-lockfile` and a bundle step build it. Target: under 15 s wall, comparable to `changes` today.
- Outputs per job: `run` (true when any test is `run` or `verify`), the matrix JSON, and an artifact `plan.json` with per-shard file lists and verify lists. A job with nothing to run is skipped by `if: needs.plan.outputs.<job>_run == 'true'`, so it never checks out or installs (`t3code.md` §6: ~25 s per empty job).
- Non-Vitest work in the `test` job (`node --test` scripts, python, Rust) keeps its existing package-level gating from `ci-changes.cjs`, which the plan job runs unchanged for those outputs. test-select decides Vitest work only.
- Planning never fails a run: any error in `plan` sets every job to run everything with the reason in the step summary.

### 8.2 Sharding

- Records carry per-file durations, so the plan assigns selected tests to shards by greedy longest-first over recorded durations (tests without a duration use the project median). Shard count per job is `ceil(selected_seconds / target)`, capped by the job's current maximum (8 for server), with the target chosen from the bench (startup cost per shard ~25 s against parallel speedup).
- Shards receive explicit file lists, not Vitest's `--shard`, so assignment depends only on the selected set and durations. Because records are per file, any assignment is valid; there is no shard-scoped state to keep stable (Fl local snapshot and shards).
- Server shards run one Vitest process over their list (`fileParallelism: false` is preserved by the config) instead of `test:cached`'s one process per file, which costs ~25–30 s per shard on the fork. The `WeightedShardSequencer` stays for unselected runs.
- The `test` job becomes a matrix over package groups balanced the same way; mobile (95 s) is its own group when selected. Packages with empty selections in a group are not invoked.
- `test_web` splits into `unit` and `browser` entries; browser files (255 s of test time) can shard.

### 8.3 Env prediction at plan time

The plan job cannot see the target job's environment, but the target job's environment is a function of the workflow, the local composite actions, the runner image and the event. For each recorded env input of a test in a CI record:

- GitHub context names that are equal across jobs of one run (`GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `CI`, ...): predicted from the plan job's own environment.
- Per-run names (row 13): presence only.
- Names the workflow or its actions set (job and step `env:`, values written to `$GITHUB_ENV`, `PATH` additions): the recorded value is valid while `E_job` (row 22) and, for tool paths, the image version are unchanged. A static `env:` value in the workflow is read directly; a value set through an expression the plan cannot evaluate is `verify`.
- Anything else: `verify`.

The test job re-checks every recorded env input exactly before running, so a `verify` costs one job start and never a wrong skip.

### 8.4 `check`

`check` accepts a skipped job when `plan` said it had nothing to run, as it accepts `changes` gates today. The plan's outputs replace `changes.outputs` in the `jq` expression.

### 8.5 `collect`

Runs on pushes to `main`/`bsv/main` after the test jobs, when every test job succeeded or was skipped by the plan. It restores the parent commit's store (exact key), applies each job's committed records (uploaded as artifacts by jobs that exited 0), drops records of deleted test files, and saves `test-select-v1-<head sha>`. Tests that were skipped keep their parent's records, so every main commit has a complete store without rerunning anything.

### 8.6 Tests that produce CI artifacts

`apps/server/integration/transferBudgetV2.integration.test.ts` writes the transfer-budget report that `check` requires and `thread-transfer-report.yml` reads. Its run is a measurement, not a test outcome, so it is listed in `always` in `packages/test-select/config.json` with that reason, and it runs on whichever shard the plan assigns it. This is the only entry today; an entry that matches no test file is an error.

### 8.7 Other workflows

`release.yml` and `windows-tests.yml` run everything (`test-select run --all`, which records but does not select). Windows records are a different `R` and are written only by those runs.

## 9. Cache storage and scoping

- **Store contents**: per project, a table of records keyed by (test path, `R`), with interned path and identity tables; static facts keyed by (blob id, analyzer version); negative markers. One entry per commit, gzip-compressed. The bench reports its size; the plugin's records reached 11.6 MB because they kept paths outside the repository and temp files, which rows 2, 3 and 5 exclude.
- **Keys**: `test-select-v1-<sha>`. The schema version is in the key and in `R`.
- **Restore**: exact keys only. For a pull request: `pull_request.base.sha`, then its first-parent ancestors up to 20. For a push: `before` when it is an ancestor of `HEAD` (force pushes fail this check), else `HEAD^1` and its first-parent ancestors. Implemented with `actions/cache/restore` using each full key as an exact key (no prefix shorter than a full SHA). No restore ever reads another branch's entry (F7).
- **Writers**: only `collect` on pushes to `main` and `bsv/main` writes `test-select-v1-*`. Pull request runs write `test-select-pr-<number>-<head sha>` (Actions scopes PR-written entries to the PR's ref, so no other branch can restore them) and restore their own previous head's entry before the base's, so a second push to a PR only reruns what changed since the first. Negative markers from failing PR runs are written to the PR scope.
- **Trust**: an entry is trusted because of who wrote it (protected-branch pushes, or the same PR), not because of its content. Content addressing then makes a trusted entry valid on any descendant.
- **Local**: `node_modules/.cache/test-select/store`, one store per worktree, written by local `test-select run` invocations that exit 0. `test-select fetch` can seed it from the main store of the merge base through `gh`, with the same exact-key rule.

## 10. Failure handling

- **Never save state from a failing run**: records are committed only when the Vitest child exited 0 without a signal, the run was not partial, the reporter recorded no run-level errors, and each committed test passed (its module state is `passed`, or every case was skipped by a condition whose inputs are recorded). A failing invocation commits only negative markers.
- **Failed tests run until they pass**: a negative marker for (project, test, `R`) blocks every record for that test until a later passing invocation commits a new record. This covers failures whose cause is not in any recorded input.
- **Incomplete observations**: a missing observation file, a child start marker without an end marker, a recorder exception, a stat mismatch between read and commit, or an observation that fails schema decoding → that test's record is not committed.
- **Unknown means run**: an input kind the CLI does not know, a store that fails to decode, a record written by another schema version, an identity that cannot be computed in-job, a static parse error in a changed file, or any selector exception → run (the test, the project, or everything, at the narrowest scope the error allows). `test-select run` falls back to the original command unchanged on any internal error.
- **Interrupted runs** (cancellation, timeout, SIGINT): nothing committed.

## 11. Failure modes in the findings report

| Finding | How it cannot occur here |
| --- | --- |
| F1 unhandled errors save a passing snapshot | Commit is decided by `test-select run` from the Vitest child's exit status, after Vitest has applied coverage thresholds; run-level errors also block it (7.4, 10) |
| F2 `package.json`/tsconfig not detected | Resolution views of manifests (row 8), tsconfig chains and transform views (row 9), lockfile importers (row 7) and resolution candidates (row 10) are per-module inputs computed from files, not from what the main process happened to read through JS; the static resolution diff checks the same independently (6.3) |
| F3 Node version and environment | `R` keys every record (row 14); env reads are recorded per test and per project at config time, including values that reach code through `define` (row 13, transform proof); env files are hashed whether ignored or not (row 11); failed tests carry negative markers |
| F4 child processes | Node children inherit the child recorder (row 15); explicit-env spawns are rewritten; non-Node children are opaque unless a static union term covers their entry (row 16, 6.3); killed children make the record incomplete |
| F5 `passWithNoTests` | Never modified; empty selections exit without Vitest only after the include globs are confirmed to match (7.5) |
| F6 git-ignored inputs | Identity comes from bytes for every path in the repository, ignored or not (rows 2–4, section 5); the plan job marks such inputs `verify` instead of assuming them unchanged |
| F7 cross-branch cache | Exact keys of the base and its first-parent ancestors only; only protected-branch pushes write shared entries; PR entries stay in the PR's scope (9) |
| F8 browser tests always rerun | Per-file records from the iframe's resource list mapped through the client module graph, plus server-side file commands (7.3, row 21) |
| F9 lockfile reruns everything | Lockfiles are never inputs; per-test package identities (row 6) and per-package importer subtrees (row 7) are; lockfiles outside the workspace are not read |
| Fl run-end hashing | Stat at read, hash at commit, stat compared; a change during the run drops the record (3) |
| Fl partial records after failure | Records are per test and only from passing invocations; nothing pairs a partial list with an older anchor |
| Fl `tagsFilter` | Partial-run test includes global and per-spec tag filters (7.4) |
| Fl Bloom filter | Exact sets |
| Fl symlink target, CRLF, `toString` key, newline paths | Section 5 |
| Fl `import.meta.glob` | Row 20 |
| Fl new resolution candidate, `__mocks__` | Row 10 |
| Fl `node:sqlite` | Row 17 |
| Fl record growth | Records are replaced per test on each passing run; temp, created and volatile paths are excluded; outside-repo inputs are kept only as real inputs (row 5) |
| Fl directory reads | Row 4 |
| Fl local snapshot and shards | Per-file records, shard-independent (8.2) |
| Fl one-file-per-process runners | File filters are not partial, so every invocation commits records for the files it ran |
| Fl CommonJS configs | CJS entry (7.1) |
| Source-patch regressions (whole-file reads, 2 GiB, SHA-1 in SHA-256 repos) | Streamed hashing with 64-bit sizes in the repository's object format (5) |

## 12. Where this design still over- or under-selects

### Under-selection (a test whose outcome can change is skipped)

- **Nondeterminism**: outcomes that depend on time, randomness, load or ordering inside a file. Not modeled; such a test is flaky with or without selection, and the full runs in `release.yml` remain the safety net.
- **Recorder blind spots that are not detected**: native code inside a vetted addon that does read files; a package that reads repository files through a channel other than `fs` without loading an unvetted addon; process state set before the recorder installs (Vitest internals). The vetted list is the risk: each entry needs a reason and a test.
- **Coverage pruning edge cases**: reflection on unexecuted code other than `toString` and stack positions (for example `fn.length` is a parameter-list change, which is never cleared, but `Object.getOwnPropertyNames(C.prototype)` sees added methods only through class body evaluation, which is top-level code and never cleared). Remaining cases are believed closed but are verified by the mutation campaign before pruning is enabled.
- **Plan-time env prediction**: if a composite action writes a `$GITHUB_ENV` value that depends on something outside `E_job` and the image version (for example a network lookup during setup), the prediction can be wrong. Such names should be listed as `verify`-only; finding them is part of rollout.
- **Static resolver agreement**: rows 8–10 are computed with a model of Vite's resolver and transform. A divergence in Vite's behavior that changes resolution without changing any of the recorded views is missed until the transform proof or a full run catches it. The static resolution diff and the audit counters are there to detect divergence.

### Over-selection (a test that cannot change outcome runs)

- **File granularity** wherever coverage pruning is off or blocked (stack traces through the module, `toString`, top-level edits). Effect modules do most of their work at load time (`ripple.md` §13), so server code will often be cleared only for edits inside service method bodies.
- **Env enumeration**: `Object.keys(process.env)` in a shared setup file (`providerEnv.ts`) makes every test depend on the set of env names. Stable on a given runner image and job; local runs differ from CI by `R` anyway.
- **Opaque tests** (non-Node children touching the repository, unvetted addons, external network) always run. In t3code ~175 test files touch child processes; the share that ends opaque is measured before rollout.
- **Whole-tree scans** (`reactCompilerCoverage.test.ts`, `dependency-graph.test.ts`) depend on every file they list and read; this is a true dependency, not a defect.
- **Package granularity** for third-party code: any version change of a loaded package reruns the test, whatever part of the package it used.
- **`verify` jobs**: a job that starts and then selects nothing costs checkout and install (~25 s) when the plan cannot decide (ignored inputs, unpredictable env, new `R`).
- **Config closure edits** that change the serialized config rerun the whole project; only edits that leave it identical are narrowed by the transform proof.
- **Union terms**: an opaque child's static closure includes every module its entry can load.
- **Negative markers** keep rerunning a test that failed for a reason since fixed outside its inputs until it passes once.

## 13. Performance budget

| Step | Budget | Basis |
| --- | --- | --- |
| Plan job wall | < 15 s | blob-less fetch, no install, store restore ~1 s, ls-tree + identity diff < 1 s, analyzer only on changed blobs (oxc parses all 6,566 t3code files in 1.5 s on one thread; incremental runs parse a few) |
| `test-select run` selection | < 0.5 s typical | index-stat shortcut for tracked files; hash only dirty, ignored and generated inputs |
| Transform proof | only when config-level inputs differ; budget set by bench (one Vite server start plus transforms of the candidate tests' modules) | compared against running the project |
| Recording overhead in workers | measured; target < 5% of Vitest duration without coverage | `fs`/env wrappers are constant-time per call; observation files are written once per test file |
| Function coverage | measured; enabled only if total CI time drops | V8 function-granularity coverage, no block counts |
| Commit | < 1 s | stat compare and hash of observed inputs not covered by the shortcut |

## 14. Implementation phases and evaluation

1. Store, identities, `test-select run` with worker and main recorders, node projects, commit rules, negative markers. Shadow mode (run everything, report what would have been skipped and whether any of those failed) from the first phase.
2. Rows 6–10 and 20 (packages, importers, manifest and tsconfig views, resolution candidates, globs); child recorder; opaque detection.
3. Plan job, matrix, sharding, `collect`, `check` changes; env prediction.
4. Browser recorder.
5. Static analyzer: union terms, resolution diff, `why`, audit counters.
6. Transform proof.
7. Coverage pruning, gated on the bench showing a reduction in CI time on t3code.

The harness in `bench/` replays first-parent t3code commits and the findings report's mutation set: for each, the full run's failing files against each phase's selection (recall must be 1.0 on every case), selected test-seconds against the full run, opaque count, plan and run overheads, and audit counters. Runner variance (up to 2× on Blacksmith) requires repeated CI measurements.

## 15. Facts to verify before implementation

- Whether the staging reporter can read Vitest 5.1's in-memory dependency records directly, or must read `dependencies.json` after `cache._update`.
- Resource timing coverage of module fetches in `@vitest/browser` 5.1.0 iframes, including cache hits, and the URL forms for optimized deps and `/@fs/` paths.
- The exact compiler options and tsconfig lookup rules vite-plus-core 1.5.1 applies (row 9), and its `resolve.extensions` candidate order (row 10).
- That `NODE_OPTIONS` reaches Vitest's `forks` workers and that the main recorder can tell main from worker processes.
- The share of t3code test files that end opaque under rows 16–18, and which addons need vetting.
- Function coverage overhead under the server project's `fileParallelism: false`.
