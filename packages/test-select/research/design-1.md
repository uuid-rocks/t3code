# Design 1: selection from recorded execution

Angle: precision first. Per test file, record what actually executed (V8 precise coverage, mapped through source maps to source-level function units) and every input the run observed (modules, files, directory listings, environment variables, packages, runtime facts), in the Vitest worker, its child processes, worker threads and the browser. A test file is selected when any recorded fact differs between the state its last passing record was made in and the state under test.

This document builds on `plugin.md` (Vitest 5.1.0 mechanisms, the plugin's failure modes and the requirements in its §4 and §7), `ripple.md` (declaration-level hashing, statement purity, resolution diffs) and `t3code.md` (configs, CI, inputs outside the import graph). Section references like plugin §4.2 point there.

## 1. What "affected" means

Fix a test file `T` in Vitest project `P`. A **record** `R(T)` is written only after an invocation that ran `T` exited 0 (§9). It lists a set of **facts**: each fact is a question about the world plus the answer observed while `T` ran, for example "content of `apps/web/src/foo.ts`", "was function unit `foo.ts#fn:parse` executed, and what were its runtime tokens", "value of `process.env.T3_MOBILE_TEST_PLATFORM`" (including "unset"), "listing of `fixtures/`", "Node version".

**Definition.** `T` is *affected* in a target state `S` (a checkout plus a CI environment) when `R(T)` does not exist, cannot be used (runtime identity or record version differs, record marked incomplete), or any fact in `R(T)` has a different answer in `S` than recorded.

**Soundness argument.** Excluding nondeterminism (time, randomness, scheduling, network), a test file's execution is a function of the code it executes and the inputs it observes. If every executed unit has identical runtime tokens, every unit that could start executing is created by an executed unit (so a newly reachable unit implies a changed executed unit, §4.2), every observed input has the same answer, and the runtime is the same, then the execution of `T` in `S` replays the recorded one step for step and its outcome cannot change. The first instruction at which the two executions could diverge is inside an executed unit whose code changed, or at a read whose answer changed. Both are facts in the record.

The argument holds exactly as far as the recorder sees. §11 lists where it does not see, and the design's rule for each blind spot is to mark the record so that `T` always runs ("unknown means run"), except for the residual risks listed in §11.2.

**Not affected** therefore includes: edits to functions `T` never executed (with the caveats on observation in §3.9), comment, whitespace and type-only edits in modules where `T` never observed source positions, changes to packages `T` never loaded, changes to files `T` never read, changes to env vars `T` never read, and lockfile changes that do not change the resolved identity of a package `T` loaded.

## 2. Architecture

```text
                       record time (push to main, scheduled full runs)
  ┌──────────────── Vitest invocation, wrapped by `test-select exec` ─────────────────┐
  │ main process                                                                       │
  │   vite plugin `testSelect()`  ── transform facts, resolution edges, glob calls,    │
  │                                  config-time fs/env reads, unit tables per module  │
  │   coverage provider (custom)  ── per-file coverage → executed unit ids             │
  │   reporter                    ── per-file state, duration, isPartialRun            │
  │ worker (fresh process per file, isolate: true)                                     │
  │   --import recorder           ── fs, env, module.registerHooks, child_process,     │
  │                                  node:sqlite, Error.prepareStackTrace, toString     │
  │   child Node processes        ── same recorder via NODE_OPTIONS + side directory   │
  │   other executables           ── spawned under a file-access tracer, or marked     │
  │ browser (Playwright Chromium)                                                      │
  │   coverage module via cdp()   ── per-file script coverage                          │
  │   server commands             ── fs facts attributed to the calling test file      │
  └─────────── staged records (written to a staging dir, promoted only on exit 0) ─────┘
                                     │ CI artifact of the push run
                                     ▼
                           record set for commit C (per runtime identity)
                                     │
  plan job (no install): Phase A ────┘── selected / candidate / carried-forward files,
                                         shard matrix, empty jobs skipped
  test job (after install): Phase B ──── verifies config/transform/resolution
                                         candidates, then runs Vitest on the final list
```

Components, all in `packages/test-select`:

| Component | Runs in | Needs `node_modules` |
| --- | --- | --- |
| `recorder/worker` (loaded with `--import` through `test.execArgv`) | Vitest worker, children, worker threads | no (Node built-ins only) |
| `vite` plugin `testSelect()` (ESM and CJS entries) | Vitest main process | Vite, Vitest |
| `coverage` custom provider (node and browser modules) | main process, worker, browser | Vitest |
| `exec` CLI wrapper | CI job / developer shell | yes |
| `plan` CLI (Phase A) | plan job | `oxc-parser`, `picomatch`, `yaml` only, installed by the plan job into a temp prefix |
| `verify` (Phase B), inside `exec` | test job | yes |
| record store client | plan, commit job | `gh` / GitHub REST |

Selection logic never runs inside a Vitest hook. Vitest is started by `exec` with an explicit file list, so the plugin does not use `--changed`, `experimental.vcsProvider`, `forceRerunTriggers` or `passWithNoTests`, and none of Vitest's run-end ordering (plugin §1.3) decides whether state is saved.

## 3. What is recorded

Everything below is recorded per test file in a **realm**: the worker process that ran it (Vitest 5.1.0 with `isolate: true` starts a fresh worker per test file, `cli-api.COfZo8lK.js:11319`), plus everything that realm spawned. For `isolate: false` projects a file's record is the cumulative observation of its worker from worker start to the end of that file, so state left by earlier files is included. t3code has no `isolate: false` project.

### 3.1 Execution: V8 precise coverage

- **Node workers.** The custom coverage provider's worker module (`coverage.customProviderModule`) calls `Profiler.startPreciseCoverage({ callCount: false, detailed: false })` through `node:inspector` when Vitest calls `startCoverage` at worker start, and `takePreciseCoverage` in `takeCoverage`. Vitest calls `takeCoverage` in `onAfterRunFiles` and sends the result with `testFiles` to the main process (`index.w_oBZ9N8.js:184-193`, `onAfterSuiteRun`). Function granularity with `callCount: false` is binary and keeps feedback vectors alive, so functions collected by GC are still reported. Block granularity (`detailed: true`) is only enabled with the refinement in §4.4.
- **Browser.** The provider's browser module calls `Profiler.*` through `cdp()` from `vitest/browser` (`@vitest/browser/context.d.ts:1085`, implemented by `@vitest/browser-playwright` `getCDPSession`). The tester calls `takeCoverage` after each file (`tester-*.js:976-984`). Each take records the page's isolate id (`Runtime.getIsolateId`) and the file's start and end times. If two files' windows overlap on one isolate, both get no record (they run next time). Non-Chromium providers give no record.
- **Child Node processes and worker threads.** The `--import` recorder starts a profiler session in each process and thread it is loaded into and writes the result at `exit`. A child that ends by signal, or whose recorder wrote no coverage, falls back to "every unit of every module it loaded executed" (the module list is written synchronously as modules load, §3.6).
- **Mapping to units (main process, record time).** For each script URL in the coverage: find the module in Vite's module graph for that environment (`transformResult.code` and `map`, the same data `@vitest/coverage-v8` uses; Vite's module runner wrapper offset is subtracted), or for natively loaded files (`.cjs`, `.mjs`, Node type stripping, which preserves positions) use the file on disk and `module.findSourceMap`. Map each executed function's start offset through the source map to the original file and take the innermost source function unit (§4.1) whose span contains it. Consistency check: the mapped end offset must land in the same unit. A function whose start is unmapped, or fails the check, marks that module "unmapped", and every unit of it counts as executed. Results are cached per (transformed code hash), so one module is mapped once per invocation however many files load it.

