# Design 2: static-first selection

Proposal for `packages/test-select`. Angle: port ripple's declaration-level graph to TypeScript on `oxc-parser`, model t3code's run-everything inputs one by one, and use runtime recording only for what the static graph cannot see. Read with `research/ripple.md`, `research/plugin.md` and `research/t3code.md`; "ripple §5" and similar point into those notes. Findings issues are numbered as in `/home/jh/src/artifacts/useblacksmith-vitest-findings.md`.

## 0. Summary

- The static graph decides for code. A change to a module selects a test only when it changes a declaration, a resolution result or an evaluation order that the test can reach. Type-only, comment-only and unreached edits select nothing.
- Runtime recording decides for everything the code reads that is not code: data files, directory listings, environment variables, installed package identities, files read by child processes, and modules loaded by paths the static graph could not resolve. Every recorded observation is compared by content against the head tree.
- A test may be skipped only if it has a passing record from a trusted run on the base commit, or on one of its first-parent ancestors, and no static or recorded input changed since. Without a record, the test runs.
- Records are per test unit (project, file) and content-addressed. They are written only after the Vitest process exits 0. Only pushes to the protected branch publish them, as a run artifact, and a PR finds them by the exact base SHA through the GitHub runs API, never by prefix.
- A `plan` job computes the selection before any `pnpm install`. It emits one file list per job and shard, sizes the server matrix to the selected work, and skips jobs with nothing selected. Each job checks the environment again before it starts Vitest.

## 1. What "affected" means

Terms:

- A **test unit** is a (project, test file) pair. A file collected by two projects is two units.
- A **world** is everything one execution can read: files in the checkout (tracked, untracked and ignored), installed packages, environment variables, the Node binary, the OS, and executables on `PATH`.
- An **observation** is one fact an execution reads from its world, with the value it read: a declaration's code, a resolution result, a file's bytes, a file's absence, a directory's entries, an environment variable's value or absence, an installed package's identity, the runtime identity.

**Definition.** A test unit `u` is affected by a change from base world `W_A` to head world `W_H` if and only if one of these holds:

1. `u` has no valid passing record at `A`. This covers new units, units that failed, and units whose run could not be fully recorded.
2. Some observation in `S(u, W_A) ∪ S(u, W_H)` has a different value in `W_H` than in `W_A`. `S` is the set of observations the static model says `u` can make (§3), computed in both graphs.
3. Some observation in `R(u, A)` has a different value in `W_H`. `R` is what `u`'s last passing run actually observed beyond `S` (§4). An observation whose head value cannot be computed counts as different.

If a test is not affected, its outcome cannot change, provided three assumptions hold:

- **Determinism.** Identical observations give identical outcomes. Time, randomness, network and races are outside the model.
- **Isolation.** Test files do not observe each other. t3code runs every project with Vitest's default `isolate: true`, which starts a fresh worker per test file (`cli-api.COfZo8lK.js:11319`). External shared state such as fixed ports or fixed paths outside `os.tmpdir()` is not modeled.
- **Complete recording.** The recorder sees every observation in the Node processes it runs in. Observations in other processes are covered by the static model or by the tool policy (§4.5), or they make the unit unrecordable.

**Why (3) is sound.** Compare the head execution with the recorded base execution. They proceed identically until the first observation whose value differs. That observation was made by the base run, so it is in `R(u, A)`, or the static model predicted it and it is in `S(u, W_A)`. Either way the difference is detected. Negative observations, such as a missing file, an absent variable or a directory's entries, are recorded for the same reason.

**Why (2) as well.** Recording at file granularity would select every test that loaded a changed module. The static graph narrows this to tests that reach a changed declaration. It also covers observations the recorder cannot make:

- resolution and transform inputs that Vite reads in its main process, partly in Rust;
- browser module loads;
- child-process entry points named by a path string;
- `import.meta.glob` match sets.

**Why records are still required to skip.** The static graph cannot prove that code never reads a file or a variable. Packages are opaque, and paths can be computed. A passing record is the evidence that, for this unit, every observation outside `S` is listed and was compared. For most units the part of the record beyond `S` holds only data reads; module changes are decided statically.

## 2. Architecture

```text
plan job (no install)                                              test jobs                         commit-state (push to main only)
  git ls-tree A, H ─┐                                                vp install (filtered)             download record artifacts
  state(A) artifact ┼─ snapshots ─ facts ─ link A, H ─ select ─ plan.json ─ test-select run ─ vp test run <files>   + carry forward state(A)
  pnpm-lock A, H ───┘                                                │  recorder in every Node process  ─> state(H) artifact
                                                                     └─ exit 0 ─> records artifact
```

