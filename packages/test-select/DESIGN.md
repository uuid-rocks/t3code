# test-select design

`@t3tools/test-select` selects the Vitest test files a change can affect, for t3code (vite-plus 1.5.1, Vitest 5.1.0, Node 26.12.1, pnpm). It selects no fewer: it never skips a file whose outcome can change. It selects no more: it does not run a file the change cannot affect. It also decides in CI, before any install, which jobs and shards have work.

This document is the design that implementation and evaluation follow. It merges three proposals (`research/design-1.md`, `research/design-2.md`, `research/design-3.md`), using the inputs in `research/plugin.md`, `research/ripple.md` and `research/t3code.md`. "Findings" refers to `/home/jh/src/artifacts/useblacksmith-vitest-findings.md` (F1–F9, Fl for its low-priority list). Section 14 defines the evaluation oracle the harness in `bench/` implements.

## 0. Summary

- **A passing run is the proof.** A test file is skipped only when a record from an earlier passing run exists, every input that run observed has the same identity now, and the runtime is the same. Inputs include modules, executed functions, files (ignored or not), directory listings, env vars, installed packages, child-process reads and the Vite main process's resolution and transform inputs.
- **Execution narrows module changes.** Records carry the functions each file executed (V8 precise coverage). A changed module affects a file only if a function the file executed, or the module body, changed in runtime tokens. Comment-only and type-only edits change no runtime tokens.
- **Static analysis only adds tests.** An oxc-based file-level graph with per-tsconfig import elision and path strings has three jobs. It covers channels a record cannot observe, cross-checks resolution, and explains selections (`why`). It never removes a test.
- **Unknown means run.** An input the recorder cannot observe makes the file always run (opaque). The same goes for an identity that cannot be computed and for any error.
- **State only from exit 0.** A wrapper process starts Vitest with an explicit file list and commits records only after Vitest exits 0 with no run-level errors. Failed files have no record and run until they pass.
- **Planning before install.** A plan job with no `pnpm install` reads trusted records from the base commit, computes head identities from git objects, and emits per-job, per-shard file lists. A job with nothing selected never starts. Inputs the plan cannot decide (ignored files, installed packages, unpredictable env, config transforms) get a `verify` verdict, which the test job resolves.

## 1. How the proposals scored

Scores are 1 to 5, where 5 is best. For implementation risk, 5 means lowest risk.

| Criterion               | Design 1: recorded execution                                                                                                                                           | Design 2: static-first                                                                                                                                                                                                    | Design 3: hybrid with proof                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Never under-selects     | 4. Record-based, with a sound argument for executed units. Exposed to coverage-mapping errors, browser isolate windows, and a file tracer that is unverified (`fspy`). | 3. The static graph decides code skips. Wrong purity entries, the scope walker and the reimplemented resolver all become misses unless the runtime check catches them, and that check cannot see effects inside packages. | 5. Static analysis only adds. Opaque channels always run, failed files have negative markers, and the transform proof uses the real Vite. |
| Minimal over-selection  | 5. Function-level executed units, an optional block refinement and level-2 pure statements.                                                                            | 3. Declaration-level, but Effect modules pin at load. `vi.mock` strings and dynamic imports that are never taken also select.                                                                                             | 3. File-level by default. Pruning is hunk-based and limited. Opaque tests (network, unvetted addons, non-Node children) always run.       |
| CI time saved on t3code | 4. The plan needs no install and PR runs pay no recording overhead. Phase B candidates still start jobs.                                                               | 4. Browser tests are selected without records. Linking two graphs of about 100k nodes costs time in the plan, and so does the Tailwind scanner.                                                                           | 4. Plan under 15 s, and `verify` starts jobs. PR-scoped stores make a second push to a PR incremental.                                    |
| Implementation risk     | 2. Coverage mapping through every transform, CDP in the browser, a stack-trace accessor and a child tracer.                                                            | 1. A full ripple port: scope analysis over ESTree, Effect purity, an in-memory resolver and a normalized environment.                                                                                                     | 3. A modest core (store, recorders, wrapper), phased, with every optional part gated on the bench.                                        |

**Decision.** Design 3's skeleton is the base. The record is the proof, static analysis only adds tests, and there are three verdicts (`skip`, `run`, `verify`), a transform proof and PR-scoped incremental state. Grafted onto it:

- From design 1: function units with nested-unit markers and the invariant that makes unstable unit ids cost precision, never recall (§5.2). Without this, t3code's Effect services would be selected at file level, because their bodies are `Effect.gen` callbacks. Coverage tells which callbacks ran; static purity cannot. Also from design 1: observation hazards (`toString`, stack positions), produced-input edges between test files, and a read-time re-check of facts.
- From design 2: the file-level static graph with Vite's elision rule under `verbatimModuleSyntax`, path strings, computed paths and test data folders. Also the resolver cross-check flag `resolution-mismatch`, the explicit treatment of t3code's run-everything list, the post-run check that Vitest ran the selected set, and plan-job fallback outputs.
- Rejected: design 2's declaration graph and Effect purity list, because its recall depends on a hand-maintained list. Design 2's normalized environment, because it changes test behavior. Design 1's level-2 pure statements, because they are recall-sensitive and the oracle's "no more" accepts module-body execution. Design 3's Actions-cache store, in favor of run artifacts (§9).

## 2. Definitions

- **Test unit**: one test file in one Vitest project (`apps/web/vite.config.ts#browser` + path). A file that two projects collect is two units. Selection is per unit, and every case in a selected file runs.
- **Runtime identity `R`**: `process.version`, `process.versions.v8`, platform, arch, libc family and the runner image version. For browser projects, also the browser name and revision. Also the test-select record schema and the hash of `packages/test-select` sources and config. A record is usable only under an identical `R`. Vitest, vite-plus and every plugin are package inputs (§4, row 6), not part of `R`.
- **Fact**: one question about the world plus the answer an execution observed. Examples: the content of a path, a path's absence, a directory listing, an env var's value or absence, a package's installed identity, the runtime tokens of a function the file executed, a module's transformed code.
- **Record `Rec(u, R)`**: the facts observed by one passing execution of `u` under `R`, plus its duration and flags. Only `passed` records exist. A failure leaves a negative marker (§8).
- **Opaque**: `u` used a channel the recorder cannot observe (§4, rows 16–18). An opaque unit gets no record and runs every time. The reason is logged.

### What "affected" means