Recorded: per loaded module, its content id and the set of executed unit ids.

### 3.2 Loaded modules

- Vite module runner: Vitest's own `recordDependencies` set per file (plugin §1.1) plus `preparedModules`, read from the plugin's `onTestModuleDependencies` hook data in the main process.
- Native imports in the worker and in children: `module.registerHooks` resolve and load hooks in the recorder (Node 26), including `require`.
- Browser: the script URLs in the CDP coverage plus, from the client environment's module graph, CSS and asset modules those scripts imported.
- `?raw`, `?url`, `.wasm` and other asset modules: content facts on the asset file.
- Snapshot files: Vitest adds touched snapshot files to the dependency set (plugin §1.1); they are content facts, absence included.

### 3.3 Transform and resolution facts (main process)

For each loaded repository module the plugin records, at transform time:

- **Source content id** of the code passed to the first transform hook (`enforce: "pre"`), so the fact is the content Vite actually transformed, captured when it was read.
- **Transformed code hash** (the code V8 ran).
- **Transform option facts**: the tsconfig file that applies and its `extends` chain (content ids), the effective transform-relevant options (`useDefineForClassFields`, `verbatimModuleSyntax`, `jsx*`, `experimentalDecorators`, `emitDecoratorMetadata`, `target`), the plugin chain that transformed it (plugin names plus the package identity of each plugin's package, §3.5), and the `define` keys the transformed code references.
- **Resolution edges**: for each import the module made, `(importer, specifier, environment, conditions) → resolved id`, collected by a `resolveId` hook that records the final result Vite returns (`this.resolve(..., { skipSelf: true })` result, memoized per edge). Also the manifest facts resolution depends on: the nearest `package.json` of the importer (`type`, `imports`), and for workspace targets the target's `package.json` (`exports`, `name`).
- **Glob calls**: each `import.meta.glob` call (pattern, base, options) found in the source with `oxc-parser`, plus the match set Vite produced.
- **Watch files** Vite plugins attached (`addWatchFile`, module graph `importedModules` outside `transformResult.deps`).

Config-level facts per project: the config file and its import closure (`configFileDependencies`), files and env vars the config read while loading (the recorder's fs and env hooks are active in the main process for the duration of config loading only), a hash of the resolved serialized project config with non-semantic fields removed (reporters, cache paths, `coverage`, which this tool owns), the resolved `include`/`exclude`/`dir`/`root`, and `setupFiles`/`globalSetup` paths. Setup files are ordinary loaded modules of every file and need no special case.

### 3.4 File-system facts

The recorder wraps `node:fs` and `node:fs/promises` read entry points (the plugin's list: `access`, `copyFile`, `lstat`, `open`, `opendir`, `readdir`, `readFile`, `readlink`, `realpath`, `stat`, sync, callback and promise forms, `existsSync`, `createReadStream`, `cp`) and resyncs ESM named exports (`syncBuiltinESMExports`). It also wraps `node:sqlite` `DatabaseSync` and `new Worker(path)`. Facts:

| Call | Fact |
| --- | --- |
| `readFile`, `createReadStream`, `open` + read, `copyFile`/`cp` source, `DatabaseSync` | content id, computed from the bytes returned or the file at open time, streamed |
| `stat`, `lstat`, `access`, `existsSync` | existence, file type, size, mode (not times or inode) |
| `readdir`, `opendir` | the exact entry list returned (names, and types when `withFileTypes`), not a recursive listing |
| `readlink`, `realpath` | the returned path; for symlinks the link and the target's identity |

Rules:

- Identity comes from the bytes, never from git's view: ignored, untracked and modified files are hashed like tracked ones (plugin §4.6). The id is a git blob id in the repository's object format (`git rev-parse --show-object-format`), computed from raw bytes (no clean filters), so a clean tracked file's id equals its index entry and the planner gets it for free.
- Paths the realm created or wrote before reading are not inputs. Paths under `os.tmpdir()` are not inputs. Both still enter the produced-input edges (§3.11).
- A path outside the repository is an environment fact (§3.10) when it is under a configured root (`/usr`, `/etc`, `$HOME` minus caches); other outside paths (`/proc`, `/sys`, `/dev`) are covered by the runtime identity.
- Each fact is captured at read time. At commit the recorder re-checks in-repo facts; if a file changed between read and the end of the file's run, the file gets no record.

### 3.5 Third-party packages

Under pnpm a loaded module's realpath is `node_modules/.pnpm/<dir>/node_modules/<name>/...`. At record time the plugin maps each store directory to its lockfile snapshot key (`name@version(peers)(patch_hash=…)`) using the installed `node_modules/.pnpm/lock.yaml`. Facts:

- the set of snapshot keys the realm loaded (worker, children, main-process plugins that transformed its modules);
- each bare-specifier edge from a workspace importer or a package: `(importer package or key, dependency name) → key`, read from the lockfile's `importers` and `snapshots` entries.

Code inside packages is not unit-mapped. A changed key is a module-level change for every test that loaded it.

### 3.6 Child processes and worker threads

The recorder wraps `child_process` (`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`, `fork`, promisified forms) with the same ESM resync, so `@effect/platform-node` and other importers see the wrapper.

- **Node children** (executable is `process.execPath` or `node`, or a script whose shebang resolves to `node`, which covers `tsx`, `vp`, `pnpm`): the wrapper adds `--import=<recorder>` to `NODE_OPTIONS` and `TEST_SELECT_SIDE=<dir>/<test-file-id>` to the child's env, including spawns that pass an explicit `env` without them. The child recorder hooks the same APIs, writes each new module load and each new read fact synchronously (`fs.writeSync` on an fd opened at start, one line per distinct fact) so a killed child loses nothing it already did, and writes coverage at exit. The worker merges the side directory into the test file's record at file end. Env vars the recorder adds are hidden from the env facts.
- **Worker threads** inherit `execArgv`, so the recorder runs in them; they report to the same side directory.
- **Other executables** (`git`, `sh`, `cc`, `cargo`, Chromium launched by `playwright-core` in server tests): spawned under a file-access tracer when one is available (Linux: the `fspy` tracer vite-plus ships, if its entry can be called directly; to be verified in implementation), which records every file the process tree opened. Without a tracer, the test file's record is marked `untraced-child` and the file always runs. A shell that execs `node` is a Node child for the env propagation above, and the tracer covers the shell's own reads.
- Executables are also environment facts: resolved path and content id of the binary, plus `--version` output for `git`.

### 3.7 Environment variables

The recorder replaces `process.env` in the worker with a Proxy that records `get` and `has` as `name → value hash` (absent recorded as absent) and `ownKeys` as "all names", which records every name and value. Reads made by Node internals while spawning a child are suspended (the child records its own reads). Config-time reads in the main process are project facts (§3.3); `define` values reach modules through the transformed code hash, so they are precise per module.

A configurable `volatileEnv` list (`GITHUB_RUN_ID`, `GITHUB_SHA`, `GITHUB_RUN_ATTEMPT`, `RUNNER_TEMP`, …) names values that differ on every CI run. A test that reads one of them is a test whose outcome may differ on every run: it always runs. No variable is ignored silently.

### 3.8 Runtime identity

`process.version`, `process.versions.v8`, platform, arch, libc, the browser name and revision for browser projects, the test-select record format version, and the runner image id (`ImageOS`/`ImageVersion` or the Blacksmith equivalent). Records are grouped by runtime identity; a record is usable only under an identical identity. Vitest and vite-plus versions are package facts (every test loads Vitest), so a Vitest bump reruns everything through §3.5 without a special case.

### 3.9 Observation hazards

Executed-unit selection assumes code that did not run cannot influence the outcome. Three ways it can, and what is recorded:

- **Function source text.** The recorder wraps `Function.prototype.toString`. A call on a non-native function marks the realm `source-observed`: for this file every token change in a loaded module counts (module granularity).
- **Function `length` and `name`.** These are readable without calling the function. They are part of the parent unit's marker for the nested function (§4.1), so changing them changes a unit that executed.
- **Source positions.** Stack traces, `error.stack` assertions and source-mapped output depend on line and column. The recorder installs `Error.prepareStackTrace` as an accessor that wraps whatever handler is assigned (Vite's source map interceptor included) and records the file of every repository frame in a formatted trace. Those modules are `position-sensitive` for this file: any byte change in them counts, comments and whitespace included. Effect captures call sites with `new Error()` in places; how often this widens selection on t3code is measured in the bench (§12).

### 3.10 Environment facts outside the repository

Outside-repo files under configured roots and executables (§3.6) are recorded with content ids (binaries hashed once per invocation). They are compared in the plan job, which runs on the same image family, and again in the test job before running (§5.3).

### 3.11 Produced-input edges

Every realm also records the paths it wrote or created, repository and temp paths included. At commit, a read by `T` of a path that another test file `W` of the same invocation wrote (not counting paths `T` created itself) becomes an edge `T → W`: when `W` is selected, `T` is selected. This covers order-dependent coupling through the file system under `fileParallelism: false` without treating every shared temp path as an input.

### 3.12 Record format

One record set per (commit, runtime identity, project set), stored as a single zstd-compressed file (`node:zlib` zstd):

- string tables for paths, unit ids and package keys;
- per module blob id: its unit table (unit id → runtime-token hash, parent, marker) computed once at record time with `oxc-parser`, so the planner never parses base versions;
- per test file: project, duration, loaded modules with executed-unit bitsets (deduplicated across files, since most files share setup closures), position-sensitive and unmapped flags, fs, env, package, resolution, glob and environment facts, produced-input edges, flags (`source-observed`, `untraced-child`, `incomplete`);
- per project: config facts.

Records are exact sets throughout (no Bloom filter), keyed by `Map` or null-prototype objects, and paths are NUL-safe.

## 4. Change model

A change is a fact whose answer differs between the record and the target state. How each kind of fact is compared:

### 4.1 Units and runtime tokens

A **unit** is a source function-like node: function declaration or expression, arrow, method, getter, setter, constructor, generator, async function, class field initializer (attached to the class's parent unit, since V8 runs instance initializers inside a synthetic function that does not map cleanly), plus one **module body** unit per module. Static blocks and static fields belong to the enclosing unit (they run at class evaluation).

A unit's **runtime tokens** are the tokens lexically inside it, with each directly nested unit replaced by a marker `<fn kind name length async generator>` (`length` counts parameters before the first default or rest). Excluded: comments (except pragma comments: `@jsx*`, `@vitest-environment` and other `@vitest-*` docblocks, `@vite-ignore`, `#__PURE__`/`@__PURE__`, `sourceMappingURL`, and any unrecognized `@`-directive), whitespace, and TypeScript-only syntax as the module's transform erases it: type annotations, type parameters and arguments, interfaces, type aliases, `declare` items, overload signatures, `implements`, the type part of `as`/`satisfies`/`!`, and imports removed under the module's elision rule (`verbatimModuleSyntax` keeps `import { A }` and turns `import { type B }` into `import "./b"`, ripple §13). Class fields without initializers are runtime when `useDefineForClassFields` is true. With `emitDecoratorMetadata` on, type tokens are runtime. Constructs that are not erasable (`enum`, runtime `namespace`, parameter properties) keep all their tokens. Node kinds in source order are hashed with the tokens, as ripple does, so the same tokens parsed differently hash differently.

**Unit ids** are paths of local keys from the module body: `fn:name`, `method:name`, `get:name`, `prop:key`, `call:<callee member chain>(<first string literal arg>)#i` for callbacks (`call:it("parses ids")#0`, `call:Effect.gen#0`), `anon#k` otherwise, with an ordinal among siblings that share a key. Ids only need to be stable enough to be precise:

> **Invariant.** A function object exists only after its parent unit executed the code that creates it. So any change that makes an id unstable (an inserted sibling, a rename) also changes the parent's runtime tokens (its markers), and if the child executed, the parent executed. Unstable ids can cost precision, never recall.

### 4.2 Module comparison

For a module `M` loaded by `T` whose content id differs:

1. `M` is `unmapped`, `position-sensitive`, or `T` is `source-observed` → changed for `T`.
2. Parse head `M`; on a parse error in head → changed for `T`.
3. Compare unit tables by id. `T` is affected when any unit in `T`'s executed set for `M` has a different hash or no longer exists. The module body is in every executed set. New units with no recorded counterpart are covered by the invariant above.

Level 1 treats the module body as one unit. **Level 2** (behind a flag until the bench shows it pays) splits the module body into top-level statement units, following ripple §4–§6: a changed top-level statement that is pure (function or class declaration markers, literal constants, calls on a reviewed pure list such as `Schema.Struct`, `Context.Service<…>()("id")`, with ripple's escape and mutable-state rules) affects `T` only if an executed unit or an impure top-level statement in a loaded module statically references its binding, resolved through imports and re-exports with oxc scope analysis. Namespace imports, `import()`, `export *` and any unresolved reference count as referencing every export. Impure statements, imports and re-exports affect every loader. On t3code this is what makes edits to widely loaded `contracts` schemas select only tests whose executed code reaches the changed schema.

### 4.3 Other facts

| Fact | Changed when |
| --- | --- |
| Asset, snapshot, fs content | content id differs, or existence differs |
| `stat`-class facts | existence, type, size or mode differ |
| Directory listing | the listing a call with the same arguments would return differs (computed from the head tree plus ignored files on disk) |
| Resolution edge | Phase A: a manifest or tsconfig fact on the edge differs, or a file was added or removed in a directory resolution searched (a sibling with the same stem as the target, an `index.*`, a `__mocks__` directory beside the importer or at the root); Phase B: Vite re-resolves the edge to a different id |
| Transform | Phase A: a transform option fact, plugin package key or config fact differs; Phase B: the module's transformed code hash differs |
| Glob call | the pattern re-expanded on the head tree gives a different match set |
| Package key | the lockfile-derived key for a recorded edge differs, or the key is gone |
| Env var | value hash differs, or presence differs |
| Environment fact | binary or outside file content id differs |
| Runtime identity | any field differs → record unusable |
| Project config facts | Phase A: config closure, config-time fs or env facts differ; Phase B: resolved project config hash differs |
| Produced-input edge `T → W` | `W` is selected |

A transform difference in Phase B with identical source marks `M` changed at module granularity for every test that loaded it (units cannot be aligned through two different transforms).

### 4.4 Block refinement (optional)

With `detailed: true` coverage the record also holds unexecuted block ranges per executed unit. An executed unit whose token changes all fall inside blocks that did not execute, whose controlling expressions are unchanged, and which add or remove no `var`, function declaration in sloppy code, `arguments`, label, direct `eval`, `await` or `yield`, is not changed for `T`. Disabled until the bench shows the extra coverage cost is worth it.

## 5. Selection algorithm

### 5.1 Phase A: plan job (no install)

```text
input: target state S (HEAD tree, CI context), record set RS (§8), test-select config
1. ids    := git ls-files -s -z (index blob ids, excluding .repos/)
             + raw-byte ids for files the records name that are dirty, untracked or ignored
2. if RS missing or unusable, or runtime identity predicted for each job differs
      → every test file of affected identities runs (reason printed)
3. inventory := per project, expand recorded include/exclude globs on the head tree;
                new test files (no record) → selected
4. for each record R(T):
      if R flagged incomplete | untraced-child | volatile-env → selected
      for each fact f in R: compare per §4 using ids and the head blobs of changed modules
         (parsed once per blob with oxc-parser; lockfile parsed once with yaml)
      a fact that needs Phase B (resolution, transform, config) → candidate
      any other changed fact → selected (stop at first)
5. close over produced-input edges
6. failing-on-base: a test file with no pass record at the base is selected (it has no R)
7. output: selected, candidates (with the facts to verify), carried-forward records,
           per-job file lists and shard matrix (§7.2), reasons per file (`why`)
```

Comparison is fact by fact against content ids, so the base commit's diff is never needed for correctness; it is only used to find which modules changed (`git diff --raw -z` from the record set's commit to HEAD), so step 4 skips modules whose id is unchanged without hashing anything.

### 5.2 Phase B: test job (after install)

`exec` loads each project's config with `createVitest` (no run), then for the job's candidates only: computes the resolved config hash, re-resolves flagged edges with the project's Vite environment, re-transforms flagged modules and hashes the output, and re-expands include globs. A candidate whose verified facts are all unchanged is dropped. Phase B errors keep the candidate. Cost is one config load (about 0.3–1 s per config locally, `t3code.md` §4) plus transforms of flagged modules.

### 5.3 Environment re-check

Before starting Vitest, `exec` computes the job's real runtime identity, env values for recorded names and environment facts, and adds any test file whose facts differ. A job the plan skipped never runs this check, so the plan only skips a job when every environment fact it relied on was predicted from repository content or from the plan job's own image (same image label): Node from `engines.node` (exact in t3code: `26.12.1`), env values from the workflow file (a change to `.github/workflows/ci.yml` makes env facts of names it sets unpredictable), image id from the plan runner. Names a job sets from `secrets.*` or `vars.*` are unpredictable: tests that read them always run.

## 6. Vitest integration

- **Plugin.** `testSelect()` is added to the root config and the five own configs. It sets `coverage: { enabled: true, provider: "custom", customProviderModule: "@t3tools/test-select/coverage", reporter: [] }` when recording, appends the recorder to `test.execArgv` (`--import`), and registers the transform, resolve and module-graph hooks. In PR runs (`exec` without `--record`) it adds nothing to the config. The resolved config hash excludes the fields it owns, so both modes hash the same. A CommonJS entry serves `apps/mobile` (plugin §4.10).
- **File list, not filters.** `exec` passes the final file list to `vp test run` (per config, with the same `--config`, `--dir` and `--project` arguments the package scripts use). File lists are not partial runs, so any subset produces records (fixes "one-file-per-process runners never select"). A run is partial exactly when Vitest's `isPartialRun` says so (`-t`, `.only`, line or id filters, global or per-spec `tagsFilter`): no records are written.
- **`passWithNoTests`.** Never changed. An empty selection exits 0 without starting Vitest, after Phase A or B confirmed the include globs match test files. If the globs match nothing, `exec` starts Vitest unchanged so the user's setting decides.
- **Node projects** (`environment: node` and `jsdom`, forks pool): coverage, recorder, children as in §3. vm pools (`vmThreads`, `vmForks`): no record until coverage attribution in vm contexts is verified.
- **Browser projects**: coverage through `cdp()`, module graph from the client environment, fs facts from wrapped server commands (`readFile`, `writeFile`, `removeFile` receive the calling `testPath`). Browser runtime identity includes the Chromium revision. Tailwind CSS: the CSS module's transform depends on class names in every scanned source, so a change to any file under the Tailwind source roots makes the CSS module a Phase B candidate; Phase B recompiles it and compares the output hash, and only browser tests that loaded a CSS module whose output changed are selected.
- **`shardWeights.json` and `WeightedShardSequencer`** are not used for selected runs; sharding happens before Vitest (§7.2). `--shard` is never passed to a selected run.

## 7. t3code CI integration

### 7.1 Jobs

| Job | Change |
| --- | --- |
| `plan` (replaces `changes`) | 2 vCPU; checkout `fetch-depth: 2` with `--filter=blob:none` plus the blobs of changed files; Node from `engines.node`; installs `oxc-parser`, `picomatch`, `yaml` into a temp prefix (cached by version); fetches the record set (§8); runs Phase A. Outputs per-job JSON: `test_packages` (package → files), `web_unit`, `web_browser`, `server_matrix`, and the candidate facts. On any planner error it prints the reason and outputs today's `ci-changes.cjs` answer, so a planner failure never skips more than CI does today. |
| `test` | `if` checks the plan output is non-empty; runs `test-select exec --plan plan.json --job test`, which runs only packages with selected files, four at a time as today |
| `test_web` | same pattern; unit and browser lists separately, so a unit-only change does not install Chromium |
| `test_server` | matrix from `server_matrix`; each entry is an explicit file list in one Vitest process (no `test:cached` per-file processes, which cost 25–30 s per shard on the fork, `t3code.md` §3.3) |
| `commit-records` (push to main only) | `needs` every test job, runs only if all succeeded or were skipped by the plan; merges staged records with the plan's carried-forward records and uploads the record set artifact |
| `check` | unchanged rule: every job succeeded or was skipped by its plan output; `plan` must have succeeded |

`transferBudgetV2.integration.test.ts` produces an artifact `check` requires when the server ran. It goes in the config's `alwaysRunWhen: { job: "test_server" }` list: when any server file is selected, it runs too. The node:test, python and Rust steps in `test` are outside Vitest and keep their current gating.

### 7.2 Sharding and empty jobs

Server shard count is `min(8, ceil(sum(durations) / 60 s))` over the selected files, using recorded durations (`shardWeights.json` for files without one), assigned by longest-processing-time-first. A matrix with zero entries skips the job before checkout. The package job and web job are skipped when their lists are empty and no Phase B candidates exist. Jobs that only have Phase B candidates start, verify, and may run nothing; that costs checkout and install (about 20–28 s) and is the price of not installing dependencies in the plan job.

### 7.3 Push runs on main

A push to main plans against the parent commit's record set like a PR, runs the selected files with recording enabled, and carries the other records forward: they were re-validated fact by fact in Phase A, so they are valid for the new commit. A scheduled full run (every few hours, and on any change to `packages/test-select`) runs every file with recording, replaces the record set, and is the safety net: a test that fails in the full run while the record set says it was unaffected since its last pass is a recorder blind spot, reported as such with the record's facts (shadow check).

## 8. Record storage and scoping

- **Store.** Record sets are workflow artifacts of push runs on the default branch (`test-select-records-<runtime-identity>-<sha>`), not Actions cache entries. The plan job finds them with the GitHub REST API (`actions/runs?head_sha=<sha>&event=push&branch=main&status=success`, then the run's artifacts), so the provenance is GitHub's record of a trusted push run. PR runs, forks included, cannot produce them. No prefix restore exists (plugin §4.7).
- **Key: the base commit.** PR: `github.event.pull_request.base.sha` at the time of the run (for the merge commit, `HEAD^1`). Push: `github.event.before`. If that commit has no record set yet (its run is in progress or failed), the planner walks first-parent ancestors of the base, exact sha each, up to 30 commits, and uses the nearest. Comparing against an older record set selects more, never fewer, because comparison is by content. Beyond 30, it runs everything.
- **Never another branch.** Records are only read from the default branch's push runs at the base or its first-parent ancestors. A PR's own earlier runs are not used: a rerun of a failed job restores the same base records and reruns the same files (plugin §4.1).
- **Runtime identity** is part of the artifact name, so a Node upgrade on main starts a fresh record set while the old one stays valid for branches still on the old Node.
- **Local use.** `test-select exec` locally reads the record set for `git merge-base HEAD origin/main` (downloaded with `gh`) and stores records from local green runs under `node_modules/.cache/test-select/<runtime-identity>/`, merged per file. Local records never upload.

## 9. Failure handling

- **State only from exit 0.** Workers, children and the main process write facts to a staging directory. `exec` waits for the Vitest process to exit; only exit code 0 promotes staged records (Vitest's exit code already includes unhandled errors and coverage thresholds, plugin §1.3). Additionally a file is recorded only if its module state is `passed` or `skipped` and no error was attributed to it. On CI, a job uploads staged records only when `exec` exited 0, and `commit-records` writes a record set only when every job succeeded.
- **Failed files have no record** and run until they pass. Records are replaced per file on each pass and never unioned with older ones, so a short record from a failed run cannot exist.
- **Unknown means run.** No record, unusable runtime identity, record format mismatch, `incomplete` (recorder error, killed child without a module log, overlapping browser windows), `untraced-child`, `volatile-env`, unparseable head module, unmapped coverage (module granularity), Phase B error, planner error (fall back to `ci-changes.cjs`), missing record set (walk, then everything).
- **The recorder must not change behavior.** Wrappers forward arguments, `this` and errors unchanged, and the env Proxy forwards writes. No signal handlers are installed. A recorder exception in a wrapped call is caught, marks the realm `incomplete`, and the original call proceeds.
- **Retries.** A file that passed only on retry is recorded with a `flaky` flag; selection treats it like any record (flakiness is not a selection question), and the bench reports flaky files separately.

## 10. Findings report, item by item

| Finding | Why it cannot occur here |
| --- | --- |
| 1. Unhandled errors save a passing snapshot | Records are promoted by `exec` after reading the process exit code, outside Vitest's reporter phase; CI writes record sets only after every job succeeded (§9) |
| 2. `package.json` / tsconfig not detected | Manifests and tsconfig chains are facts of each loaded module's resolution and transform; edits to them make the edges and transforms candidates, and Phase B re-resolves and re-transforms with the real Vite resolver (§3.3, §5.2) |
| 3. Node version and environment | Runtime identity per record set; env reads recorded per file with values and absence; config-time env reads are project facts; `.env` files are fs facts of the config load; `define` values are in transformed code hashes (§3.3, §3.7, §3.8) |
| 4. Child processes | Node children carry the recorder through `NODE_OPTIONS`, including explicit `env`; other executables run under a tracer or make the file always run (§3.6) |
| 5. `passWithNoTests` | Never changed; empty selections exit before Vitest only after confirming globs match files (§6) |
| 6. Git-ignored inputs | Identity from bytes for every recorded path, tracked or not (§3.4) |
| 7. Cross-branch cache | Artifacts of trusted push runs at the exact base sha or its first-parent ancestors; no prefix restore (§8) |
| 8. Browser tests always rerun | Browser files get records from CDP coverage and the client module graph (§3.1, §6) |
| 9. Lockfile reruns | Package facts are lockfile snapshot keys per recorded edge; only tests that loaded a package whose key changed are selected; lockfiles outside the workspace are not read (§3.5) |
| Run-end hashing | Facts captured at read time and re-checked at file end (§3.4) |
| Partial records after a failure | Per-file pass records only, replaced not unioned (§9) |
| `tagsFilter` | Partial exactly when Vitest's `isPartialRun` is true (§6) |
| Bloom false positives | Exact sets (§3.12) |
| Symlink target edits | Link and target are both facts (§3.4) |
| New `import.meta.glob` match | Glob calls re-expanded and match sets compared (§3.3) |
| New resolution candidate, `__mocks__` | Added files in searched directories make edges candidates; Phase B re-resolves (§4.3) |
| `node:sqlite` fixtures | `DatabaseSync` wrapped; tracer for other native openers (§3.4) |
| CRLF-only edit | Raw-byte ids (§3.4) |
| File named `toString`, newline paths | `Map`/null-prototype; NUL-delimited git I/O (§3.12) |
| Record growth | Per-file records replaced on each pass; temp and self-written paths excluded (§3.4) |
| Directory reads anchored recursively | The listing returned is the fact (§3.4) |
| Local snapshot not partitioned by shard | Records are per file; sharding happens after selection (§7.2) |
| One-file-per-process runners | File lists are not partial (§6) |
| CommonJS configs | CJS entry for the plugin (§6) |
| `source-patch-review.md` regressions (2 GiB, whole-file reads, SHA-1 in SHA-256 repos) | Streamed hashing; ids in the repository's object format (§3.4) |

## 11. Where it still over- or under-selects

### 11.1 Over-selection (runs a test the change cannot affect)

- **Executed is not relevant.** A changed executed unit selects `T` even if the change cannot reach an assertion (a log message, a branch inside the function that did not run without §4.4). Inherent to function granularity.
- **Module body (level 1).** Any change outside function bodies (a new export, an edited constant, an import) selects every test that loaded the module. Level 2 (§4.2) narrows pure statements; impure top-level calls, common in Effect code (`Layer.effect(...)` arguments outside callbacks), stay module-wide.
- **Packages.** A package key change selects every test that loaded the package, whatever code in it ran.
- **Position-sensitive modules and `source-observed` realms** fall back to byte or module granularity.
- **Phase B jobs.** A job whose only work is candidates still starts (checkout and install) and may run nothing.
- **Older record sets.** When the base has no record set, comparison against an ancestor's set selects the union of changes since that ancestor.
- **Killed children** count every module they loaded as fully executed.
- **Always-run classes**: `untraced-child` without a tracer, `volatile-env`, Node upgrades (everything), files whose last run failed.

### 11.2 Under-selection (residual risks)

- **Native reads the hooks and tracer miss**: native addons reading files or calling `getenv` directly in the worker process (the tracer covers children only, not the worker itself, unless the worker is also traced). Mitigation if found by the shadow check: wrap the addon or trace workers.
- **Coverage mapping errors** that pass the start/end consistency check (a wrong but self-consistent source map). Mitigation: the shadow check; mutation runs in the bench target transforms with plugins (React Compiler, TanStack Router, Babel in mobile).
- **Main-process plugin reads** that are not watch files, not config facts and not covered by a Phase A trigger (a plugin reading an arbitrary file during transform). Tailwind is handled explicitly (§6); other plugins in t3code's configs need a review of what they read, recorded as plugin rules in the config.
- **Unpredictable environment in skipped jobs**: an env value set from outside the repository (runner image env not in the image id, organization variables) that changes while the plan skips the job. Mitigation: names set from `secrets`/`vars` always run (§5.3).
- **Level 2 purity list** entries that are wrong (a "pure" call that runs effects) and **block refinement** guard gaps; both off by default and gated on the bench.
- **Outside-repo files not under configured roots** and stat times (mtime, inode), which are not facts.
- **Shared external state** other than files (ports, databases, a daemon started by another test file) that couples test files.
- **Nondeterministic failures** are never a selection question; a flaky test skipped because nothing changed may hide a flake, not a regression.

## 12. Costs and what the bench must measure

- **Plan job**: target under 5 s after checkout: artifact fetch (1–2 s), `git ls-files -s` (index ids, no hashing for a clean checkout), parse only head blobs of changed modules (`oxc-parser` parses all 6,566 t3code TS files in 1.5 s on one thread, `ripple.md` §13), lockfile parse, glob expansion.
- **Recording overhead** (push and scheduled runs only; PR runs do not record): precise function coverage, fs/env wrappers, child recorder, mapping. Measure per project on t3code, especially server (process-heavy) and web browser (CDP). Target under 15% of Vitest wall time.
- **Record size**: 2,013 files, deduplicated bitsets; target under 20 MB compressed per identity.
- **Precision**: replay real upstream commits (bench harness) and report selected test files per commit for: today's `ci-changes.cjs`, Vitest-recorded file level, this design at level 1, level 2, and with §4.4.
- **Recall**: mutation campaigns as in the findings report (source, fixtures, child-process entry points, manifests, tsconfig, env, ignored files, lockfile entries, browser-only components), compared against full runs; plus the shadow check on every scheduled full run.
- **Open verification items** before implementation: `Runtime.getIsolateId` and per-file windows in `@vitest/browser` 5.1.0 with several pages; whether vite-plus 1.5.1 exposes `fspy` for spawning a traced child; V8 coverage attribution under Vite's module runner wrapper in Vitest 5.1.0; the cost of `Error.prepareStackTrace` recording in Effect-heavy server tests.