| Module         | Responsibility                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/snapshot` | Lists a tree with `git ls-tree -r -z --full-tree`, reads blobs with `git cat-file --batch` (adding `--filters` for paths with conversion attributes such as `*.cmd eol=crlf`), and in local mode overlays the working tree. Excludes `.repos/`. Uses `git rev-parse --show-object-format` for ids. |
| `src/analyze`  | Parses each module with `oxc-parser` into `FileFacts` (§3.2). Cached by blob id.                                                                                                                                                                                                                   |
| `src/resolve`  | `TreeResolver`, an in-memory resolver over a snapshot that records which manifests, tsconfig files and missing candidates each resolution consulted (§3.3).                                                                                                                                        |
| `src/graph`    | Links facts into the declaration graph (CSR adjacency, reverse adjacency), computes seeds, and runs the reverse closure (§3.4, §6).                                                                                                                                                                |
| `src/inputs`   | Explicit inputs: project manifests, config closures, lockfile per-package diff, tsconfig emit options, toolchain identity, Tailwind roots (§3.7).                                                                                                                                                  |
| `src/record`   | Recorder loaded with `--import` into every Node process of a test run (§4).                                                                                                                                                                                                                        |
| `src/vitest`   | Vite plugin `testSelect()` for node and browser projects. It stages per-file results and never commits them (§8).                                                                                                                                                                                  |
| `src/state`    | State format, Effect `Schema` parsing, zstd compression, artifact lookup, carry-forward merge (§7).                                                                                                                                                                                                |
| `src/cli`      | `plan`, `run`, `commit-state`, `why`, `replay`, `shadow`.                                                                                                                                                                                                                                          |

Every external input is parsed with `Schema`: state files, `dependencies.json`, recorder output, lockfiles, manifests, tsconfig files and CLI arguments. A parse failure gives "unknown", and unknown means run.

## 3. Static analysis

### 3.1 Snapshots

- **CI.** Base `A` and head `H` are both read from git objects. The plan job checks out with `fetch-depth: 2` and `filter: blob:none`. It fetches, in one batch, only the blobs that are not in the facts cache: changed files, new files, manifests and the lockfile. When `A` is an older ancestor (§7.3), the plan job fetches that commit's trees the same way.
- **Local mode.** `H` is the working tree. Tracked files whose index stat is clean use their index blob id. Every other file is hashed by streaming its raw bytes in git's blob format, so identities from the two sources compare equal.
- **What gets parsed.** Module files are `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` and `.jsx`. Every other path is an asset. `.repos/` is outside every snapshot, so its tests, lockfiles and sources are invisible (findings issue 9).

### 3.2 File facts

Ported from ripple `analyze.rs` (ripple §3 to §8). Per module:

- **Declarations and members.** Top-level `function`, `class` and `let`/`const`/`var` statements, `export default`, members of object literals (including through `as`, `satisfies` and pure wrappers), and static and instance class members. `erasableSyntaxOnly` is on in t3code, so enums, runtime namespaces and parameter properties do not occur. A parse that finds one is a parse error (§10).
- **References.** Value references to top-level bindings and imports, resolved through a scope walker written over the ESTree AST. `oxc-parser` exposes no semantic model, so this is the largest piece of new code. It is tested on fixtures for shadowing, hoisting, `catch` bindings, class scopes and labels, and on the t3code corpus: every reference to an import binding must be attributed to some declaration.
- **Imports and elision.** Elision follows Vite's behavior under the tsconfig that applies to the file: `verbatimModuleSyntax` and `preserveValueImports` (ripple §13). In t3code only `import type` and `export type` are erased. `import { type X }` and `import { A }` with `A` used only as a type still load the module. A test asserts this rule against `transformWithOxc` for every form in the corpus.
- **Load-time effects.** Escape analysis, the impurity fixpoint, pinned declarations, `order`, and the module-state writes, ported as described in ripple §5 and §6. One addition: a binding initialized from module state counts as that state, which closes ripple's aliased-write gap conservatively.
- **Effect-aware purity** (ripple idea 7), as configuration with tests:
  - pure namespaces with per-method exceptions: `Effect.run*`, `Layer.launch`, `ManagedRuntime.make` and `Runtime.run*` run code;
  - curried pure calls, such as `Context.Service<…>()("id")` and `Effect.fn("n")(…)`;
  - callbacks that pure combinators defer: `Effect.gen`, `Effect.sync`, `Effect.suspend`, `Layer.effect`, `Layer.scoped`, `Schema.transform*`.

  Every entry has a fixture showing that a load-time `Effect.runSync` or `Effect.runFork` still pins its declaration. A wrong entry is a recall bug, and §4.4 checks for it at runtime.

- **Strings that name paths** (ripple §8):
  - relative and alias path strings outside import specifiers;
  - `new URL("./x", import.meta.url)`;
  - `path.join(import.meta.dirname, "…")` when every argument is a literal;
  - root-relative strings;
  - computed templates with a static folder prefix;
  - test data folders.

  A string that names a module is a dependency on that module's surface and its load closure. This is how child-process and worker entry points such as `acp-mock-peer.ts` and `apps/server/src/bin.ts` are covered without recording. A string that names a folder or a data file is an asset read.

- **Other references the graph needs:**
  - `vi.mock("./x.ts", …)`, `vi.importActual` and `vi.importMock` are path strings to `x`.
  - `?raw`, `?url` and `?worker` imports are asset or module edges.
  - `require("…")` with a literal, and `createRequire(import.meta.url)("…")`, are load edges. That is how `apps/mobile/vite.config.ts` loads `babel.config.js`.
  - `import.meta.glob(pattern, opts)` with literal arguments is recorded as a glob node. The pattern is expanded in both snapshots, and the match set is compared.
- **Opaque sites.** These are `import(expr)` with an expression, `require(expr)`, `new Worker(expr)`, `import.meta.glob` with non-literal arguments, and computed member access with a non-literal key on module state. Each is recorded with its static prefix, if any. A test that reaches an opaque site depends on the modules matching the prefix. With no prefix, it depends on whatever its record shows was loaded there (§4.4), and without a record it runs.
- **Position sensitivity.** A declaration that reads `.stack`, calls `Error.captureStackTrace`, sets `Error.prepareStackTrace`, or calls `toString()` on a function value marks the module position-sensitive (§3.5).
- **`.only`.** A test file containing `.only` is flagged so its run is never recorded (§8.4).

`FileFacts` are keyed by `(blob id, parser mode, analyzer version, hash of the analysis-relevant tsconfig options)`. The analyzer version is the hash of `src/analyze` and the purity configuration.

### 3.3 Resolution

`oxc-resolver` reads the real filesystem, and the plan job has neither a full checkout nor the base tree on disk. `TreeResolver` therefore implements the subset of resolution t3code uses, directly over a snapshot:

- relative paths, with Vite's extension list and TypeScript's `.js` to `.ts` rewriting;
- workspace packages, through `pnpm-workspace.yaml` globs and each package's `exports`, `imports`, `type` and `main` fields, with per-project conditions (node: `node`, `import`, `module`, `default`; browser: `browser`, `import`, `module`, `default`; plus `development`);
- tsconfig `paths`, only for projects with `resolve.tsconfigPaths` (web);
- configured aliases (`~`);
- `__mocks__` candidates.

Bare specifiers that do not name a workspace package resolve to a **package node** keyed by package name. Packages are not analyzed.

Each resolution yields its target and the files it consulted: each manifest and the fields read from it, each tsconfig in the `extends` chain, and each candidate that was probed and missing. A change to any consulted file, or a new file at a probed candidate, makes the resolution be redone in `H`. When the target differs, the declarations that use the specifier are seeded. This replaces "any `package.json` change runs everything" with a precise rule, and it covers findings issue 2 and the `foo.js` and `__mocks__` edge cases.

`TreeResolver` is a reimplementation, so it is checked on every recorded run. The test job knows the actual resolved id of each import the test loaded, from Vitest's module graph and the recorder's resolve hook. It compares those ids with `TreeResolver` on the same tree. A disagreement flags the unit `resolution-mismatch`, which makes it always run, and it is reported as a selector bug.

### 3.4 The graph

The node kinds, edges, surfaces, `<export>` and `<export*>` nodes, re-export resolution and package nodes are ripple's (ripple §3). Differences:

- **Workspace packages are modules, not packages.** `@t3tools/contracts` resolves through `exports` to source files.
- **Package nodes carry an installed identity.** The identity is the lockfile snapshot key (`name@version(peers)`) plus integrity and patch hash (§3.7). A package node has edges to the package nodes it depends on according to the lockfile, so a test that loads `effect` also depends on `effect`'s dependencies.
- **Instance-method gating is off at first.** Reaching a class reaches all its methods. Gating is precision for classes in web and mobile and a recall risk wherever packages call methods by shape. It is enabled only if `replay` shows a measurable reduction and the shadow campaign (§13) shows no misses. When enabled, computed member access with a non-literal key counts as using every name.
- **Assets, globs, env globals and Tailwind roots are leaf nodes.** Their identity comes from content (§3.6, §3.7).

A unit's roots are:

- every declaration of its test file;
- the `<init>` of each setup file of its project, with that file's declarations;
- the `globalSetup` modules of its project;
- the synthetic project node (§3.7), which carries the config closure.

### 3.5 Hashing

Each declaration's hash covers a canonical serialization of its runtime AST:

- node types, identifier names, literal values and operators, in source order;
- the specifier and imported name of each import it references;
- for parents, the order of ordered members;
- for implicit enum values, the previous member's hash (unused in t3code).

It excludes TypeScript-only syntax (annotations, type parameters and arguments, `implements`, interfaces, type aliases, `declare`, overload signatures, the type side of `as`, `satisfies`, `!` and `<T>x`), comments, whitespace and positions. Serializing the AST rather than tokens gives the same ASI distinction ripple gets from node kinds.

**Positions.** Moving code changes stack traces and `Function.prototype.toString()`. In a module flagged position-sensitive, or one reachable from a unit whose own code is flagged, each declaration's hash also covers its line and column span and the comment text inside it. Elsewhere, edits that only move code count as no change. §12 lists the residual case.

### 3.6 Non-module inputs known statically

| Input                                                            | Node                     | Identity                                                                                    |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| Asset named by a path string, `?raw` or `?url`, or a JSON import | asset                    | blob id                                                                                     |
| Folder named by a path string, or a test data folder             | folder                   | sorted (name, mode, blob id) of its entries, recursively                                    |
| Computed path `` `./fixtures/${x}/transcript.ndjson` ``          | path pattern             | the set of matching data files and their blob ids                                           |
| `import.meta.glob` with literal arguments                        | glob                     | the match set and the blob ids of the matches                                               |
| `__snapshots__/<test>.snap` or a `resolveSnapshotPath` result    | asset rooted at the test | blob id                                                                                     |
| Tailwind root, a CSS file with `@import "tailwindcss"`           | tailwind root            | the CSS `@import` closure plus the union of candidate tokens over the root's sources (§3.7) |

### 3.7 Explicit inputs

**Projects.** Selection works on project manifests: for each Vitest project, its name, root, `include`/`exclude`, `setupFiles`, `globalSetup`, `environment`, browser provider, `resolve.conditions`, aliases, `tsconfigPaths` and config file. The run wrapper writes a manifest after loading the real config in a test job, and the state stores it keyed by a hash of the config closure. The plan job reuses a stored manifest while that closure is unchanged. When the closure changed, every unit of the project is selected, and the job loads the new config itself.

**Config closure.** Each config file is a module in the graph. The project node depends on the config's `<init>` and on its default export declaration. Through the default export it reaches the plugin objects whose hooks Vite calls later. A seed in that closure selects every unit of the project. This is declaration-level: editing a function in `scripts/lib/public-config.ts` that no config reaches selects nothing through this path. The project node also has synthetic edges to the packages the manifest implies: the environment package (`jsdom`), the browser provider (`@vitest/browser-playwright`, and through the lockfile `playwright-core`, which pins the Chromium revision) and the toolchain packages.

**Toolchain packages.** `vitest`, `@vitest/*`, `vite-plus`, `vite` and the transform packages each project uses (`@vitejs/plugin-react`, `babel-plugin-react-compiler`, `@babel/core`, `@tailwindcss/vite`), closed over their lockfile dependencies. A change in any of them selects every unit of the projects that use it.

**Lockfile.** Only the `pnpm-lock.yaml` at the workspace root is read. Per package:

- **Changed.** A snapshot key whose resolution, integrity, patch hash or peer suffix changed marks its package changed. A catalog bump, an override, `patchedDependencies` and a `file:` tarball such as `apps/mobile/deps/*.tgz` all show up as such changes. A changed tarball whose lockfile entry did not change is seeded through the `resolution.tarball` path.
- **Propagated.** A change is closed over dependents by name, as ripple §9 describes.
- **Matched to tests.** Changed packages seed package nodes, statically. A unit's record lists the packages it actually loaded, worker and children included (§4). That list is compared directly, which covers packages that are loaded only through other packages.

**tsconfig.** Only options that change emitted code are inputs:

- the module-syntax and decorator options: `verbatimModuleSyntax`, `preserveValueImports`, `importsNotUsedAsValues`, `useDefineForClassFields`, `experimentalDecorators`, `emitDecoratorMetadata`;
- the JSX options: `jsx`, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`;
- `target`, which changes the default of `useDefineForClassFields`;
- `paths` and `baseUrl`, only where `tsconfigPaths` is on.

A change to an emit option seeds every declaration of every module whose tsconfig chain has the file, since all of them transform differently. Other options (`strict`, `lib`, `types`, `noUnused*`) are not inputs. A unit test reads the installed Vite dist and fails if Vite starts reading a `compilerOptions` key that this list lacks.

**Runtime identity.** It has these parts, and a mismatch makes every record unusable:

- the Node version (exact, from root `engines.node`, which `setup-ci-deps` installs);
- `process.platform` and `process.arch`;
- the hash of the `test-select` package source and its config;
- the normalized environment template (§4.3);
- an image identity: the hash of `/etc/os-release` and the runner image version variable when one is present.

Executables are identified individually by content (§4.5).

**t3code's run-everything list** (from `ci-changes.cjs`) and what this design does instead:

| Path or change                                                              | Treatment                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any `package.json`: `exports`, `imports`, `main`, `type`, `name`, `browser` | resolution inputs, so only specifiers whose resolution changed are seeded                                                                                                                                     |
| `package.json` `dependencies*`                                              | no direct effect. The lockfile diff carries installed changes, and resolution carries workspace edges.                                                                                                        |
| `package.json` `scripts.test` of a package                                  | every unit of that package. The script sets Vitest flags such as `--project` and `--passWithNoTests`.                                                                                                         |
| lifecycle scripts (`preinstall`, `postinstall`, `prepare`)                  | everything, since the install changes                                                                                                                                                                         |
| root `engines.node`, `packageManager`                                       | runtime identity or toolchain, so everything                                                                                                                                                                  |
| any other `package.json` field                                              | an asset, for tests that import or read the file                                                                                                                                                              |
| `packages/shared/src/HostProcess.ts`, the shared setup files                | roots of every unit through `setupFiles`, at declaration level                                                                                                                                                |
| root `vite.config.ts` and its imports                                       | config closure of the root-config projects and of `apps/server`                                                                                                                                               |
| `pnpm-lock.yaml`                                                            | per-package diff                                                                                                                                                                                              |
| `pnpm-workspace.yaml`                                                       | `packages` globs feed resolution. Catalog, overrides and patches show up through the lockfile. Layout keys (`nodeLinker`, `hoist*`, `publicHoistPattern`, `shamefullyHoist`) and unknown keys run everything. |
| `patches/`                                                                  | through the lockfile patch hash                                                                                                                                                                               |
| `.pnpmfile.cjs`, `.npmrc`                                                   | everything                                                                                                                                                                                                    |
| `tsconfig.base.json`, `apps/*/tsconfig.json`                                | emit options and `paths` as above, otherwise nothing                                                                                                                                                          |
| `apps/mobile/deps/*.tgz`                                                    | the package node of the matching `file:` dependency                                                                                                                                                           |
| `.github/workflows/ci.yml`, `.github/actions/**`                            | everything, because job definitions and the environment changed                                                                                                                                               |
| `.github/scripts/**`                                                        | non-Vitest suites (§9.4) and Vitest tests that import them; `scripts/check-changed.test.ts` reaches `ci-changes.cjs` through a static `require` edge                                                          |
| other `.github/**`                                                          | nothing for `ci.yml`                                                                                                                                                                                          |
| `packages/test-select/**`, `test-select.config.ts`                          | everything                                                                                                                                                                                                    |
| `docs/` and other "inert" paths                                             | no inert list. `ConnectReachability.test.ts` reads `docs/user/t3-connect-troubleshooting.md`, and its record lists that file.                                                                                 |

**Tailwind roots.** 39 web browser tests import `~/index.css`. Tailwind's output depends on the candidate tokens found in every source file under the root that git does not ignore. A root's identity is the CSS `@import` closure plus `.gitignore` plus the union of candidates over its sources. Candidates come from `@tailwindcss/oxide`'s `Scanner`, at the lockfile's version, cached per blob. Extracting a superset of candidates would not be sound: removing a real candidate can leave the superset unchanged. The plan job therefore installs the exact scanner (§9.1). A change in the union selects the units that reach the root. Edits that only reuse existing classes do not.

## 4. Runtime recording

### 4.1 What is recorded, and where

The run wrapper adds `--import=@t3tools/test-select/record` to `NODE_OPTIONS` for the Vitest process. Every Node descendant inherits it: the Vitest main process, forked workers (or `execArgv` for threads), test-spawned `node`, `tsx` and `pnpm` processes, and Node grandchildren started by shells. Each process records:

| Signal                                                               | Mechanism                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File reads, existence probes, `stat`, `readdir`, `readlink`, streams | Wrappers on `fs`, `fs/promises` and the callback API, with `syncBuiltinESMExports()` so named ESM imports see them. Each read stores path, kind, and an `fstat`/`lstat` result (size, mtime ns, ino, mode) taken at read time. |
| Directory listings                                                   | The entries the call returned, non-recursive unless the call was recursive, with an ignored flag per entry.                                                                                                                    |
| Writes and creations                                                 | The paths the process created or wrote. Later reads of those paths are not inputs.                                                                                                                                             |
| Env                                                                  | `process.env` replaced by a `Proxy` that records `get` and `has` (name and value hash, absence included) and `ownKeys` (the sorted key-set hash). Its own variables are hidden from tests (§4.6).                              |
| Native module loads                                                  | `module.registerHooks` resolve hook. Paths under `node_modules/.pnpm/<dir>/` map to lockfile snapshot keys through `node_modules/.pnpm/lock.yaml`. Repo paths are module loads.                                                |
| Inlined module loads (Vite module runner)                            | Vitest's `experimental.recordDependencies`, read from `<cacheDir>/dependencies.json` (version 2, schema-parsed, plugin.md §1.1), including `addWatchFile` files                                                                |
| Child processes                                                      | Wrappers on `child_process` `spawn`, `spawnSync`, `exec*` and `fork` (§4.5)                                                                                                                                                    |
| Native file openers                                                  | `node:sqlite` `DatabaseSync`/`Database` constructors and `new Worker(path)`                                                                                                                                                    |
| Function coverage (workers only)                                     | `node:inspector` `Profiler.startPreciseCoverage({ callCount: false, detailed: false })`, taken at file end (§4.4)                                                                                                              |
| Browser tests                                                        | See §8.3                                                                                                                                                                                                                       |

Paths under `os.tmpdir()`, paths inside `node_modules` (recorded as packages instead) and the configured tool caches (`node_modules/.vite`, `node_modules/.vitest-cache`) are not inputs. Other paths outside the repository are recorded as outside-repo inputs (§4.3).

### 4.2 Attribution

- **Worker.** `isolate: true` gives one test file per worker, so every observation in a worker belongs to that file's unit. For a project with `isolate: false` (none in t3code), a worker's observations accumulate, and each file is charged with everything its worker observed up to the end of that file. That rule is coarse but safe against per-process caches.
- **Children.** Before tests run, the worker's setup file sets `TEST_SELECT_UNIT=<project>:<file>` and `TEST_SELECT_STAGING=<dir>`. Children inherit both. The `child_process` wrappers put them back into an explicit `env` option that drops them.
- **Vitest main process.** Observations made while loading config are attributed to the project. Observations made during transforms are attributed to the project only for paths that are neither static-graph modules nor assets the static graph attributes to units. Reads of modules and `?raw` assets stay per unit, through the graph.
- **Completion markers.** Every process writes `<staging>/<pid>.start` at startup and its observations to `<pid>.json` at exit. At file end the worker checks that each Node child it spawned left a complete record. A missing record, for example from a child killed with SIGKILL, flags the unit `unrecordable`.

### 4.3 Identities

- **Repo files.** At the end of a passing invocation, the wrapper computes identities for every recorded repo path whose `lstat` still matches the read-time stat. A tracked, clean file with no conversion attributes takes its index blob id; any other file is hashed by streaming its raw bytes in git blob format. A path whose stat changed during the run flags the unit `inputs-mutated`, and it is not recorded as passing.
- **Symlinks.** The link text and the identity of the resolved target.
- **Directories.** The listing as returned.
- **Absence.** "absent".
- **Packages.** Lockfile snapshot key plus integrity and patch hash.
- **Env.** Each value is hashed with a per-state salt, so values never appear in the state.
- **Outside-repo files** are recorded by path and content hash. The plan job compares those it can read on its own image. A path it cannot read counts as unknown, which runs the unit. The job-side check compares all of them.

**Normalized environment.** The run wrapper starts Vitest with an environment built from configuration: `env.passthrough` names copied from the outer environment, fixed `env.set` values, and `PATH` built from a template (`node_modules/.bin`, the Node and vite-plus bin directories, the system directories). The plan job builds the same environment from the same configuration. Env observations then compare equal across runners unless a test reads a variable whose value is specific to the runner or the run, and such a test runs every time, which matches the definition. t3code's server suite already passes under a filtered environment with vite-plus tasks (`test:cached`). Rollout includes one full run under the normalized environment on every project before selection is turned on.

### 4.4 Checking the static model at runtime

Each recorded run compares what happened with what the static model predicted for that unit:

| Check                                                                                                                                                    | Mismatch handling                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Every module loaded, native or inlined, is in the unit's static file closure                                                                             | The extra module becomes a whole-file runtime input of the unit, a "runtime module". Reported. |
| Every function that ran in a repo module belongs to a declaration in the unit's static reachable set, after mapping V8 ranges through Vite's source maps | The module becomes a runtime module of the unit. Reported as a static-model gap.               |
| Every resolution matches `TreeResolver`                                                                                                                  | `resolution-mismatch`: the unit always runs. Reported.                                         |
| Every package loaded is a dependency, in the lockfile, of the unit's package nodes                                                                       | The package becomes a runtime package input                                                    |

The function check catches the recall bugs specific to declaration-level selection. Suppose a load-time `register(foo)` is wrongly treated as pure: then `register`'s body runs although its declaration is not in the reachable set, and the check reports it. The same goes for a method reached through a computed name, and for an aliased write performed by a function. Top-level initializers always run, so this check cannot see a pure-looking initializer whose effect is made inside a package. That case stays in §12. The check costs best-effort coverage (`detailed: false`), which must be measured on t3code before it is on by default.

### 4.5 Child processes

At spawn time, the wrapper resolves the command through the normalized `PATH` and reads its first bytes:

- **Node**: `process.execPath`, or a `#!` line naming `node`. The child is fully recorded through the inherited `--import`.
- **Shell** (`sh`, `bash`, `-c`): transparent for Node grandchildren, which inherit the recorder. The shell's other commands are covered by the tool policy only if the command string is a literal that the policy can parse. Otherwise the unit is `unrecordable`.
- **Other executables**: the tool policy in `test-select.config.ts` gives each executable name one of these policies:
  - `none`: the tool reads nothing in the repository (`uname`, `true`);
  - `cwd`: the tool reads the tree at its working directory (`git`). Outside the repository this adds no repo inputs. Inside it, the tool depends on the whole tracked tree, so the unit always runs.
  - `args`: the tool reads the repo paths in its argv, plus the static path strings of the spawning declaration (`cc`, `pkg-config`).
  - `opaque`: the unit always runs. This is the default.

The executable's own identity, its content hash, is always recorded. t3code tests that spawn `vp` (a Rust binary that filters the environment, so its Node children lose the recorder) or `bun` are therefore `unrecordable` and always run (§12).

### 4.6 Not changing behavior

- The `Proxy` hides `TEST_SELECT_*` and the recorder's `NODE_OPTIONS` entry from tests: `get`, `has` and `ownKeys` filter them. The `child_process` wrappers re-add them to spawned environments. `--import` passed through `NODE_OPTIONS` does not appear in `process.execArgv`.
- Wrapped `fs` functions keep their `name`, `length`, promise and callback semantics and error objects. Recording failures are caught and turn the unit `unrecordable`. They never surface as test errors.
- The recorder adds no files inside the repository. Staging lives in `$RUNNER_TEMP`, or locally in `$(git rev-parse --git-dir)/test-select/`.

## 5. The change model

| Kind                                             | Counts as a change when                                                                           | Does not count                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Declaration                                      | the canonical runtime AST hash differs, or the declaration is added or removed (a rename is both) | comments, whitespace, type-only syntax, and moves, except in position-sensitive modules |
| Resolution                                       | the resolved target of a specifier differs, including package to module and package identity      | edits to a manifest or tsconfig that no resolution consulted                            |
| Evaluation order                                 | ripple's `order` and `effect_sequence` differ for a module with load-time effects                 | reordering pure declarations                                                            |
| Asset, folder, glob, path pattern, Tailwind root | the identity in §3.6 differs, existence included                                                  | edits to files outside the folder or pattern                                            |
| Package                                          | the lockfile identity differs (version, integrity, peers, patch hash), closed over dependents     | lockfiles of other workspaces (`.repos/`)                                               |
| Project config                                   | a seed reaches the config closure, the manifest differs, or a toolchain package changed           | edits in config-imported modules that the config does not reach                         |
| Recorded data input                              | the head identity differs from the recorded one, or cannot be computed                            | edits to files the unit never read                                                      |
| Env                                              | a recorded value hash differs under the normalized environment                                    | variables the unit never read                                                           |
| Runtime identity                                 | Node, platform, arch, image, `test-select` version or env template differ                         | nothing                                                                                 |
| Executable                                       | the content hash of a spawned executable differs                                                  | nothing                                                                                 |
| Membership                                       | a test file is added, or moves between projects (a config change)                                 | deleted tests (nothing to run)                                                          |

The model distinguishes code changes, which the static graph decides at declaration level, from changes to what code reads, which records decide at file level. A file that is both, such as a module some test reads as text, is handled in both roles. `apps/web/src/reactCompilerCoverage.test.ts` reads every web source with `readFile`, so its record lists every web file as a data input, and it is selected on any web source edit. The other web tests are selected only through the graph.

## 6. Selection algorithm

```text
plan(H):
  (A, state) := exact state for B = first parent of H, else the nearest first-parent ancestor with state (≤ 50 commits)
  if none, or the state header is incompatible:  RUN_ALL("no base state")
  snapA, snapH := snapshot(A), snapshot(H)
  facts := state.facts ∪ analyze(blobs in snapA ∪ snapH missing from state.facts)
  gA := state.graph if state.commit == A else link(snapA); gH := link(snapH)
  if globalReasons(snapA, snapH):  RUN_ALL(reason)              // §3.7 "everything" rows, runtime identity
  seedsA, seedsH := changedNodes(gA, gH) ∪ resolutionDiff ∪ assetDiff ∪ packageDiff ∪ orderDiff ∪ globDiff
  hitA := reverseClosure(gA, seedsA); hitH := reverseClosure(gH, seedsH)   // over reverse CSR, marks nodes
  for project P:
     if no manifest for P, or project node of P ∈ hitA ∪ hitH:  select all units of P (reason "config")
     units(P) := glob(manifest.include, manifest.exclude) over snapH      // tinyglobby, same version as Vitest
  for unit u = (P, f):
     r := state.records[u]
     reason :=
       r missing                                   -> "no record"
       r.status != passed or r.flags != ∅          -> "failed" | "unrecordable" | "resolution-mismatch" | …
       any root of u ∈ hitA ∪ hitH                 -> "static: <seed>"
       r.identity != predictedIdentity(job(u))     -> "runtime identity"
       ∃ input ∈ r.inputs: identityAt(H, input) ≠ input.identity   (unknown ≠ anything)  -> "input: <path>"
       ∃ (name, h) ∈ r.env: hash(normalizedEnv(job(u))[name]) ≠ h  -> "env: <name>"
       ∃ pkg ∈ r.packages: lockfileIdentity(H, pkg.name, pkg.key) ≠ pkg.identity  -> "package: <key>"
       ∃ exe ∈ r.executables: hashAt(planner, exe.path) ≠ exe.hash -> "executable: <path>"
       otherwise                                    -> skip
  assign selected units to jobs; shard by recorded durations (§9.2); write plan.json and job outputs
```

- With gating off, the reverse closure is exact for the graph, so there is no forward confirmation pass. With gating on, ripple's two-phase search applies (ripple §7).
- `identityAt(H, input)` in the plan job uses `ls-tree` blob ids for tracked paths and fetched blobs for paths with conversion attributes.
- A recorded ignored file that was present cannot be computed before install, so it counts as unknown. A recorded ignored path that was absent stays absent: what is created between checkout and the test step depends only on the workflow, the lockfile and lifecycle scripts, which all run everything when changed.
- For directory listings, entries flagged ignored are compared only for names in the configured install outputs (`node_modules`). Any other ignored entry counts as unknown.
- `why <unit>` prints the reason. For a static reason, it prints the shortest path from a root to the seed: declarations, specifiers and the change of each step. For a record reason, it prints the input and both identities. `plan.json` keeps every reason, so a selection can be audited from the artifact.
- Cost targets on the plan job with a warm state: `ls-tree` of both trees 0.2 s; parsing 50 to 200 changed blobs 0.1 s; linking two graphs of about 100k nodes in typed arrays 1 to 1.5 s, or half that when the state carries `gA`; reverse closure and record checks 0.3 s. That totals under 3 s, plus about 1 to 2 s for the state download. These are estimates; `bench/` must measure them before any number is quoted elsewhere.

## 7. State: records, storage and trust

### 7.1 Records

```ts
// zstd-compressed JSON, decoded with Schema; Maps and arrays only, no plain-object lookups keyed by path
type State = {
  header: {
    schema: number;
    analyzer: string;
    selector: string;
    objectFormat: "sha1" | "sha256";
    commit: string;
    runId: number;
  };
  identities: RuntimeIdentity[]; // referenced by index
  manifests: { project: string; closureHash: string; manifest: ProjectManifest }[];
  paths: string[]; // repo-relative, NUL-safe, deduplicated
  facts: { blob: string; key: string; facts: Uint8Array }[]; // the facts cache, content-addressed
  graph?: LinkedGraph; // gA for header.commit
  records: {
    project: string;
    file: number; // index into paths
    status: "passed"; // only passing records are stored
    identity: number;
    durationMs: number;
    recordedAt: string /* commit */;
    inputs: {
      path: number;
      kind: "file" | "absent" | "dir" | "link" | "outside";
      identity: string;
    }[];
    env: { name: string; hash: string }[];
    envKeys?: string;
    packages: { key: string; identity: string }[];
    executables: { path: string; hash: string; policy: string }[];
    runtimeModules: number[]; // modules outside the static closure (§4.4)
  }[];
};
```

A failed or unrecordable unit has no record at all. Selection treats "no record" as run, so a record can never vouch for a failure. Inputs that the static model already covers (modules in the closure, assets in `S`) are dropped from `inputs` to keep records small. Estimated size for 2,015 units: records 2 to 6 MB raw, facts 20 to 30 MB raw, and 5 to 8 MB together after zstd. To be measured.

### 7.2 Writing

1. **Each test job.** `test-select run` stages per-file results in `$RUNNER_TEMP/test-select/`. After each Vitest process exits 0, it moves that process's staged records to `records/`. When a process exits non-zero, it discards its staged records and the job fails. The upload step is `if: success()`, so a failing job uploads nothing.
2. **`commit-state` job.** It runs only on `push` to the protected branches (`main`, `bsv/main`), needs every test job, and runs only when all of them succeeded or were skipped by the plan. It downloads the record artifacts and `state(A)`, the state the plan used. It then writes `state(H)`:
   - units that ran: the new records;
   - units the plan skipped: their record from `state(A)` carried forward, with no changes;
   - units whose test file no longer exists: dropped;
   - facts: `state(A)` facts plus the newly analyzed blobs, minus blobs not present in `H` for 30 days.

   It uploads `state(H)` as the artifact `test-select-state` of this run (retention 90 days).

3. **Carry-forward.** The plan proved a skipped unit unaffected from `A` to `H`: its static inputs did not change, and its recorded inputs compare equal at `H`. Its record from `A` therefore still describes a passing run whose observations hold at `H`. Composed over a chain of main commits, this is the same argument as §1.

A run with any failed or cancelled job saves no state. The next push then falls back to the last ancestor with state, and its diff covers the failed commit's changes.

### 7.3 Reading and scoping

- **Exact base.** The plan job lists successful `push` runs of `ci.yml` on the protected branch (`GET /repos/{repo}/actions/runs?branch=main&event=push&status=success&head_sha=<B>`) and downloads that run's `test-select-state` artifact with `actions: read`.
- **Ancestor fallback.** When `B` has no such run (its CI is still running, failed, or expired), the plan walks `B`'s first-parent ancestors, up to 50, by intersecting them with one page of recent successful push runs. It uses the first match `A`, and the static diff is then `A` to `H`, which includes `B`'s own changes.
- **No other source.** No prefix restore, no PR-written state, and no state from another branch. A run on a PR, or on any branch other than the protected ones, never writes state. A rerun of a failed PR job reads the same `plan.json` and runs the same units, because the failed attempt saved nothing. That is the scenario of findings issue 1.
- **Trust.** State comes only from runs that GitHub records as `push` runs on a protected branch, so a PR, from a fork or the same repo, cannot plant it. Facts travel inside the same artifact, so cache poisoning cannot reach the static model either. Facts a PR computes stay inside that PR's plan job.
- **Local mode.** `test-select run` without `--plan` plans against `$(git rev-parse --git-dir)/test-select/state`. That local state is written only by local invocations that exit 0, with the local runtime identity. `test-select pull` can seed it with the main state for the merge base, through `gh run download`, and that state then needs local reruns for any unit whose identity differs. Local state never leaves the machine.

## 8. Vitest 5 integration

### 8.1 Plugin

`testSelect()` is added to the six Vitest configs t3code has: root, `apps/server`, `apps/web`, `apps/mobile`, `apps/desktop` and `packages/client-runtime`. The wrapper fails if a project lacks it. The package ships ESM and CommonJS entries, so `apps/mobile`'s CommonJS package loads it. Its `configureVitest` hook:

- sets `experimental.recordDependencies: true` and `cache: true` when `TEST_SELECT_STAGING` is set, and is inert otherwise. With the plugin present and the variable unset, `vp test run` behaves exactly as it does today.
- for node and jsdom projects, prepends the recorder's setup file. That file sets `TEST_SELECT_UNIT` and starts function coverage.
- for browser projects, prepends a browser setup file and registers the browser commands (§8.3).
- adds a reporter that stages, per test module: state, duration, errors, and whether the file contains `.only`. In `onTestRunEnd` it stages the run's unhandled errors. It never decides that anything passed; the wrapper does (§7.2).

The plugin never changes `passWithNoTests`, `include`, sequencing or sharding.

### 8.2 Run wrapper

`test-select run --plan plan.json --job <id> [--shard <i>]`:

1. **Late check.** It recomputes the checks of §6 that depend on the job's world, for the units in its scope: env values under the job's normalized environment, executable hashes, outside-repo files, `process.version`. Units that fail the check are added to the selection. The plan job's prediction can only be widened here, never narrowed.
2. **Groups.** It groups the selected units by package and config, and builds each group's command from that package's `test` script (`vp test run --project unit --project browser --passWithNoTests` for web). It appends the selected files as absolute paths, and adds `--maxWorkers` from configuration.
3. **Empty groups.** For a group with no selected files, it does not start Vitest. When the plan selected nothing for a project whose `include` matched no file at all, the wrapper runs that project's script unchanged, so Vitest's own `passWithNoTests` behavior and exit code apply (findings issue 5).
4. **Running.** It runs each group with the normalized environment, `NODE_OPTIONS=--import=…`, and `TEST_SELECT_STAGING`. Groups run in parallel up to the job's concurrency limit, matching `vp run --parallel --concurrency-limit 4` today.
5. **After each group.** It checks that the set of test modules Vitest reported equals the selected set. A missing file fails the job as a selector bug. It writes the project manifest. Then it commits or discards the staged records by exit code.

### 8.3 Browser projects

- **Static.** Module dependencies of browser tests come from the graph with browser conditions, so browser units are selected like node units. No run is needed for code selection (findings issue 8).
- **Runtime.** The browser setup file runs `afterAll` once per file and sends `performance.getEntriesByType("resource")` URLs to the `__testSelectReport` command. The server maps `/@fs/…`, `/src/…` and query-suffixed URLs to repo paths and stages them for `context.testPath`. Those paths are checked against the static closure as in §4.4.
- **Browser commands.** The plugin wraps Vitest's file commands (`readFile`, `writeFile`, `removeFile`) and t3code's own commands (`resetPointer`) to record their paths per `context.testPath`.
- **Not recorded.** No function coverage in the browser. Chromium identity comes from `playwright-core` in the lockfile, through the project node.

### 8.4 Partial runs

The wrapper records nothing for an invocation that has `-t`, `--testNamePattern`, `--tags`/`tagsFilter`, `--changed`, or a line or id filter. A file flagged `.only` is never recorded. CI sets `allowOnly: false`, so there such a file fails anyway. File-path arguments alone are not partial, so one-file-per-process wrappers such as `test:cached` still produce records.

## 9. CI integration

### 9.1 Plan job

- **Runner.** `blacksmith-2vcpu-ubuntu-2404`, the same image family as the test jobs. It replaces `changes`.
- **Steps:**
  1. Blobless checkout, `fetch-depth: 2`.
  2. Restore `~/.cache/test-select/<lockfile hash of oxc-parser, @tailwindcss/oxide, test-select deps>`. On a miss, `npm install --prefix` those few packages at their lockfile versions.
  3. Run `node packages/test-select/dist/plan.mjs`, a bundled single file, on the runner's system Node. The plan job never runs `vp install`.
- **Outputs:**
  - `run_all`;
  - per job, `test`, `test_web` and `test_server` booleans;
  - `server_matrix`, a JSON list of shards;
  - per-job setup needs: `chromium` (web), `chromium_server`, `electron` and `libsecret` (from config: units that need the Electron runtime or the libsecret helper);
  - `install_filter` per job.

  `plan.json` is uploaded as an artifact.

- **Failure.** If the plan job fails or times out, every downstream job sees `needs.plan.result != 'success'` and runs as today: the full package filter, all web projects, and a static 8-shard matrix split by `shardWeights.json` (`fromJSON(needs.plan.outputs.server_matrix || '[1,2,3,4,5,6,7,8]')`). A planner bug therefore costs time, not coverage.

### 9.2 Jobs and sharding

- **`test` (packages).** It skips when `test == 'false'`. The Electron download, the apt `libsecret` install and the Python and `node --test` suites run only when the plan says they are needed (§9.4). `vp install` may take `install-args` with the filter of the selected packages and their workspace dependencies (`setup-ci-deps` already supports `install-args`). Its tests run through `test-select run --job test`.
- **`test_web`.** It skips when nothing in `unit` or `browser` is selected. The Chromium cache restore and install steps run only when browser units are selected. When the estimated selected browser time exceeds a threshold, the plan splits the job into two shards.
- **`test_server`.** The matrix is the plan's shard list, and the job is skipped when the list is empty: the job-level `if` is evaluated before matrix expansion, which must be verified. The shard count is `ceil(estimated seconds / target seconds per shard)`, capped at 8. Files are assigned greedily by longest processing time (heaviest first, to the lightest shard). Durations come from records (`durationMs`), then `shardWeights.json`, then 0.6 s. Each shard gets an explicit file list and runs one `vp test run <files>` process, keeping `fileParallelism: false` within the shard. That removes the 57 Vitest startups per shard of `test:cached`, measured at 25 to 30 s per shard on the fork (t3code §4). Vitest's `--shard` and `WeightedShardSequencer.shard()` are not used in CI, because they reassign files whenever the full list changes.
- **`transferBudgetV2.integration.test.ts`.** It runs when selected. If `thread-transfer-report.yml` needs a report on every server run, the config marks it `alwaysRun`; that is a product choice, not a correctness one. `check` requires the `thread-transfer-results` artifact only when the plan scheduled that file.
- **`check`.** As today: every job must succeed, or be skipped with `needs.plan.outputs.<job> == 'false'`. `commit-state` is added to `needs` on push runs.
- **`commit-state`.** Push to the protected branches only (§7.2). It runs on a 2 vCPU runner and takes about 10 to 20 s, off the PR critical path.
- **Nightly `full` run.** `schedule`: all units with no selection. It publishes a fresh state, which resets carry-forward chains, and runs `shadow` (§13). Any unit that fails while a carried record vouched for it is a selection miss and alerts.

### 9.3 Latency and compute

- **PR critical path.** The plan job is on the critical path: runner pickup, plus about 3 to 5 s of checkout, 1 to 2 s of cache restore, 1 to 2 s of state download and under 3 s of planning. That is comparable to today's `changes` job. Today's server shards self-gate to avoid waiting on `changes`. Under this design they wait on `plan`, and in exchange start only as many as the selected work needs.
- **Compute.** Unaffected jobs never start. Server shards run one Vitest process each. Chromium, Electron and apt steps run only when needed. Installs can be filtered. The selection inside each job runs fewer files.

### 9.4 Non-Vitest suites

`.github/scripts/*.test.cjs` (`node --test`), `stage-preview-bundle.test.py` and the Rust tests are declared in `test-select.config.ts` as suites with input roots:

- `node --test` files are modules in the graph: their `require` edges are static.
- Python and Rust suites are path suites: they run when any file under their declared directories changes.

The plan emits a boolean per suite.

## 10. Failure handling

| Situation                                                                                                                    | Behavior                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No state for `B` or its 50 first-parent ancestors; incompatible schema, analyzer or selector version; artifact parse failure | Run everything. On a push, the resulting state seeds the next runs.                                                                                                                                                   |
| Planner exception, timeout, or git failure                                                                                   | The plan job exits 0 with `run_all=true` and the error in the summary. If it cannot write outputs, downstream jobs fall back as in §9.1.                                                                              |
| Parse error in a module in either snapshot                                                                                   | The module becomes one opaque node: a whole-file hash, with all its importers depending on all of it. Units that reach it run whenever anything changes, since its own imports are unknown. Nothing else is affected. |
| Unresolvable specifier that is not a package                                                                                 | A virtual node owned by the project config, such as a plugin-provided module. A config change selects it, and §4.4 reports what was actually loaded.                                                                  |
| `TreeResolver` disagrees with the real resolution                                                                            | `resolution-mismatch` on the unit: it always runs. Reported.                                                                                                                                                          |
| Recorder error, missing child record, unparseable recorder output                                                            | `unrecordable`: no record, so the unit runs next time.                                                                                                                                                                |
| Input changed during the run                                                                                                 | `inputs-mutated`: no record                                                                                                                                                                                           |
| Vitest process exits non-zero (failed test, unhandled error, coverage threshold, crash)                                      | Staged records discarded and the job fails. Records are never decided from reporter hooks: in Vitest, `onTestRunEnd` runs before coverage thresholds set the exit code (plugin.md §1.3).                              |
| Vitest reports a different set of test modules than selected                                                                 | Job fails as a selector bug.                                                                                                                                                                                          |
| Head identity of an input cannot be computed                                                                                 | Counts as changed, so the unit runs.                                                                                                                                                                                  |
| Run on a branch other than the protected ones                                                                                | Never writes state.                                                                                                                                                                                                   |

## 11. Findings report: how each failure mode is avoided

| Finding                                             | How it cannot occur here                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Unhandled errors still save a passing snapshot   | Records are committed by the wrapper only after the Vitest process exits 0, and only uploaded from a job that succeeded. State is written only by a push run whose jobs all succeeded. A rerun of a failed job finds nothing new and runs the same plan.                                                                                                                                                                       |
| 2. `package.json` and tsconfig changes undetected   | `TreeResolver` records the manifests, fields and tsconfig chain each resolution consulted, and resolution is redone and compared on any change to them (§3.3). tsconfig emit options seed every module they transform (§3.7). Both are decided statically, so they do not depend on a run having seen the read.                                                                                                                |
| 3. Node version and environment ignored             | Runtime identity includes Node, platform, arch, image, selector version and env template (§3.7). Env reads are recorded per unit with value hashes, in the worker, the main process and children, under a normalized environment (§4.3). Config-time env reads and `.env*` reads are project inputs whether or not git ignores the files.                                                                                      |
| 4. Files read by child processes unrecorded         | Every Node descendant runs the recorder through `NODE_OPTIONS`, with attribution variables that are put back when a spawn drops them. Completion markers detect lost records (§4.2). Child entry points named by path strings are static dependencies with their load closure (§3.2). Non-Node executables go through the tool policy, and unknown ones make the unit always run. No pattern-based `dependencies` rules exist. |
| 5. Empty test discovery passes                      | `passWithNoTests` is never touched. An empty selection does not start Vitest. A project whose `include` matches nothing runs its own script unchanged (§8.2).                                                                                                                                                                                                                                                                  |
| 6. Git-ignored files never hashed                   | Identities come from file bytes for every recorded repo path, ignored or untracked included. Listings are recorded as returned, with ignored entries. In the plan job, a present ignored input counts as unknown and runs the unit (§6).                                                                                                                                                                                       |
| 7. Cache restore from any branch                    | State is an artifact of a successful `push` run on the protected branch, found by exact `head_sha`, then by first-parent ancestors. There is no prefix fallback, and PRs never write state (§7.3).                                                                                                                                                                                                                             |
| 8. Browser tests always rerun                       | Browser units are selected from the static graph with browser conditions. Runtime resource lists and wrapped commands check and supplement it (§8.3). Tailwind roots are modeled so that a CSS-importing test is not selected by every source edit (§3.7).                                                                                                                                                                     |
| 9. Any lockfile change reruns everything            | Only the workspace-root `pnpm-lock.yaml` is read, and `.repos/` is outside the snapshot. The diff is per package, closed over dependents, and units are matched to packages statically and by recorded loads (§3.7).                                                                                                                                                                                                           |
| Run-end hashing                                     | Read-time stat, then identity at end only if the stat is unchanged; otherwise `inputs-mutated` (§4.3)                                                                                                                                                                                                                                                                                                                          |
| Partial records after a failure                     | Per-unit records exist only for passing runs. A failed unit has none and runs until it passes.                                                                                                                                                                                                                                                                                                                                 |
| `tagsFilter` advances the snapshot                  | Any filter other than file paths disables recording (§8.4).                                                                                                                                                                                                                                                                                                                                                                    |
| Bloom filter false positives                        | No probabilistic structures. Records are exact.                                                                                                                                                                                                                                                                                                                                                                                |
| Symlink target edit                                 | Link text plus the target's identity (§4.3)                                                                                                                                                                                                                                                                                                                                                                                    |
| New `import.meta.glob` match                        | Literal globs are expanded in both snapshots and compared (§3.2). Non-literal ones are opaque sites.                                                                                                                                                                                                                                                                                                                           |
| New resolution candidate (`foo.js`, `__mocks__`)    | Missing candidates are part of each resolution's consulted set (§3.3).                                                                                                                                                                                                                                                                                                                                                         |
| `node:sqlite` fixture change                        | `DatabaseSync` and `Database` constructors are wrapped. Other native addons are in §12.                                                                                                                                                                                                                                                                                                                                        |
| CRLF-only edit                                      | Raw bytes for anything not tracked and clean; `--filters` for attribute-converted paths in the plan job                                                                                                                                                                                                                                                                                                                        |
| Repo-root file named `toString`                     | `Map`s and arrays only, decoded by `Schema`                                                                                                                                                                                                                                                                                                                                                                                    |
| Path containing a newline                           | NUL-delimited git I/O everywhere; paths stored as array entries                                                                                                                                                                                                                                                                                                                                                                |
| Record growth                                       | Records are replaced on each pass. Temp paths, paths the test wrote, and modules covered statically are dropped (§7.1).                                                                                                                                                                                                                                                                                                        |
| Directory reads anchored recursively                | Listings are recorded as returned.                                                                                                                                                                                                                                                                                                                                                                                             |
| Local snapshot not partitioned by shard             | Records are per unit, independent of shards.                                                                                                                                                                                                                                                                                                                                                                                   |
| One-file-per-process runners never select           | File-path arguments are not partial (§8.4).                                                                                                                                                                                                                                                                                                                                                                                    |
| CommonJS configs fail                               | The plugin ships ESM and CommonJS entries (§8.1).                                                                                                                                                                                                                                                                                                                                                                              |
| SHA-256 repositories, whole-file reads, 2 GiB limit | git object format detected; streaming hashes                                                                                                                                                                                                                                                                                                                                                                                   |

## 12. Where this design still over- or under-selects

### Under-selection: a test whose outcome can change, skipped

1. **Outside the model.** Nondeterministic tests (time, randomness, network, races), and interference between test files through external state: fixed ports, files outside `os.tmpdir()`, global git config written by a test.
2. **Static-model errors not caught at runtime.** §4.4 cannot see a pure-looking top-level initializer whose effect happens inside a package, or package code calling a method by shape while gating is on. Purity entries need fixtures for this reason. Gating stays off until measured.
3. **Moves.** A unit asserts on source positions without any position-sensitive marker in repo code. Example: a test compares a log line containing `file:line` that an Effect span produced inside a package.
4. **Reads outside every recorder.** A native addon other than `node:sqlite` opening repo files by path; a tool given the wrong policy in config (`none` for a tool that reads repo files); a Vite plugin reading files through native code beyond the modeled resolution inputs.
5. **Image drift in skipped jobs.** The plan job compares executables and outside-repo files on its own runner. An image change that alters a library a test uses, without changing the image identity or any executable hash, is caught only in jobs that start (§8.2), not in jobs the plan skipped.
6. **Stale records after an untracked change in local mode.** `test-select pull` state from CI checked against a dirty tree: covered by content comparison, except for files the CI run could not observe, such as a local `.env.local` that only the web config reads. Those are project inputs, so they are covered.

### Over-selection: a test that cannot be affected, run

1. **File granularity of data inputs.** Editing one key of a JSON fixture selects every unit that read the file.
2. **Path-string over-approximation.**
   - Strings that only look like paths.
   - Computed patterns standing for every matching file.
   - `vi.mock` path strings to modules a factory replaces. 360 test files call `vi.mock`.
   - Dynamic `import()` edges that are not taken at runtime. The 17 tests the plugin skipped and a static scan listed fall in this class.
3. **Effect code pinned at load.** Where the purity configuration does not unpin a server module, every declaration of the module is reached by every test that loads it, which degrades to file level.
4. **Project-wide inputs.** Any reachable change in a config closure (`shardWeights.json` and the sequencer for `apps/server`, the license plugin's inputs for web), any config-time env value, and any toolchain package bump select every unit of the project.
5. **Units that always run.**
   - Tests spawning `vp`, `bun`, or shells with non-literal commands.
   - `git` with a working directory inside the repository.
   - Tests reading runner- or run-specific variables.
   - In CI, tests reading ignored files the job generates.
6. **Tailwind.** A new class token anywhere in web sources selects every unit that loads `index.css`, 39 browser tests today.
7. **Package granularity.** Any identity change of a package selects every unit that loaded it or a dependent, whatever API it uses.
8. **Units with no passing record at base.** Units that failed, are new, or ran with `resolution-mismatch` run although nothing changed.
9. **Larger diffs on fallback.** When `B` has no state, the diff starts at an older ancestor.
10. **Instance methods.** With gating off, a test that constructs a class depends on every method of that class.

## 13. Phasing and validation

Phases, each behind `shadow` before it gates CI:

1. **File level.** Snapshots, facts cache, `TreeResolver`, the elision rule, path strings, the explicit inputs of §3.7, the recorder (node, children, browser), state and CI wiring. In this phase a module counts as changed when its file-level runtime AST hash changes. That alone gives type- and comment-only skips and precise resolution handling.
2. **Declaration level.** Declarations, members and exports, Effect purity, order and state writes, and the function-coverage check. This phase ships only if `replay` shows that declaration level selects less than phase 1 on t3code history (ripple measured 13.2% to 9.1% mean on VS Code) and the mutation campaign shows no misses.
3. **Gating.** On the same two conditions.

Validation tools in `bench/`:

- **`replay`** walks first-parent history and reports, per commit, the share of test time selected under package level (`ci-changes`), file level, phase 1 and phase 2.
- **`shadow`** runs everything and reports units that failed although selection would have skipped them. It runs nightly and on demand in PRs.
- **The mutation campaign** from the findings report, rerun against this selector: break a source, fixture, config or manifest file, and compare the selection with a full run. It must include the issue reproductions: the `exports` edit, tsconfig `paths`, `T3_MOBILE_TEST_PLATFORM`, the broken `acp-mock-peer.ts`, `bin.ts`, ignored files, and the unhandled error.

## 14. To verify before building

- That `module.registerHooks` and `NODE_OPTIONS=--import` reach Vitest 5.1 fork workers under vite-plus. `vp test` may filter the environment the way `vp run` does.
- The overhead of best-effort V8 function coverage in t3code workers, and source-map mapping of module-runner scripts.
- That `@vitest/browser` 5.1 tester iframes expose complete resource timing entries for module requests, including ones served from memory cache.
- Whether a job-level `if` skips a job with an empty dynamic matrix without error.
- How `vp test run` treats absolute file arguments. They are substring filters in Vitest, so the post-run set check (§8.2) must hold.
- How much of server code the Effect purity configuration unpins: count pinned declarations per module before and after, on the corpus.
