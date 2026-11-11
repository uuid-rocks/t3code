# @useblacksmith/vitest 0.4.0: how it selects, where it fails, what to keep

Sources read:

- Plugin source at commit `16289c72` (`/home/jh/.local/state/bsv/vitest-src/src/*.ts`) and the published `dist/` (`/home/jh/.local/state/bsv/pkg/package/dist`). The dist is a straight compile of that commit; line references below are to the TypeScript source.
- Vitest 5.1.0 and `@vitest/browser` 5.1.0 dist in this worktree's `node_modules/.pnpm` (chunk names: `cli-api.COfZo8lK.js`, `index.Di8au7q4.js`, `base.Cof-UHJf.js`, `module-dependencies._2Eei3FO.js`).
- The t3code validation report `/home/jh/src/artifacts/useblacksmith-vitest-findings.md` and its evidence folder (`failure-paths-report.md`, `ci-cache-lines.md`, `perf-results.md`, `source-patch-review.md`, `v3-dist-patch.patch`, `base-exact-restore.patch`).
- t3code's existing per-file test cache, `scripts/lib/cached-tests.ts` (the `test:cached` task used by the server shards).

## 1. Vitest 5.1.0 mechanisms the plugin builds on

### 1.1 Recording (`experimental.recordDependencies`)

Worker side:

- `WorkerGlobalState.dependencies` is a `Set<string>` that exists only when `recordDependencies` is on and `cache` is enabled (`index.Di8au7q4.js:4152`).
- The Vite module runner adds every module id it evaluates for the current file (`_cachedRequest`, `index.Bi0NXYPf.js:665`). With `viteModuleRunner: false`, a Node resolve hook records native imports instead (`base.Cof-UHJf.js:160-172`, `NativeImportGraph`), skipping `node_modules` and edges from Vitest's own dist.
- Snapshot files the file touched are added (`index.CZzC1gGg.js:8340`).
- Before each file the set is cleared; after it, the worker sends `collectDependencies(getImports, preparedModules, dependencies)` over RPC (`base.Cof-UHJf.js:83-100`). `preparedModules` are the modules loaded before the first file (environment, setup), which every file in that worker is charged with. `collectDependencies` walks the evaluated import graph from those roots, so a module cached by an earlier file in a non-isolated worker is still attributed through the import edges.

Main-process side (`DependenciesCache`, `cli-api.COfZo8lK.js:6590-6800`):