`u` is **affected** in the target state `S` (a checkout plus the job's environment) unless there is a **proof**: a usable `Rec(u, R_S)`, with no negative marker, in which every fact has the same answer in `S`, after execution narrowing (§5.3), and no static union term (§6) adds `u`.

**Soundness.** Exclude nondeterminism (wall-clock time, randomness, scheduling, external services). A test file's execution is then a function of the code it executes and the answers it observes. Compare the execution in `S` with the recorded one. They proceed identically until the first instruction that differs. That instruction is either inside an executed unit whose runtime tokens changed, or at an observation whose answer changed. Both are facts in the record. Code that starts executing in `S` but did not before must be created or called by an executed unit or reached through an observed answer, so the divergence is detected earlier (§5.2 invariant). The argument assumes:

- **Completeness**: every channel into `u` is recorded or makes `u` opaque. Channels: its worker, its Node children, the Vite main process's config, resolution and transform, and its browser iframe.
- **Isolation**: files do not observe each other, except through repository or fixed paths, which produced-input edges cover (§8.1). Every t3code project uses `isolate: true`. A project with `isolate: false` is selected as a whole when any of its units is affected.
- **Determinism**: as above. Tests that read non-loopback network are opaque. Time and randomness are not modeled; a test that depends on them is flaky under any selector.

## 3. Architecture

```text
plan job (2 vCPU, no install)                       test jobs                                   collect (push to protected branch)
  exact-key store lookup (base, ancestors) ─┐         checkout, install                            merge job records onto base store
  ls-tree head (+ record commits)           ├─ verdicts ─► test-select run -- vp test run …           carry skipped units forward
  oxc facts for changed blobs               │  skip/run/   1 env + R re-check (may only add)          upload store artifact for head
  lockfile, workflow, manifests             ┘  verify      2 verify: transform/resolution proof
                       │                                   3 spawn Vitest with explicit file list
                       └─ plan.json, job outputs, matrix   4 recorders stage facts per unit
                                                           5 exit 0 + no run errors → commit records
```

| Component                                            | Runs in                                              | Dependencies                                            |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `record/worker` (setup file plus `--import`)         | Vitest node workers (forks, threads, jsdom projects) | Node built-ins only                                     |
| `record/child` (`NODE_OPTIONS=--import`)             | Node children and worker threads spawned by tests    | Node built-ins only                                     |
| `record/main` (`--import` on the Vitest process)     | Vitest main process: config load, `globalSetup`      | Node built-ins only                                     |
| `vitest` plugin `testSelect()` (ESM and CJS entries) | Vite/Vitest main process                             | Vite, Vitest. Inert unless `TEST_SELECT_RUN_DIR` is set |
| browser recorder (setup file plus server command)    | browser tester iframe and Vite server                | Vitest browser API                                      |
| `analyze` (oxc-parser)                               | plan job and `run`                                   | `oxc-parser`                                            |
| `cli`: `plan`, `run`, `collect`, `why`, `fetch`      | CI jobs and local shells                             | bundled single file plus the oxc binding                |
| `bench/` oracle and harness (§14)                    | bench host or CI dispatch                            | does not import `src/`                                  |

Effect `Schema` parses every external input: store, observation files, `dependencies.json`, lockfile, manifests, tsconfig, workflow YAML and CLI arguments. A decode failure gives "unknown", and unknown means run.

## 4. Inputs and how each is identified

Recorded per unit unless the "Attributed to" column says otherwise. "Plan" says whether the plan job can compute the head identity from git objects. Where it cannot, the verdict is `verify`, never `skip`.

| #   | Input                                                                                                                                                                                             | Identity                                                                                                                                                                                                                                                                                                    | Attributed to                   | Plan                                                             | Rule                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Source module evaluated in the worker. Sources: Vitest `recordDependencies` set (setup files and prepared modules included), coverage script URLs and native loads seen by `module.registerHooks` | content id, executed-unit set (§5)                                                                                                                                                                                                                                                                          | unit                            | yes                                                              | Changed runtime tokens in the module body or an executed unit → run (§5.3)                                                                                                                                                                                                                                     |
| 2   | Repo file read through `fs` (read, open+read, stream, copy source, `realpath`, `readlink`), in the worker or a child, ignored or not                                                              | content id. Symlinks: link text and target identity                                                                                                                                                                                                                                                         | unit                            | tracked and clean: yes. Ignored or generated: `verify`           | Changed → run. Paths the unit's process tree wrote or created before reading are not inputs                                                                                                                                                                                                                    |
| 3   | `stat`, `lstat`, `access`, `exists` on a repo path                                                                                                                                                | `absent`, or type, mode and content id (not times, not inode)                                                                                                                                                                                                                                               | unit                            | as row 2                                                         | Changed → run                                                                                                                                                                                                                                                                                                  |
| 4   | Directory listing (`readdir`, `opendir`, glob libraries)                                                                                                                                          | the names (and types with `withFileTypes`) returned, at the depth the call covered                                                                                                                                                                                                                          | unit                            | tracked-only dirs: yes. Dirs with ignored entries: `verify`      | Changed → run                                                                                                                                                                                                                                                                                                  |
| 5   | Path outside the repo, excluding `os.tmpdir()`, `/proc`, `/sys`, `/dev` and created paths                                                                                                         | content id                                                                                                                                                                                                                                                                                                  | unit                            | yes if the plan runner has the same image version, else `verify` | Changed → run                                                                                                                                                                                                                                                                                                  |
| 6   | Third-party package code. Realpath under `node_modules/.pnpm/<dir>/`, seen in the worker, children, main-process plugins that transformed the unit's modules, or browser optimized deps           | pnpm snapshot key (`name@version(peers)(patch_hash=…)`) plus integrity from `pnpm-lock.yaml`                                                                                                                                                                                                                | unit                            | yes, from the head lockfile                                      | Key gone or integrity changed → run. Lockfiles are never inputs themselves, and lockfiles outside the workspace (`.repos/`) are never read (F9)                                                                                                                                                                |
| 7   | Bare-specifier resolution from workspace code                                                                                                                                                     | the `importers[<dir>]` subtree of the lockfile. Layout settings (`nodeLinker`, hoisting, `injectWorkspacePackages`, `dedupePeers`)                                                                                                                                                                          | module                          | yes                                                              | Subtree changed → run units that loaded a module of that package. Layout change → run every unit that loaded a package                                                                                                                                                                                         |
| 8   | `package.json` consulted by resolution or transform: the nearest manifest of each loaded module, and the target manifest of each workspace import                                                 | resolution view: `name`, `type`, `main`, `module`, `browser`, `exports`, `imports`                                                                                                                                                                                                                          | module                          | yes                                                              | View changed → `verify`. In the job, the transform proof decides (§7.2). A unit that reads a manifest with `fs` has the whole file under row 2                                                                                                                                                                 |
| 9   | tsconfig applying to each transformed module                                                                                                                                                      | the chain Vite used (nearest, `references`, `extends`) and the transform view: `jsx*`, `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields`, `target`, `verbatimModuleSyntax`, `preserveValueImports`, `importsNotUsedAsValues`, plus `baseUrl`/`paths` where `tsconfigPaths` is on | module                          | yes. The chain is re-derived on the head tree                    | View or chain changed → `verify` (transform proof). The view list is pinned by a test against vite-plus-core's tsconfig loader                                                                                                                                                                                 |
| 10  | Resolution candidates                                                                                                                                                                             | for each relative or `paths` specifier: presence of every candidate Vite tries before the chosen one (`resolve.extensions` order, `/index.*`). For `vi.mock(spec)` without a factory: the `__mocks__` candidates                                                                                            | module or unit                  | yes                                                              | Presence changed → `verify` (resolution proof)                                                                                                                                                                                                                                                                 |
| 11  | Project config                                                                                                                                                                                    | config closure (`configFileDependencies`) content ids, env files Vite loads (ignored or not), files and env read at config time and in `globalSetup`, and the serialized resolved config (Vitest `serializedConfig` plus each plugin's name and providing package or file)                                  | project                         | files: yes. Env: §10.4. Serialized config: no                    | Unchanged → nothing. Changed → every unit of the project is `verify`. The transform proof decides per unit if the serialized config is equal; otherwise the project runs                                                                                                                                       |
| 12  | Transformed code of each loaded module                                                                                                                                                            | hash of the code Vite served                                                                                                                                                                                                                                                                                | module                          | no                                                               | Used by the transform proof only, to clear rows 8–11 and config-time env                                                                                                                                                                                                                                       |
| 13  | Environment variables                                                                                                                                                                             | per name: value hash or `absent`, for names read before the realm wrote them. `ownKeys` records the hash of the name set, not values. Config-time reads are project facts                                                                                                                                   | unit, or project at config time | §10.4                                                            | Changed → run. A unit that reads the value of a per-run variable (`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`, `RUNNER_TEMP`, `ACTIONS_*`, …, listed in config) is opaque                                                                                                                              |
| 14  | Runtime                                                                                                                                                                                           | `R`                                                                                                                                                                                                                                                                                                         | record                          | predicted (§10.4). Mismatch or unknown → `verify`                | No record under the job's `R` → run (F3)                                                                                                                                                                                                                                                                       |
| 15  | Node child process (`process.execPath`, a `node` shebang: `tsx`, `pnpm` and similar) and worker threads                                                                                           | its own rows 1–6, 10 and 13 through `record/child`                                                                                                                                                                                                                                                          | spawning unit                   | as those rows                                                    | Merged into the unit. A start marker with no end marker (killed child) → no record (F4)                                                                                                                                                                                                                        |
| 16  | Non-Node executable (`git`, `sh -c`, `cc`, `vp`, `bun`, `python`, Chromium from `playwright-core`)                                                                                                | the executable's content id (row 5)                                                                                                                                                                                                                                                                         | unit                            | as row 5                                                         | Opaque if its cwd or any argument names a repo path the unit did not create, unless a static union term covers it (§6). Otherwise the binary identity is the only fact (`git init` in a temp dir). A configured tool policy (`none`, `args`) narrows known tools. Every policy entry needs a reason and a test |
| 17  | Native readers: `node:sqlite` `DatabaseSync(path)`, `new Worker(path)`, `.node` addons via `process.dlopen`                                                                                       | path as rows 2 and 6                                                                                                                                                                                                                                                                                        | unit                            | as rows 2 and 6                                                  | Wrapped. An addon outside the vetted list makes the unit opaque                                                                                                                                                                                                                                                |
| 18  | Non-loopback network (`net`, `tls`, `fetch`, `dns.lookup` of a non-local name)                                                                                                                    | none                                                                                                                                                                                                                                                                                                        | unit                            | —                                                                | Opaque                                                                                                                                                                                                                                                                                                         |
| 19  | Snapshot files (`__snapshots__/*.snap`, `toMatchFileSnapshot`, `resolveSnapshotPath`)                                                                                                             | content id or `absent`                                                                                                                                                                                                                                                                                      | unit                            | yes                                                              | Changed → run                                                                                                                                                                                                                                                                                                  |
| 20  | `import.meta.glob` calls                                                                                                                                                                          | the match list, re-expanded with the library and options Vite uses                                                                                                                                                                                                                                          | module                          | yes                                                              | Changed → run                                                                                                                                                                                                                                                                                                  |
| 21  | Browser module graph                                                                                                                                                                              | URLs the iframe fetched, mapped through the client module graph to files. Non-JS imports (CSS, `addWatchFile`). Optimized deps mapped to packages                                                                                                                                                           | unit                            | as rows 1, 2, 6                                                  | As rows 1, 2, 6 (F8). Tailwind CSS whose scan inputs changed is `verify`, and the transform proof compares the generated CSS                                                                                                                                                                                   |
| 22  | CI environment construction `E_job`                                                                                                                                                               | hash of the job definition, the local composite actions it uses, and the runner label                                                                                                                                                                                                                       | record (CI only)                | yes                                                              | Used only to predict env at plan time (§10.4)                                                                                                                                                                                                                                                                  |
| 23  | The selector                                                                                                                                                                                      | in `R`                                                                                                                                                                                                                                                                                                      | all                             | yes                                                              | A change to `packages/test-select` reruns everything once per `R`                                                                                                                                                                                                                                              |

## 5. Identities and the change model

### 5.1 Content ids

A file's content id is its git blob id in the repository's object format (`git rev-parse --show-object-format`). It is computed over raw bytes with no clean filters, streamed with 64-bit sizes: no whole-file reads, no 2 GiB limit. Two shortcuts give the same value without hashing:

- In-job: a tracked path whose working-tree stat matches the index entry, with no conversion attributes, takes the index blob id. CRLF-only edits change the stat and get hashed. Paths with `eol=crlf` are always hashed.
- Plan: a tracked path's `ls-tree` blob id, under the same no-conversion condition. Paths with conversion, ignored paths and generated paths are `verify`.

The stat at read time (size, mtime ns, inode) is kept. At commit, a path whose stat changed since the read drops that unit's record (Fl run-end hashing). Paths are repo-relative strings in `Map`s and interned tables, and all git I/O uses `-z` (Fl `toString`, newline paths). Directory identity is the listing returned, never a recursive hash.

### 5.2 Units and runtime tokens

A **unit of code** is a source function-like node: function declaration or expression, arrow function, method, getter, setter, constructor, generator or async function. Each module also has one **module body** unit. Class field initializers and static blocks belong to the enclosing unit; V8 runs instance initializers in a synthetic function.

A unit's **runtime tokens** are the tokens lexically inside it, with each directly nested unit replaced by a marker `<fn kind name length async generator>`. Node kinds are hashed in source order alongside the tokens. Excluded:

- comments, except pragmas (`@jsx*`, `@vitest-*` docblocks, `@vite-ignore`, `#__PURE__`, `sourceMappingURL`, any unrecognized `@` directive);
- whitespace;
- TypeScript-only syntax as the module's own transform erases it: annotations, type parameters and arguments, interfaces, type aliases, `declare`, overload signatures, `implements`, and the type side of `as`, `satisfies` and `!`;
- imports removed under the file's elision rule. With `verbatimModuleSyntax`, `import { A }` stays and `import { type B }` becomes `import "./b"` (`research/ripple.md` §13).

Fields without initializers count when `useDefineForClassFields` is in effect.

Unit ids are paths of local keys: `fn:name`, `method:name`, `get:name`, `prop:key`, `call:Effect.gen#0`, `call:it("parses ids")#0`, `anon#k`, each with an ordinal among siblings that share a key.

> **Invariant.** A function object exists only after its parent unit has run the code that creates it. A change that makes an id unstable (an inserted sibling, a rename) also changes the parent's markers. If the child executed, so did the parent. Unstable ids cost precision, never recall.

### 5.3 Module comparison for a unit

For a module `M` that `u` loaded, whose content id differs:

1. If `u` has no executed-unit set for `M`, or `M` is unmapped, position-sensitive for `u`, or `u` is source-observed (§5.4) → changed.
2. Head `M` fails to parse → changed.
3. Otherwise, `u` is affected when the module body, or any unit in `u`'s executed set for `M`, has different runtime tokens or no longer exists. New units are covered by the invariant.

Executed sets come from `Profiler.startPreciseCoverage({ callCount: false, detailed: false })`. It starts in the worker recorder before any test module loads, and in `record/child` at child start. Coverage is taken at file end and mapped through Vite's source maps (or `module.findSourceMap` for native loads) to the innermost source unit containing each executed function's start. The mapped end must land in the same unit. Otherwise the module is unmapped for that unit, which means module granularity. Mapping is cached per transformed-code hash.

**Block refinement.** With `detailed: true`, a changed executed unit is cleared when every token change lies inside blocks `u` did not execute, the controlling expressions are unchanged, and no `var`, sloppy function declaration, `arguments`, label, `eval`, `await` or `yield` is added or removed. It is off until the bench shows its coverage cost pays. The oracle measures at block level (§14), so the gap it closes is measured.

Records without executed sets are valid; they are module-granular. PR runs may record without coverage if the bench shows the overhead is not worth it on PRs.

### 5.4 Observation hazards

- **Source text**: the recorder wraps `Function.prototype.toString`. A call on a non-native function marks the unit source-observed, which means module granularity.
- **`length` and `name`**: these are in the parent's marker, so changing them changes an executed unit.
- **Source positions**: the recorder installs `Error.prepareStackTrace` as an accessor that wraps whatever handler gets assigned, Vite's included. It records the file of every repo frame in a formatted trace. Those modules are position-sensitive for that unit: any byte change counts, comments and whitespace included. How often this widens selection on Effect-heavy server tests is a bench number.

### 5.5 Other facts

| Fact                         | Changed when                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Content, snapshot, asset     | content id or existence differs                                                               |
| `stat`-class                 | existence, type, mode or content id differ                                                    |
| Listing                      | the same call on the head tree (plus ignored entries on disk in-job) returns a different list |
| Package                      | snapshot key gone or integrity differs                                                        |
| Env                          | value hash or presence differs. Name-set hash differs for `ownKeys` readers                   |
| Resolution or transform view | §4 rows 8–10. Decided by the proof in §7.2                                                    |
| `R`                          | any field differs: the record is unusable                                                     |
| Produced-input edge `u → w`  | `w` is selected                                                                               |

## 6. The static layer

`analyze` parses each module blob with `oxc-parser`. Facts are cached by blob id, analyzer version and the analysis-relevant tsconfig options. Facts: runtime imports with the file's elision rule, dynamic imports, `require` and `createRequire(...)(literal)`, `?raw`, `?url` and `?worker` edges, `vi.mock`, `vi.importActual` and `vi.importMock` specifiers, `import.meta.glob` calls, path strings (relative, alias, `new URL("./x", import.meta.url)`, literal `path.join(import.meta.dirname, …)`, root-relative strings), computed paths with a static folder prefix, test data folders (ripple §8), opaque sites (non-literal `import()`, `require`, `new Worker`) and unit tables with runtime-token hashes (§5.2).

It is used for these purposes, and never to remove a selected unit:

1. **Union term for opaque children.** A non-Node child, or a Node child the recorder could not reach (spawned through `vp` or `bun`, whose environment filtering drops `NODE_OPTIONS`), whose entry is a repo module named by a path string in the spawning unit's executed code. The static closure of that entry (imports, path strings, data files, computed paths) becomes the child's input set, and the unit is no longer opaque. If the closure contains an opaque site, or no path string resolves, the unit stays opaque.
2. **Resolution diff.** The plan resolves each specifier of each recorded module on the record's tree and on the head tree, through workspace `exports` and `imports`, tsconfig `paths` (web), the `~` alias and the candidate list. A different target puts every unit that loaded the importer in `verify`. In-job, the real resolution decides. A disagreement between the static resolver and the recorded real resolution flags the unit `resolution-mismatch`: it runs until fixed, and the disagreement is reported as a model gap.
3. **Plan-time unit tables** for changed head blobs, so §5.3 runs without install.
4. **`why <unit>`**: the reason from the verdict. For module changes it gives the changed executed unit. It also gives the shortest static path from the test to the changed file.
5. **Audit counters**: units the static graph lists as affected but records prove unaffected (precision), and recorded modules the static graph cannot reach from the test (static gaps).

## 7. Selection

### 7.1 Plan (no install)

```text
plan(head, event):
  store := exact lookup (§9): PR-scoped previous head, then base, then base's first-parent ancestors (≤ 30)
  if no store, or header incompatible:  all units run, reason printed
  ids   := ls-tree head (blob:none checkout; fetch blobs of changed modules, manifests, lockfile)
  for project P in store.projects ∪ projects of changed configs:
     files := expand P.include/P.exclude (recorded resolved patterns) on the head tree
     if P's config facts changed: units of P → verify, continue
     for unit u in files:
        R' := predict_R(job(u))
        rec := store.record(u, R')
        if rec missing | negative marker | opaque | always:            run
        diff    := { f ∈ rec.facts : answer_head(f) ≠ f.answer }  after §5.3 narrowing
        unknown := { f ∈ rec.facts : answer_head(f) not computable in the plan }
        diff ≠ ∅ → run;  unknown ≠ ∅ → verify;  else skip
  close over produced-input edges; add union terms (§6)
  emit plan.json: per job and shard, run list, verify list, reason per unit
```

The plan compares fact by fact against content ids. The diff from the record's commit to head (`git diff --raw -z`) is only used to skip unchanged modules without parsing. Comparing against an older store selects more, never fewer.

### 7.2 In-job: re-check and proofs

`test-select run` repeats §7.1 for its scope with exact answers: the working tree, ignored files, the installed `node_modules/.pnpm`, the real env and the real `R`. It can only add units to the plan's `run` list. For `verify` units whose remaining differences are rows 8–11, config-time env or Tailwind scan inputs, it runs the **transform proof**:

- It starts the project's Vite environment through Vitest's node API, the same configuration the run uses.
- It compares the serialized project config, the transformed code hash of each module in the unit's record (Vite's import analysis embeds resolved ids, which covers resolution changes for inlined workspace modules; verified in §15), and the generated CSS for Tailwind entries.
- Everything equal → skip. Anything different, a throw, or a module that no longer resolves → run.

This makes `noUnusedLocals` in `tsconfig.base.json`, an unrelated `define`, or a `package.json` `version` edit select nothing. `useDefineForClassFields: false`, an `exports` redirect or a `paths` change select exactly the units whose transformed modules changed.

### 7.3 Empty selections and `passWithNoTests`

The tool never sets `passWithNoTests` (F5). When a group's selection is empty, `run` exits 0 without starting Vitest, but only if the project's include globs match at least one file on the working tree and the config facts are unchanged. Otherwise it runs the original command unchanged, so a broken `include` fails exactly as it does today.

## 8. Committing state, and failure handling

- **Staging.** Recorders write facts to `$RUNNER_TEMP/test-select/` (locally `$(git rev-parse --git-dir)/test-select/`), never inside the worktree.
- **Commit rule.** `run` commits a unit's record only when all of the following hold:
  - the Vitest child exited 0 with no signal;
  - the staging reporter saw no run-level errors, even if `dangerouslyIgnoreUnhandledErrors` made the exit code 0;
  - the run was not partial: Vitest's `isPartialRun` is false, which covers name and line filters, global and per-spec `tagsFilter`, and `.only`;
  - the unit's module state is `passed`, or every case was skipped by a condition whose inputs are recorded;
  - no error is attributed to the unit;
  - none of its facts changed between read and commit;
  - every child it spawned left an end marker;
  - it is not opaque.

  Coverage thresholds, which Vitest decides after `onTestRunEnd`, are covered by the exit code (F1).

- **Negative markers.** A failing invocation commits negative markers for its failed units, which block any older record until a later pass. A failed unit therefore runs until it passes, even when its failure cause is outside its inputs.
- **Replacement.** A record is replaced per unit on each pass and never unioned with an older one (Fl partial records).
- **Unknown means run.** This applies, at the narrowest scope the error allows, to:
  - a missing or undecodable store, observation file or record schema;
  - an identity that cannot be computed in the job;
  - a parse error in a changed head module;
  - a recorder exception: the wrapped call proceeds unchanged and the unit gets no record;
  - a selector exception: `run` falls back to the original command, and the plan emits the fallback outputs of §10.1.
- **No behavior change.** Wrappers forward arguments, `this`, return values and errors. They keep `name` and `length`. The env `Proxy` forwards writes and hides `TEST_SELECT_*` and the recorder's `NODE_OPTIONS` entry from `get`, `has` and `ownKeys`. No signal handlers are installed. No files are written in the repo.
- **Post-run set check.** The set of test modules Vitest reported must contain the selected set. A missing file fails the job as a selector bug. Extra files from substring filtering are recorded normally.

### 8.1 Produced-input edges

Every realm records the paths it wrote or created, repo and temp paths included. At commit, a read by `u` of a path that another unit `w` of the same invocation wrote (and `u` did not create itself) becomes an edge `u → w`: when `w` is selected, so is `u`. This covers coupling through fixed paths under `fileParallelism: false` without treating shared temp paths as inputs.

## 9. Store, scoping and trust

- **Contents.** One store per commit: header (schema, selector hash, object format, commit, run id), interned path and identity tables, unit tables per module blob, records per (unit, `R`), negative markers, per-project config facts, and durations. Records are exact sets, with no probabilistic structures (Fl Bloom). The file is zstd-compressed (`node:zlib`).
- **Trusted store.** The `collect` job writes it as a run artifact `test-select-store-<R-hash>`, only on `push` to `main` or `bsv/main`, and only when every test job succeeded or was skipped by the plan. It merges the jobs' committed records onto the base store, carries skipped units forward unchanged (the plan proved them unaffected), and drops deleted test files.
- **Lookup.** By exact SHA through the runs API (`actions/runs?event=push&branch=<protected>&status=success&head_sha=<sha>`, then the run's artifacts, with `actions: read`). For a PR, the base is `pull_request.base.sha`. For a push, it is `before` when that is an ancestor of `HEAD`, else `HEAD^1`. If the base has no store yet, the plan walks its first-parent ancestors, up to 30, each by exact SHA. Beyond that, everything runs. There is no prefix restore and no other branch (F7).
- **PR scope.** Each test job of a PR run uploads its committed records (from invocations that exited 0) as an artifact of that run. A later run of the same PR first loads the records of the PR's previous head, from that PR's own runs found by `head_sha` and `event=pull_request`, then the trusted base store. A second push to a PR reruns only what changed since the first. PR artifacts are read only by the same PR. Its author already controls the code under test, so this adds no trust surface.
- **Trust model.** An entry is trusted because of who wrote it: protected-branch pushes, or the same PR. Content addressing then makes a trusted record valid on any descendant.
- **Local.** `test-select run` without `--plan` uses `$(git rev-parse --git-dir)/test-select/store`, written by local runs that exit 0. `test-select fetch` seeds it from the trusted store of `git merge-base HEAD origin/main` with `gh`. Local records never upload.

## 10. Vitest and t3code integration

### 10.1 Wiring

- `testSelect()` is added to the six configs: root `vite.config.ts` (and through it `apps/server` and the 28 borrowing packages), `apps/web`, `apps/mobile` (CJS entry: `module.exports = testSelect; testSelect.default = testSelect`), `apps/desktop` and `packages/client-runtime`. With `TEST_SELECT_RUN_DIR` unset, it returns no hooks.
- When active, it does the following and nothing else:
  - sets `experimental.recordDependencies: true` and `cache: true`;
  - prepends the worker recorder to node and jsdom projects' `setupFiles`;
  - adds the browser setup file and commands;
  - registers transform and resolve observers for rows 8–12 and 20;
  - adds the staging reporter.

  It does not touch `passWithNoTests`, `include`, the sequencer, sharding, `changed` or `vcsProvider`.

- Package scripts become `test-select run -- vp test run …`. `run` keeps every argument, appends the selected files as absolute paths, sets `TEST_SELECT_RUN_DIR`, and adds `--import=<record/main>` for the Vitest process. Before each file, the worker recorder sets `TEST_SELECT_CHILD_DIR` and appends `--import=<record/child>` to `NODE_OPTIONS` in `process.env`. `child_process` wrappers (with `syncBuiltinESMExports`) merge both into spawns that pass an explicit `env`.
- File lists are not partial runs, so any subset produces records. `test:cached`'s one-process-per-file runs also produce records (Fl one-file-per-process).

### 10.2 Projects

- **Node** (root-config packages, server, desktop, client-runtime, web `unit`, mobile `unit`): rows 1–20.
- **jsdom** (mobile `react`): as node. The Babel transform's inputs are config facts (`babel.config.js` through `createRequire` at config time, seen by `record/main`), Babel packages (row 6) and `T3_MOBILE_TEST_PLATFORM` (config-time env). Moving a file into or out of `reactTests` changes membership, which is a config fact.
- **Browser** (web `browser`): the module set per file comes from the iframe's `performance.getEntriesByType("resource")`, with the buffer raised at setup start, mapped through `environments.client.moduleGraph` plus non-JS imports and optimized-deps metadata. Executed units come from CDP precise coverage through the Playwright provider's `cdp()` session. The session records `Runtime.getIsolateId` and the file's time window. If two files' windows overlap on one isolate, both get module-granular records. File commands (`readFile`, `writeFile`, `removeFile`) and t3code's own commands are wrapped server-side and attributed by `testPath`. The Chromium revision is in `R`.
- **`renders`**: not run in CI and not selected.

### 10.3 CI jobs

| Job                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan` (replaces `changes`) | 2 vCPU. Blobless checkout with `fetch-depth: 2`, plus trees of the base and its ancestors. Node from the setup cache. The CLI is a bundled ESM file plus the `oxc-parser` binding, cached by the hash of `packages/test-select/**` and its lockfile entries. No `vp install`. Outputs per job: `run`, the matrix, setup needs (`chromium`, `chromium_server`, `electron`, `libsecret`), `install_filter`, and `plan.json`. On any planner failure it exits 0 with `run_all=true`. If it cannot write outputs, downstream jobs use `fromJSON(needs.plan.outputs.server_matrix \|\| '[1,…,8]')` and run as today. Target: under 10 s after runner pickup |
| `test`                      | A matrix over package groups balanced by recorded durations. Mobile (95 s) is its own group when selected. Groups with nothing selected are not created. `node --test`, Python and Rust suites keep their package-level gating from `ci-changes.cjs`, which the plan runs unchanged for those outputs                                                                                                                                                                                                                                                                                                                                                  |
| `test_web`                  | `unit` and `browser` entries, with browser shardable. The Chromium restore and install run only when browser units are selected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test_server`               | A matrix sized `min(8, ceil(selected seconds / target))`. Files are assigned longest-first by recorded durations (`shardWeights.json`, then 0.6 s, for files without one). One Vitest process per shard with an explicit list (`fileParallelism: false` kept). No `--shard`, no `test:cached` per-file processes (25–30 s per shard on the fork). An empty matrix skips the job before checkout                                                                                                                                                                                                                                                        |
| `collect`                   | Push to protected branches only. Off the PR critical path, 10–20 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `check`                     | Every job succeeded, or was skipped because the plan said it had nothing to run. `plan` must have succeeded or emitted `run_all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| nightly `full`              | Runs every unit with recording, publishes a fresh store (resetting carry-forward chains) and runs the shadow comparison: any unit that fails while a carried record vouched for it is a selector miss and alerts                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`transferBudgetV2.integration.test.ts` writes the report that `check` requires. It is listed in `always` in `packages/test-select/config.json`, with that reason, scoped to runs where any server unit is selected. A config entry that matches no file is an error. `release.yml` and `windows-tests.yml` run everything (`run --all`, which records under their own `R`).

### 10.4 Env and `R` prediction at plan time

A job's environment is a function of the workflow, its local actions, the runner image and the event. For each recorded env fact:

- GitHub context names that are equal across the jobs of a run (`GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_BASE_REF`, `CI`) come from the plan job's own environment.
- Names the workflow sets statically (job and step `env:`) are read from the workflow file.
- Names set through expressions the plan cannot evaluate, `$GITHUB_ENV` writes, or `secrets.*` / `vars.*` are `verify`.
- The recorded name set (`ownKeys`) is valid while `E_job` and the image version are unchanged.

`R` is predicted from root `engines.node` (exact `26.12.1`, which `setup-ci-deps` installs), the plan runner's image version, and the Chromium revision implied by `playwright-core` in the lockfile. Before starting Vitest, every job re-checks env, `R` and outside-repo facts exactly, and may only add units. A job the plan skipped never runs this check, so the plan only skips on facts it predicted from repository content or its own image.

## 11. Findings, item by item

| Finding                                             | Why it cannot occur                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 unhandled errors save a passing snapshot         | `run` commits after reading the Vitest exit status, outside the reporter phase. Run-level errors block the commit even at exit 0. CI publishes stores only from all-green push runs (§8, §9)                                                                                     |
| F2 `package.json` / tsconfig undetected             | Manifest resolution views, tsconfig chains and transform views, lockfile importers and resolution candidates are per-module facts computed from files. The real Vite decides in the transform proof. The static resolution diff checks independently (§4 rows 7–10, §6, §7.2)    |
| F3 Node version and environment                     | `R` keys every record. Env reads are recorded per unit (worker and children) and per project (config time). Env files are hashed whether or not git ignores them. `define` values reach modules through transformed code hashes. Negative markers rerun failures (§4 rows 11–14) |
| F4 child processes                                  | Node children inherit `record/child`, including spawns that pass an explicit `env`. Killed children drop the record. Non-Node children touching the repo are opaque unless a static union term covers them. There are no path-pattern rules (§4 rows 15–16, §6)                  |
| F5 `passWithNoTests`                                | Never set. Empty selections skip Vitest only after confirming the include globs match (§7.3)                                                                                                                                                                                     |
| F6 git-ignored inputs                               | Identity comes from bytes for every repo path. The plan marks ignored inputs `verify` (§4 row 2, §5.1)                                                                                                                                                                           |
| F7 cross-branch cache                               | Exact-SHA lookup of trusted push-run artifacts at the base and its first-parent ancestors. PR records stay in the PR (§9)                                                                                                                                                        |
| F8 browser tests always rerun                       | Per-file records from resource lists, the client module graph and CDP coverage (§10.2)                                                                                                                                                                                           |
| F9 lockfile reruns everything                       | Lockfiles are never inputs. Per-unit package keys and importer subtrees are. `.repos/` lockfiles are never read (§4 rows 6–7)                                                                                                                                                    |
| Run-end hashing                                     | Stat at read, re-checked at commit (§5.1)                                                                                                                                                                                                                                        |
| Partial records after failure                       | Per-unit pass records, replaced, never unioned. Negative markers (§8)                                                                                                                                                                                                            |
| `tagsFilter`                                        | Partial exactly when Vitest's `isPartialRun` is true (§8)                                                                                                                                                                                                                        |
| Bloom false positives                               | Exact sets (§9)                                                                                                                                                                                                                                                                  |
| Symlink target, CRLF, `toString` key, newline paths | §5.1                                                                                                                                                                                                                                                                             |
| New `import.meta.glob` match                        | Row 20                                                                                                                                                                                                                                                                           |
| New resolution candidate, `__mocks__`               | Row 10                                                                                                                                                                                                                                                                           |
| `node:sqlite` fixtures                              | Row 17                                                                                                                                                                                                                                                                           |
| Record growth                                       | Replaced per pass. Temp, created and volatile paths excluded (§4)                                                                                                                                                                                                                |
| Directory reads anchored recursively                | Listing as returned (row 4)                                                                                                                                                                                                                                                      |
| Snapshot not partitioned by shard                   | Per-unit records; sharding after selection (§10.3)                                                                                                                                                                                                                               |
| One-file-per-process runners                        | File lists are not partial (§10.1)                                                                                                                                                                                                                                               |
| CommonJS configs                                    | CJS entry (§10.1)                                                                                                                                                                                                                                                                |
| 2 GiB, whole-file reads, SHA-1 in SHA-256 repos     | Streamed hashing in the repository's object format (§5.1)                                                                                                                                                                                                                        |

## 12. Residual risks

### Under-selection

- Nondeterminism, and coupling through external state other than files: ports, daemons, global git config written by a test.
- Recorder blind spots: native code inside a vetted addon that reads files, a tool policy entry that is wrong, process state set before the recorder installs.
- Coverage mapping errors that pass the start/end consistency check, especially through the React Compiler, Babel and TanStack Router transforms.
- Main-process plugin reads that are not config facts, watch files or transform inputs, and that do not change transformed output.
- Env prediction for values written to `$GITHUB_ENV` from something outside `E_job` (a network lookup during setup).
- Static union terms for opaque children: an entry whose closure reads something no path string names.

The nightly shadow run and the oracle campaign (§14) exist to find these. Each miss found becomes a regression case.

### Over-selection

- Function granularity, without block refinement, against the oracle's block-level evidence.
- Module body changes select every loader.
- Package granularity.
- File granularity for data files.
- Position-sensitive modules and source-observed units.
- Opaque units always run: non-Node children in the repo, network, unvetted addons, per-run env values.
- `verify` jobs that start and select nothing, which costs checkout and install (~20–28 s).
- Project-wide config changes whose serialized config differs.
- Negative markers rerun a fixed failure until it passes once.
- Older stores, when the base has none, select the union of changes since the ancestor.

## 13. Performance budget

| Step                                            | Budget                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan job                                        | under 10 s after pickup: store download 1–2 s, `ls-tree` under 1 s, parse changed blobs (oxc parses all 6,566 t3code files in 1.5 s single-threaded) |
| In-job selection (`run`)                        | under 0.5 s typical: index-stat shortcut, hashing only dirty, ignored and generated inputs                                                           |
| Transform proof                                 | only when rows 8–11 differ. One Vite environment start plus transforms of the candidates' modules. It must cost less than running them, measured     |
| Recording overhead (wrappers, without coverage) | under 5% of Vitest duration                                                                                                                          |
| Function coverage                               | measured per project. Enabled on push runs if under 15%. Enabled on PR runs only if total PR CI time drops                                           |
| Commit                                          | under 1 s                                                                                                                                            |
| Store size                                      | under 20 MB compressed per `R`                                                                                                                       |

## 14. Evaluation oracle

The harness in `bench/` judges a selector on a set of cases. The oracle is independent of the selector's mechanism. It does not import `packages/test-select/src`, read its records, or use its recorders or its static analyzer. Its data sources are Vitest's JSON reporter, V8 coverage (`NODE_V8_COVERAGE` for Node processes, the CDP Profiler for the browser, collected by oracle-owned code), a process-tree syscall tracer (`strace -f`, installable on the bench host with `pacman -S strace` and on Ubuntu runners with apt), Node's `--trace-env`, git, and the TypeScript compiler API for diffs (not oxc).

### 14.1 Case

A case is `(base state, head state)`, where a state is a tree plus an environment: env vars, git-ignored files present, Node version, installed `node_modules`. The base is a commit where the full suite passes, run twice with identical outcomes. Units whose outcome differs between the two base runs are flaky. They are listed, excluded from both checks, and reported.

### 14.2 Ground truth for "no fewer"

For each case, the harness runs the full suite at head exactly as CI configures it, with no instrumentation: every project of every package, with the package scripts' arguments and `--maxWorkers=6`. Outcome of a unit = file state, the per-test map `fullName → passed | failed | skipped | todo`, and attributed errors. A run-level error with no attributed file is bisected: the project's units run individually until it reproduces, and the units that reproduce it count as changed.

`Changed(case)` = units whose outcome at head differs from base. A difference must reproduce in two more full runs of that unit's project, otherwise the unit counts as flaky. Units that exist only at head and do not pass, and units whose skip set changed (for example `runIf` on the Node version), are in `Changed`.

**Miss** = `Changed(case) \ Selected(case)`. The gate: zero misses on every case.

### 14.3 Evidence for "no more"

A selected unit `u` is **justified** when at least one of these holds:

- **E0 outcome**: `u ∈ Changed(case)`.
- **E1 executes changed code**: in an instrumented head run, a V8 block range covering a changed source range of a repo module had count > 0. This is checked in any process of `u`'s tree: worker, Node children, the browser iframe, or the Vite main process while it served `u`'s modules.
  - Changed ranges come from TypeScript-parsed base and head files. Runtime token streams drop comments (pragmas kept) and type-only syntax under each file's elision rule. An LCS diff marks inserted and replaced tokens at their head spans. A pure deletion maps to the innermost head block or function whose span contains the deletion point.
  - Coverage maps to source through the source maps the transformed code carries: Vite's inline maps, and Node's `source-map-cache` in `NODE_V8_COVERAGE` output.
  - A position counts as executed when the innermost coverage range containing it has count > 0.
- **E2 reads a changed input**: the tracer shows `u`'s worker or child processes opened, stat'd, listed (`getdents64`) or exec'd a path whose content, existence or listing differs between base and head. Failed probes (`ENOENT`) count. In the Vite main process:
  - reads during config load (before the first unit starts) justify every unit of that project only when the input is not a JS/TS module (env files, `babel.config.js` data, JSON);
  - later main-process reads justify `u` only when the transformed code of a module `u` loaded, or its resolved id, differs between base and head. An oracle-owned Vite plugin dumps transformed-code hashes and resolved ids per module.
- **E3 reads a changed env var**: `--trace-env` output (main process and workers, through `execArgv`) shows `u`'s realm read the variable, or E5 shows a difference. `--trace-env` is not injected into children, so stderr assertions in child-spawning tests are unaffected.
- **E4 runtime or membership**: the Node version, platform or browser revision differs and `u` runs under it. Or `u`'s project membership changed (newly included, moved between projects). Or the serialized project config differs in a field other than `include`, `exclude` and `dir`, which justify only units whose membership changed.
- **E5 differential execution**: `u`'s execution at head differs from base beyond the noise seen between the two base runs. Execution means the set of executed functions in repo and package code, the set of traced paths, and the outcome. This catches inputs no other evidence names (env read only in a child, a native read).

**Over** = `Selected(case) \ Justified(case) \ Standing`. The selector's reason for each over-selected unit (from `why`) is reported, grouped by the classes in §12.

**Standing** = units the selector selects on the no-op case (head = base, same environment). Examples: opaque units, units with per-run env, `always` entries. Standing is reported once, as its own over-selection figure, with reasons, and subtracted from every other case so each case measures what the change caused. Units failing at base are not in any case, since the bench base is green.

Instrumented runs cover `Selected(case)` for every selector version under test, plus every unit in the designated soft-recall cases (§14.5). Per-unit attribution comes from an oracle setup file that logs `(pid, test file)` per worker, and from the tracer's process tree for children. Browser instrumented runs force `fileParallelism: false` so each file has its own coverage window. Outcomes are taken from the uninstrumented run only.

### 14.4 Case set

Mutations are generated with a fixed seed. Locations are sampled uniformly over runtime tokens. Each mutation must parse and must change runtime tokens. Coverage from the base full run splits the locations: covered locations (most cases, so the mutation likely breaks something) and uncovered locations (where the only correct selection is Standing).

Operators: negate a condition, flip a boolean literal, replace a binary operator (`+`/`-`, `===`/`!==`, `<`/`<=`), off-by-one a numeric literal, change a string literal, delete a statement, replace a return value, drop an `await`, remove an array element or object property, throw at function entry.

| Category                                | Cases (full campaign)                                                                                                                                                                                                                                                                       | Covers                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Source mutations, node projects         | 60: server 20, `shared`/`contracts`/`client-runtime` 20, other packages 10, desktop 5, scripts and relay 5                                                                                                                                                                                  | rows 1, 15                     |
| Source mutations, browser               | 20: web components covered only by browser tests 12, covered by both unit and browser 8                                                                                                                                                                                                     | F8, row 21                     |
| Source mutations, mobile                | 15: `unit` 8, `react` (jsdom, Babel React Compiler) 7                                                                                                                                                                                                                                       | jsdom, transforms              |
| Test-file mutations                     | 15 across projects                                                                                                                                                                                                                                                                          | own file                       |
| Uncovered-location mutations            | 15 across projects                                                                                                                                                                                                                                                                          | expected `Selected = Standing` |
| Fixture and data                        | 15: replay `*.ndjson` (computed paths), effect-acp and codex fixtures, `docs/user/t3-connect-troubleshooting.md`, `?raw` assets (`native/libghostty-vt/VERSION`), sqlite fixture, JSON imports                                                                                              | rows 2, 17, 19                 |
| Child-process files                     | 8: `packages/effect-acp/test/fixtures/acp-mock-peer.ts`, `apps/server/src/bin.ts`, `infra/task-cache/scripts/install.ts`, `.github/scripts/ci-changes.cjs`, codex mock peer, desktop build scripts                                                                                          | F4                             |
| Config                                  | 12: `vite.config.ts` timeouts, `define`, plugin options, `setupFiles` edits; `babel.config.js`; `shardWeights.json` (outcome cannot change)                                                                                                                                                 | row 11                         |
| `include` patterns                      | 6: broaden, narrow, `nomatch/**` (F5: exit code must equal plain Vitest), add a test file, delete one, move a mobile test into `reactTests`                                                                                                                                                 | membership, F5                 |
| `package.json`                          | 8: workspace `exports` redirect and removal, `imports`, `type`, `dependencies` edit without a lockfile change (expected Standing), `version` (only readers), root `engines.node`                                                                                                            | F2, row 8                      |
| tsconfig                                | 6: `apps/web` `paths`, `useDefineForClassFields`, `verbatimModuleSyntax`, `noUnusedLocals` and `strict` (expected Standing), a new nested `tsconfig.json`                                                                                                                                   | F2, row 9                      |
| Lockfile                                | 6: bump a package some units load, a patch change in `patches/`, a package no unit loads (expected Standing), a peer change, a catalog bump, `.repos/**/bun.lock` (expected Standing)                                                                                                       | F9, row 6                      |
| Env vars                                | 8: `T3_MOBILE_TEST_PLATFORM=android`, `CI` unset, `T3CODE_TEST_KEEP_PROVIDER_ENV=1`, `GITHUB_REPOSITORY` (web define), a variable nothing reads (expected Standing), `T3CODE_TELEMETRY_CHANNEL`                                                                                             | F3, row 13                     |
| `.env` files                            | 4: `.env.local` `VITE_HTTP_URL`, an unread key, adding and removing `.env`                                                                                                                                                                                                                  | F3, F6                         |
| Node version                            | 2: 26.12.1 → 24.21.0, → 22.23.4 (installed under mise)                                                                                                                                                                                                                                      | F3, `R`                        |
| Git-ignored inputs                      | 5: a file under `dist/` a test reads, `.generated/`, an ignored fixture, an ignored entry in a listed directory, an ignored file nothing reads (expected Standing)                                                                                                                          | F6                             |
| Comment, whitespace and type-only edits | 15: comments, reformatting, annotations, interfaces, `import type` add and remove, `satisfies` type change. Expected `Selected = Standing`, unless E0 shows an outcome change from shifted positions                                                                                        | §5.2                           |
| Resolution edge cases                   | 6: `foo.js` beside `foo.ts`, `__mocks__/` added, new `import.meta.glob` match (`pdfDocument.ts`), symlink target edit, CRLF-only edit, file named `toString`                                                                                                                                | Fl items                       |
| Tailwind                                | 3: a new class token, a reused token (expected Standing for CSS importers), an `index.css` edit                                                                                                                                                                                             | row 21                         |
| Selector self-change                    | 1: a `packages/test-select` edit (everything)                                                                                                                                                                                                                                               | row 23                         |
| Real upstream commits                   | 50 consecutive first-parent commits of `pingdotgg/t3code` `main` after the fork's merge base. Each is applied in sequence on the bench base (cherry-pick; commits that do not apply are skipped and listed), so each case's base is the previous case's head and carry-forward is exercised | end to end                     |
| No-op                                   | 1: head = base                                                                                                                                                                                                                                                                              | Standing                       |

The smoke campaign takes one case from each row (about 25 cases) for iteration. The full campaign has about 300 cases. Ground truth (§14.2) and base coverage depend only on the case, never on the selector, so they are computed once and cached by (case id, head tree id, environment hash). Each new selector version then costs one plan, one in-job selection and the instrumented runs of its selection. Locally, one test process at a time with `--maxWorkers=6`, ground truth for the full campaign takes many hours. The harness may run it in CI through a `workflow_dispatch` workflow on `select/main`, with the case as an input. Cases are never batched: one change per full run.

Protocol cases are asserted by the harness's own tests rather than by the oracle. Each states its expected result:

| Protocol case                                      | Expected result                                         |
| -------------------------------------------------- | ------------------------------------------------------- |
| Pass followed by an unhandled error (F1)           | no records committed, and the rerun runs the same units |
| Partial run (`-t`, `--tags`, `.only`, line filter) | no commit                                               |
| Child killed with SIGKILL                          | no record                                               |
| Input edited while its unit runs                   | no record                                               |
| Store for another branch, or a prefix match (F7)   | not used                                                |
| Planner exception                                  | fallback outputs                                        |
| Empty selection with a valid `include`             | exit 0 without starting Vitest                          |

### 14.5 Metrics and gates

Per case and aggregated by category and project:

- **Recall gate**: zero misses. Any miss blocks enabling the selector and becomes a permanent regression case.
- **Soft recall**: on the instrumented all-unit cases (one per category, plus every non-code case), units justified by E1, E2, E3 or E5 but not selected. Each one is reviewed. It is either shown unable to change outcome, with the reason recorded, or treated as a miss.
- **Precision**: the Over count and test-seconds, with reasons. Gate: Over is empty on every case marked "expected Standing", and Standing is reported with reasons.
- **Selection size**: selected units and test-seconds, against the full suite and against today's `ci-changes.cjs` package-level selection for the same diff.
- **CI time**: projected PR wall-clock and compute from the plan's matrix. The model uses recorded per-file durations, per-job fixed costs (pickup, checkout, setup, install, Vitest start per shard) and runner sizes. It is validated against real CI runs on `select/main` pushes, with repeated runs because runner variance is up to 2x.
- **Overheads**: plan job wall-clock, in-job selection, transform proof, recording overhead with and without coverage, commit, store size.

## 15. Phases and items to verify

Each phase ships behind shadow mode (run everything, report what selection would have skipped) and passes the smoke campaign before the next phase starts. Selection gates CI only after the full campaign passes.

1. Oracle and harness (`bench/`), with ground truth for the smoke campaign.
2. Store, content ids, `run` wrapper, worker and main recorders, node projects, commit rules, negative markers, module-granular records.
3. Rows 6–10 and 20, `record/child`, opaque detection, produced-input edges.
4. Plan job, matrix, sharding, `collect`, `check`, env and `R` prediction, PR scope.
5. Browser recorder.
6. Static layer: union terms, resolution diff, `why`, audit counters. Then the transform proof.
7. Executed-unit narrowing (function coverage), then block refinement, each gated on the bench showing a CI-time reduction.

To verify before building the dependent phase:

- `NODE_OPTIONS=--import` and `module.registerHooks` reach Vitest 5.1 fork workers under `vp test`, and `vp` does not filter them out.
- The staging reporter can read Vitest's in-memory dependency records, or else it reads `dependencies.json` after `cache._update`.
- Vite's import analysis embeds resolved ids in module-runner transformed code for inlined workspace modules. Otherwise, record resolution edges with a `resolveId` observer and compare those.
- The exact tsconfig options and lookup rules vite-plus-core 1.5.1 applies, and its `resolve.extensions` order.
- Resource timing completeness in `@vitest/browser` 5.1.0 iframes (memory-cache hits, `/@fs/` and optimized-dep URLs), and `Runtime.getIsolateId` windows with several files.
- V8 coverage attribution under Vite's module runner wrapper, and the cost of the `Error.prepareStackTrace` accessor in Effect-heavy server tests.
- Whether a job-level `if` skips a job with an empty dynamic matrix without error.
- How `vp test run` treats absolute file arguments (substring filters).
- `--trace-env` accepted through worker `execArgv`, and `NODE_V8_COVERAGE` source-map-cache entries for Vite-transformed code and bundled config files.
- The share of t3code units that end opaque under rows 16–18, and which addons need vetting.