- `onTestModuleDependencies(file, ids)` → `record()` stores the ids per project and file. `resolveFiles` turns ids into absolute paths, drops anything containing `node_modules`, and adds files Vite plugins attached to the module with `addWatchFile` (module-graph `importedModules` that are not in `transformResult.deps`/`dynamicDeps`).
- `recordGlobalSetup` stores the import closure of `globalSetup` (imports only, no fs reads).
- `update(specs, startTime)` runs inside `runFiles` after the pool finishes and before `onTestRunEnd` (`cli-api.COfZo8lK.js:13419`). For each project it also writes `config: { at, deps }` = the root and project `configFileDependencies` plus the env files Vite loads (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`) that exist.
- A file's record is replaced on every non-partial run, whether the file passed or failed. A partial run (`isPartialRun`: cancel, `.only`, line/id/name filters, `-t`, global or per-spec `tagsFilter`) only unions new deps into an existing record and never creates one.
- On disk: `<cacheDir>/dependencies.json`, version 2: `{ projects: { [name]: { modules: string[], config?, globalSetup?, files: { [rootRelativeTest]: { at, deps: number[] } } } } }`. Paths are relative to the root config's root. `at` is the run's start time.

What Vitest never records: `fs` reads, `process.env` reads, child processes, worker threads started by tests, anything under `node_modules`, the Node/Vitest version, and the inputs Vite reads in the main process while resolving and transforming (`package.json`, tsconfig, `import.meta.glob` matches, `define` values). The browser pool never calls `onTestModuleDependencies` (no reference in `@vitest/browser` dist), so browser test files never get a record.

### 1.2 Selection (`--changed`, `experimental.vcsProvider`)

```ts
interface ModuleDependency { file: string; recordedAt?: number }
interface ModulesResolver { getDependencies(): Promise<ModuleDependency[]> }
interface VCSProviderOptions { root: string; changedSince?: string | boolean; resolver: ModulesResolver }
interface VCSProvider { findChangedFiles(options: VCSProviderOptions): Promise<string[]> }
```

`filterTestsBySource` (`cli-api.COfZo8lK.js:10809-10845`):

1. With recording on, the resolver is `RecordedModulesResolver`. `getDependencies()` returns every recorded module of the run's specs plus project `config` and `globalSetup` deps, each with the oldest `at` that recorded it; a spec without a record is returned with `recordedAt: undefined`.
2. `vcs.findChangedFiles(...)` returns the changed files; Vitest stores them as `config.related`.
3. Any related file matching `forceRerunTriggers` (default includes `**/package.json/**`, `**/vitest.config.*/**`, `**/vite.config.*/**`) → run every spec.
4. Empty related set (not watch mode) → run only the "failed specs", which are computed only for the built-in `MtimeVCSProvider`; a custom provider gets none.
5. Otherwise `getAffectedSpecifications(related)`: everything if the root config deps changed; per project, everything if project config deps or env files changed or `globalSetup` has no record or its deps changed; else each spec without a record, or whose record contains a related file.

Built-in providers: `git` (diff against a ref, static module graph via `AffectedModulesResolver` unless recording is on) and `mtime` (a recorded file is changed when `mtimeMs > recordedAt`; `--since-last-run` turns on `recordDependencies` + `mtime`, and previously failed specs rerun). A custom provider sees only the dependency list; it has no hook to add specs directly, so it expresses "run this test" by returning the test file itself as changed.

### 1.3 End-of-run ordering

In `runFiles` (`cli-api.COfZo8lK.js:13404-13428`): pool runs → `cache._update` writes `dependencies.json` → `generateCoverage` → `_checkUnhandledErrors` → `_testRun.end` (reporters' `onTestRunEnd(modules, errors, reason)`) → `reportCoverage`, where thresholds set `process.exitCode = 1`. `reason` is `passed` when every module passed, independent of unhandled errors. A reporter therefore cannot know the final exit code inside `onTestRunEnd`: coverage thresholds are decided after it, and `dangerouslyIgnoreUnhandledErrors` changes how errors map to the exit code.

## 2. How the plugin works

Entry (`index.ts`):

- `config()` sets `experimental.recordDependencies: true`, `experimental.vcsProvider: TreeSnapshotProvider`, and a `HashShardSequencer` unless the user configured one (then wraps it with `stableShards`).
- `configureVitest()` restores the Actions cache bundle into `cacheDir` (once), turns on `config.changed` and sets `passWithNoTests = true` (`index.ts:131`), prepends `record-reads` to every non-browser project's `setupFiles` (`index.ts:141`), and adds the `SnapshotRecorder` reporter.

Read recording (`record-reads.ts`): a setup file wraps `fs` read functions (`access`, `copyFile`, `lstat`, `open`, `opendir`, `readdir`, `readFile`, `readlink`, `realpath`, `stat`, their sync and promise forms, `existsSync`, `createReadStream`, `cp`/`cpSync` as recursive reads) and adds the absolute path to `__vitest_worker__.dependencies`, skipping paths with a `node_modules` component. It loads `fs` with `require` and calls `syncBuiltinESMExports` (or the vm pools' per-context resync) so named ESM imports see the wrappers. The reads land in Vitest's own record, so they flow through `dependencies.json` and `RecordedModulesResolver` unchanged.

Snapshot (`affected.ts`, `SnapshotRecorder.onTestRunEnd`): after a run with `reason === 'passed'` (`affected.ts:683`) that covered every test file the shard owns (ran, or deselected by the provider), it writes `blacksmith.json`:

- `tree`: an anchor of every path the records name, plus every lockfile in the worktree, plus files matched by `dependencies` rules. Each entry is `<mode> <blob sha>` from `git hash-object --stdin-paths` over paths that `git ls-files --cached --others --exclude-standard` lists; a directory is a hash of its recursive non-ignored listing; a submodule is its HEAD; ignored or missing paths get no entry.
- `tests`: a Bloom filter of covered test files; `head`, repo-relative `root`, `shard`, project names.

It then uploads `dependencies.json` + `blacksmith*.json` as a gzipped bundle to the Actions cache under `blacksmith-vitest-v5-<sha1(root, projects)>-<i>of<n>-<HEAD>`.

Selection (`TreeSnapshotProvider.findChangedFiles` → `select`, `affected.ts:293-417`): no snapshot, or a different root/shard/project set → everything. Otherwise re-anchor the same paths now, diff against the stored tree, and return: changed paths, plus test files that have no record or are not in the Bloom filter, plus test files mapped by triggered `dependencies` rules. Any changed lockfile → everything (`affected.ts:388`). It also computes `deselected` (recorded tests none of whose deps changed) so the recorder can count them as covered.

Sharding (`sequencer.ts`): `sha1(relative path) % count`. Vitest hands `shard()` the post-selection specs, so position-based slicing would move tests between shards as the selection changes; the hash keeps each test in one shard so each shard's snapshot only vouches for its own tests.

Cache (`cache.ts`): speaks the Actions cache twirp API at `ACTIONS_RESULTS_URL` from inside the Vitest process. Restore asks for the exact key `<prefix><HEAD>` with `restore_keys: [prefix]` (`cache.ts:106`).

Shadow mode: runs everything, computes what select mode would have run, and logs failing files outside that set.

## 3. What it got right

- **Dynamic, file-level records.** In the t3code mutation campaigns it missed one of 726 failing (mutation, test file) pairs on server/packages, a child-process case, and none of 21 failing test files on web/shared. Static `--changed` listed 17 tests the plugin did not select; each was shown not to load the changed module at runtime. Runtime records select fewer files than the static graph, and conditional and dynamic imports are covered.
- **Content comparison, not mtime or commit diff.** Comparing blob hashes makes selection correct for local dirty trees and makes an honest cache entry from any commit usable.
- **`fs` reads in the worker** go into Vitest's own record, so negative lookups (`existsSync` on a missing file), directory listings and fixtures count. The ESM namespace resync and vm-pool handling are details a new recorder must also get right.
- **Reuse of Vitest's resolver/selection** for config, env-file and `globalSetup` handling rather than reimplementing it.
- **Partial runs never advance the record** for `-t`, `--project` (separate anchor per project set) and file filters.
- **Overhead** is small: median 0.27 s restore, 0.45 s hash+select, 0.63 s save per invocation.
- **Shadow mode** as an evaluation tool: run everything, report what selection would have missed.

## 4. Failure modes, root causes, and requirements

Each item: what goes wrong, the root cause in the code, and what the new design must do so the failure cannot exist.

### 4.1 A run that exits 1 on unhandled errors saves a passing snapshot

- Cause: `onTestRunEnd` checks only `reason === 'passed'` and ignores the `errors` argument (`affected.ts:683`). Coverage thresholds are evaluated after `onTestRunEnd` (§1.3), so even checking `errors` would not cover them.
- Evidence: CI run 42898606111 attempt 1 saved and exited 1; attempt 2 restored it, selected 0 of 7, exited 0.
- Requirement: a test file's "passed" record is committed only when the whole invocation exits 0. Decide that outside Vitest's reporter phase: either a wrapper process that runs Vitest and commits records after reading its exit status, or a `process.on('exit')` hook that reads `process.exitCode`. Unhandled errors with no owning test file invalidate every record from that run. A file Vitest attributes an error to (`module.errors()`) is failed.

### 4.2 `package.json` and tsconfig changes are not detected

- Cause: Vite reads them in the main process during resolution and transform, so they never enter a worker's record. The anchor contains only recorded modules, lockfiles and rule matches (`affected.ts:174-206`), and only anchored paths can be reported changed, so Vitest's `forceRerunTriggers` (`**/package.json/**`) never sees them either. In Vite 8 / Rolldown, tsconfig and `exports` resolution run in Rust (oxc-resolver), so JS-level `fs` hooks in the main process would not see them either.
- Evidence: `packages/contracts/package.json` exports edit → provider-core 0 of 22 selected, 11 fail; `apps/web/tsconfig.json` paths → 0 of 348, 14 fail; `tsconfig.base.json` `useDefineForClassFields` → 0 of 23.
- Requirement: model resolution and transform inputs per module explicitly. For each recorded module: the tsconfig file used to transform it and its `extends` chain; the nearest `package.json` of the module (`type`, `imports`, `exports` self-reference); for each import the module made, the `package.json` that resolution consulted (bare specifiers resolve through the target package's manifest). Record these as dependencies of every test that loaded the module. Prefer reading them from the resolver if it exposes file/missing dependencies; otherwise derive them deterministically (nearest manifest walk, tsconfig `extends`/`references` chain). Changed manifests must also be reported to Vitest so `forceRerunTriggers` behaves as configured, or the new tool must apply the same rule itself.

### 4.3 Node version and environment are not part of the identity

- Cause: the cache key is snapshot version, root, projects, shard and HEAD (`cache.ts:33`); selection compares file hashes only. `process.version`, platform, arch, Vitest version and env values play no part. Env files are git-ignored, so even the anchor cannot see them (§4.6). A custom provider also gets no "rerun previously failed specs" behavior (§1.2 step 4), so a test that failed for an environment reason is skipped next time.
- Evidence: Node 26 → 22 selected 0 of 60, `ProjectionStore.test.ts` fails; `T3_MOBILE_TEST_PLATFORM=android` 0 of 292, 3 fail; `.env.local` `VITE_HTTP_URL` 0 of 348, 2 files fail; root `engines.node` bump selects nothing.
- Requirement:
  - Every record carries a runtime identity: `process.version`, `process.platform`, `process.arch`, the Vitest/vite-plus version, and the test-select version. Mismatch → the record is not usable.
  - Environment reads are recorded per test file: wrap `process.env` in the worker (a Proxy recording `get`/`has`/`ownKeys`) and record name → value hash, including absent names. Values that reach the code through Vite at transform time (`define`, `import.meta.env.*`, `loadEnv` results) are main-process inputs of the module and are recorded with it (§4.2), including env files whether or not git ignores them.
  - A test file whose last result was failed runs until it passes, whatever its inputs.

### 4.4 Files that child processes read are not recorded

- Cause: `record-reads` wraps `fs` only inside the Vitest worker; children (`node`, `tsx`, shells) are invisible.
- Evidence: `acp-mock-peer.ts` fixture broken → 0 of 6, 13 tests fail; `apps/server/src/bin.ts` broken → `cliCompileCache.test.ts` skipped on shard 2/8; the only miss in the server mutation campaign. The `dependencies` workaround matched patterns against config-root-relative paths, silently matched nothing for `../../packages/*`, and could not cover ignored files.
- Requirement: record what child processes read and attribute it to the test file that spawned them.
  - Node children: propagate a recorder through `NODE_OPTIONS=--import=<recorder>` and a per-test-file side directory named in an env var set by the worker before each file. The recorder registers `module.registerHooks` (resolve/load) and the same `fs` wrappers, and writes its reads at exit. `NODE_V8_COVERAGE=<dir>` is a second, independent signal: Node writes one JSON per process (including grandchildren) listing every script URL it compiled.
  - Spawns with an explicit `env` that drops these variables, and non-Node executables, must be detected (wrap `child_process` in the worker, with the same ESM resync the plugin used for `fs`) and handled: inject the variables, or mark the test file as having unrecorded inputs so it always runs. Never silently skip.
  - Any manual declaration mechanism must match patterns against the same normalized repo-relative paths it is evaluated on, and fail on a rule that matches no file.

### 4.5 A run that finds no test files passes

- Cause: `passWithNoTests = true` is set whenever selection is enabled (`index.ts:131`), so a broken `include` exits 0 and writes a snapshot.
- Evidence: `include: ["nomatch/**/*.test.ts"]` exits 0 in select mode, 1 otherwise; t3code mobile and client-runtime scripts rely on that exit code.
- Requirement: never change `passWithNoTests`. When the selection is empty, the tool itself exits 0 without starting Vitest (this also saves Vitest startup), and only after confirming the include globs matched at least one file. When globs match nothing, defer to the user's configuration.

### 4.6 Git-ignored files are never hashed

- Cause: `anchorTree` keeps only paths `git ls-files --exclude-standard` lists (`git.ts:102`); rule expansion uses the same list (`affected.ts:182`). Ignored inputs (`dist/`, `.env*`, `.generated/`) recorded by a test have no anchor entry, so edits to them are invisible.
- Evidence: a rule naming `../../.env.local` still selected 0 of 348; probes under `dist/`, `.env.*`, `.generated/` all skipped.
- Requirement: identity of a recorded path comes from the file itself, not from git's view. Tracked, unmodified files can take their blob id from git's index or tree (free); every other recorded file in the repository (untracked, ignored, modified) is hashed from raw bytes, streamed. Directory listings record exactly what the read returned (names, non-recursive for a non-recursive `readdir`), including ignored entries.

### 4.7 The cache restore takes the newest entry from any branch

- Cause: restore asks for `<prefix><HEAD>`, which never exists on a first attempt (a PR merge commit or a new push), then falls back to `restore_keys: [prefix]`; on Blacksmith that returns the newest entry from any branch (`cache.ts:96-130`).
- Evidence: PR #7 restored PR #9's entry; shards of one no-op run restored entries from two different commits; a push to `bsv/main` restored PR #8's entry. With `base-exact-restore.patch`, all 517 restores came from the base.
- Impact: correctness holds for honest entries (content comparison), but the baseline and therefore the selected set vary run to run, and any job that can write the key decides what other branches skip.
- Requirement:
  - Records are positive, content-addressed evidence per test file ("file F passed with exactly these input identities under this runtime identity"). Their validity never depends on which branch wrote them.
  - Restore by exact keys only: the base commit (`pull_request.base.sha`, or `before` on push), then its first-parent ancestors up to a bound. No prefix fallback across branches.
  - Only trusted refs (pushes to protected branches) write the shared cache; PR runs read it and keep their own results PR-scoped. Document the trust model.

### 4.8 Browser-mode tests rerun on every run

- Cause: the recorder is not installed in browser projects (`index.ts:141`) and `@vitest/browser` 5.1.0 never reports module dependencies, so every browser file is "uncovered".
- Evidence: every `apps/web` select run logged `193 test files not covered`; Test Web took at least 47 s in every plugin run; component edits covered only by browser tests selected 194 of 541.
- Requirement: produce per-test-file records for browser tests. Candidate signals (§5): the browser Vite server's client-environment module graph, the iframe's own resource list, or CDP precise coverage per file under Playwright/Chromium. Browser-side `fs` access goes through server commands (`readFile` etc.), which can be recorded server-side.

### 4.9 A change to any lockfile in the worktree reruns everything

- Cause: every `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock*` anywhere in the worktree is anchored (`affected.ts:180`), and any change returns "everything" (`affected.ts:388`). The lockfile is a coarse proxy for `node_modules`, which neither Vitest nor the recorder records.
- Evidence: a vendored `.repos/.../bun.lock` no test reads made shared and effect-acp rerun everything.
- Requirement: record third-party code actually loaded instead of a lockfile proxy. Under pnpm, a loaded module's realpath is `node_modules/.pnpm/<name>@<version>[_<peers>][_patch_hash=...]/node_modules/<name>/...`; the package directory name is the identity of that installed package, including peers and patches (t3code has 36 patched package directories). Record the set of package directories each test file loaded (worker and children). A lockfile change then reruns only tests that loaded a package whose directory identity changed. Lockfiles outside the workspace being tested are irrelevant.

### 4.10 Low-priority items from the report

| Item | Cause | Requirement |
| --- | --- | --- |
| Run-end hashing | The anchor is computed at the end of the run, after tests may have rewritten inputs or a developer edited files | Capture identity when the input is read (or stat at read and re-verify at file end); if an input changed during the file's run, do not record a pass |
| Partial records after a failure | Vitest replaces a failed file's record with the shorter list it reached; the plugin pairs it with the last passing anchor | Records are per file and written only for files that passed; a failed file keeps no "pass" record and runs until it passes |
| `tagsFilter` advances the snapshot | `isPartialSpecification` checks per-spec filters and `coveredTests` checks the global name pattern, but neither checks the global `tagsFilter` (`affected.ts:420-428`) | Treat a run as partial exactly when Vitest's `isPartialRun` does (it includes global and per-spec tag filters) |
| Bloom filter false positives (2.0e-3 at 1 entry) | Double hashing repeats indexes (`bloom.ts:71-80`) | No probabilistic membership; exact sets |
| Symlink target edit | Anchor hashes the link text only | Record both the link and its resolved target's identity |
| New `import.meta.glob` match | Glob expanded in the main process; match set not recorded | Record each glob call (pattern, base, options) per module and re-expand it at selection; compare match sets |
| New resolution candidate (`foo.js` beside `foo.ts`, `__mocks__/`) | Failed probes in the main-process resolver are not recorded | Record the resolver's missing-file probes, or, for relative specifiers, the set of candidate names in the directory resolution searched |
| `node:sqlite` fixture row change | Native code opens the file without `fs` | Wrap known native file openers (`node:sqlite` `DatabaseSync`, `new Worker(path)`); child processes covered by §4.4 |
| CRLF-only edit | `git hash-object` applies clean filters | Hash raw bytes for modified/untracked files |
| Repo-root file named `toString` | Plain object lookup | `Map` or null-prototype records |
| Path containing a newline | Newline-delimited git I/O | NUL-delimited or no git I/O for path lists |
| Record growth (11.6 MB, 99% outside the repo) | Records only grow; reads of test-created temp files are recorded | Replace a file's record on each full pass; ignore paths the test itself created or wrote during the run and paths under `os.tmpdir()`; paths outside the repo that are true inputs belong to the environment identity |
| Directory reads anchored recursively | A non-recursive `readdir` is anchored by its recursive listing | Record the listing the call returned |
| Local snapshot not partitioned by shard | One `blacksmith.json` per project set | Per-file records are shard-independent; shards can be assigned over the selected set freely |
| One-file-per-process runners never select | Filtered runs never write a snapshot | File filters are not partial; per-file records work for any subset |
| CommonJS configs fail | ESM-only default export | Ship an entry that loads from CJS configs, or keep the Vitest-side hook minimal and put logic in a CLI |

Also from `source-patch-review.md`, regressions a new hasher must not have: whole-file reads (stream instead), failure at 2 GiB, and hard-coded SHA-1 in SHA-256 repositories (use git's object format when reusing git ids; any private hash for non-git identities is fine).

## 5. Runtime signals the plugin did not use

| Signal | What it gives | Cost / caveats |
| --- | --- | --- |
| V8 precise coverage per test file (`node:inspector` `Profiler.startPreciseCoverage({ callCount: false, detailed: true })`, `takePreciseCoverage` after each file; what `@vitest/coverage-v8` does in workers) | Executed functions and blocks per script, per test file. Allows sub-file selection: a test that loaded a changed module but executed none of the changed functions, with the module's top-level code unchanged, cannot change outcome | Overhead must be measured on t3code. Ranges are in transformed code; map through Vite's source maps (or compare at the transformed-code level). Top-level code always runs. Reflection on source text (`fn.toString()`), class field initializers and decorators need care |
| `NODE_V8_COVERAGE=<dir>` inherited by child processes | One JSON per Node process (children and grandchildren) with every script URL compiled, written at exit | Lost if a spawn passes an `env` without it, or if the process is killed with SIGKILL. Scripts only, not `fs` reads |
| `NODE_OPTIONS=--import=<recorder>` inherited by child processes; worker threads inherit `execArgv` | Full module + `fs` + env recording in Node children | Same `env` caveat; must not change program behavior |
| `module.registerHooks` (sync resolve/load hooks, in-thread) | Resolution results and misses for native imports in children and in `viteModuleRunner: false` mode | Node 22.15+/23.5+ |
| Vite module graph (`environment.moduleGraph`): `transformResult.deps`, `dynamicDeps`, `importedModules`, `watchFiles` (`addWatchFile`) | Server-side import edges per module, including browser mode's client environment | Edges are shared across test files; per-file attribution needs a root (the test file) and the dynamic imports actually taken |
| Browser iframe resource list (`performance.getEntriesByType('resource')` in the tester iframe) or CDP coverage under Playwright Chromium | Modules a browser test file actually loaded | Needs a hook in the browser setup file or provider; to be verified on `@vitest/browser` 5.1.0 |
| Vite resolver/transform inputs (`configFileDependencies`, tsconfig chain per file, `loadEnv` files, `define`) | Main-process inputs per module or per project | Rust-side resolution is not visible to JS `fs` hooks; enumerate deterministically or use resolver-reported file dependencies |
| Vitest results cache (`vitest.cache.getTestSpecificationResult(spec)`: `failed`, `duration`) | Previously failed files (rerun until pass) and per-file durations | Durations allow balancing shards over the selected set |
| Process-tree syscall tracing (vite-plus' task runner ships `fspy`, a Linux `seccomp_unotify` file-access tracer that also tracks env reads; t3code's `test:cached` uses it through `cache.input: [{ auto: true }]`) | Every file any process in the tree opened, any language, including the main process (catches `package.json`, tsconfig, ignored files, children) | Per process, not per test file: `test:cached` gets attribution by running one Vitest process per group of files, paying startup each time. Whether a JS API is exposed in vite-plus 1.5.1 is unverified |
| Transformed-code hash (oxc transform of a changed TS file) | Type-only and comment-only TS edits produce identical runtime JS | Line/column shifts can change stack traces and source-mapped output a test asserts; only safe where positions cannot reach the outcome |

## 6. Performance observations relevant to a new design

- Selection overhead must stay near the plugin's 1.4 s per invocation or lower. The plugin re-hashed every anchored file with `git hash-object` each run; reusing git's index/tree ids for unmodified tracked files avoids most of that I/O.
- A shard that selects nothing still paid about 30 s (checkout, install, Vitest startup). Selection should run as a separate, cheap step that needs only git, Node and the records (no `pnpm install`), and produce the job matrix, so empty jobs never start and shard count follows the selected work.
- Stable hash sharding existed only because records were per shard. With per-file records, shards can be balanced by recorded durations over the selected set.
- Today's t3code CI (`changes` gating + `test:cached`) already captures much of the server-shard gain; the plugin's wins were in the unsharded package job (Test step 47-85% faster) and were lost on lockfile, root-config and browser changes.
- Root `vite.config.ts` and everything it imports are project `config` deps in Vitest, so editing any of them reruns the project (r03). Comparing the resolved test configuration plus the plugin code actually used for transforms, instead of config source files, would narrow this; plugin code changes still affect every module that plugin transformed.
- Runner variance on Blacksmith was up to 2x for identical selections; benchmarks need repeated runs.

## 7. Requirements summary

1. Per-test-file, content-addressed pass records; no run-wide anchor, no Bloom filter.
2. Commit records only after the invocation exits 0; failed files rerun until they pass.
3. Input identity covers: worker imports and `fs` reads (including ignored files and directory listings as returned), main-process resolution/transform inputs per module (manifests, tsconfig chain, glob match sets, resolution misses, `define`/env), env vars read, third-party packages loaded (pnpm package directory identity), child-process and worker-thread reads, snapshot files, and runtime identity (Node, platform, arch, tool versions).
4. Inputs that cannot be recorded make the file always run, never silently skip.
5. Browser tests get records.
6. Exact-key cache restore from the base commit and its ancestors; writes only from trusted refs.
7. Never alter `passWithNoTests`; empty selections exit without starting Vitest.
8. Selection runs without installed dependencies and emits the work to run, so CI can skip or size jobs.
