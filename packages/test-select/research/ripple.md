# ripple: how it selects tests, and what carries over to t3code

Source read: `/home/jh/.local/state/bsv/vscode-ripple/build/ripple` (README.md, vscode.jsonc, Cargo.toml and every file in `src/`: analyze.rs 2.9k lines, engine.rs 2.3k, graph.rs 1.3k, main.rs, deps.rs, config.rs, git.rs). Line references are to those files. Measurements in the last sections were taken on this worktree (t3code at `bsv/vite-plus-1.5.1`, Node 26.12.1, 18 cores).

## 1. What it is

ripple is a Rust binary (oxc 0.155 parser and semantic analysis, rayon, xxh3) that takes two commits and prints the test files whose outcome the diff can change. Selection is at the level of declarations, not files. The engine knows TypeScript, JavaScript, npm and git; everything about VS Code is in `vscode.jsonc` (`modules`, `pathAliases`, `tests.unit/integration/runners`, `runEverything`, `runEveryIntegrationTest`, `packages`, `injectedGlobals`, `pure`, `implicitMethods`, `moduleLoaders`). Unknown config fields are errors (`deny_unknown_fields`).

Commands: `affected`, `plan` (JSON plus `unit.txt` / `integration.txt` for the runners' `--runList`), `why` (a path from the test to the change), `blame` (commits in a range that can affect a test), `replay` (selection statistics over first-parent history), `stats`.

Cost on VS Code: about 160k nodes and 500k edges; read and analyze 0.5 s, link 0.1 s on 18 cores. CI caches the binary by its sources.

## 2. Pipeline

1. **Snapshot** (`engine.rs` `Engine::snapshot`, `git.rs`). `git ls-tree -r -z --full-tree <rev>` lists every blob; entries are sorted by path and given a `Role` (Asset, Module, UnitTest, IntegrationTest) from the config globs. Modules are read with one `git cat-file --batch` process per rayon chunk. No checkout is needed, so the base and head commits are analyzed side by side. Facts are cached in memory by blob id (`cache: HashMap<oid, FileFacts>`), so `replay` and `blame` parse each file version once. `Engine::apply` builds the next snapshot from a `git diff-tree --no-renames` (renames are a delete plus an add; submodules are skipped).
2. **Analyze** each module into `FileFacts` (`analyze.rs`): declarations, members, hashes, references, imports, exports, loads, path strings, property-name uses, evaluation order, heritage. Analysis never fails: a fatal parse error gives one `<init>` node hashed over the whole source, with `error` and `global_effects` set, and any parse error in either snapshot runs every test.
3. **Link** (`graph.rs` `Graph::build`): resolve specifiers, number all nodes, build the reverse adjacency (CSR), the forward adjacency, per-node name gates and name uses, file-level import graphs (for the comparison baselines), path readers and data-folder readers.
4. **Select** (`engine.rs` `select`): compute seeds in both graphs, add run-everything reasons, walk reverse edges from the seeds to candidate files, confirm each candidate with a gated forward search, keep test files that still exist in head.

## 3. The declaration graph

Node kinds (graph.rs, analyze.rs):

| Node | Created by | Notes |
| --- | --- | --- |
| `<init>` (node 0 of each module) | every module | holds top-level statements that are not declarations; has an edge to node 0 of every module it loads, to each package it loads, and to each pinned declaration |
| declaration | `function`, `class`, `let/const/var` statement (one node per statement, key = joined names), `enum`, runtime `namespace`, `import x = require()`, `export default` | TypeScript-only declarations (interfaces, type aliases, overloads, `declare`) get no node |
| member | enum members, properties of a `const x = {…}` literal (also through `as`, `satisfies`, parens, and pure calls such as `Object.freeze({…})`), runtime namespace exports, static class members, instance methods | keys `X.name` or `X.prototype.name`, `#n` suffix for duplicates; members with the same name (getter/setter) are one dependency |
| `<export>name` | each exported name | content is what the name is bound to (local key, import specifier and name, re-export target) |
| `<export*>` | the `export * from` list | content is the list of specifiers |
| surface | a reference to a whole module | edges to all of the module's nodes, to what its non-local exports resolve to, and to the surfaces of its `export *` targets; a node of its own so re-export cycles are graph cycles |
| package | each npm package name | opaque leaf; `pkg/sub` specifiers map to the package name |
| global | each configured injected global (`globalThis._VSCODE_PRODUCT_JSON`) | seeded when its file changes |
| asset | any non-module file | one node; seeded when the file changes |

Edges point from a node to what it depends on:

- `Ref::Local`: a value reference to another top-level declaration (or to its member when accessed as `X.member` or `X["member"]`), found through oxc's resolved references (`scoping.get_resolved_reference_ids`), so shadowed names do not count. Type references are skipped (`flags().is_value()`).
- `Ref::Import { binding, member }`: resolved through `resolve_binding` and `resolve_export`, which follow named re-exports, `export * as ns`, local `export { a as b }` lists and `export *` (first star target that exports the name wins, plus the `<export*>` node), memoized, depth-capped at 24. Every module on the chain contributes its `<export>name` node, so retargeting an export or re-export selects its users although no declaration changed. A namespace import used as `ns.x` resolves `x`; used bare it depends on the surface. An import that resolves to nothing (a type used as a value, a non-module file) falls back to the surface and is counted as `unresolved`.
- `Ref::All(spec)`: dynamic `import('…')`, `require('…')`, configured module loaders, path strings (section 8). Resolves to a surface, a read path, a data folder or a package.
- parent → each member (`children`), so reaching a whole object reaches its members.
- `<init>` → pinned declarations, loaded modules (node 0), loaded packages.
- state → writer edges for mutable module state (section 6).

Imports whose bindings are used only as types are marked `type_only` and create no load edge (analyze.rs, `pending_imports`). Side-effect imports (`import './x'`) always load. This matches `tsc` without `verbatimModuleSyntax`; see section 12 for why it is wrong for t3code.

Specifier resolution is deliberately small (`Snapshot::resolve_file`, `Linker::resolve_specifier`): relative paths and configured alias prefixes resolve inside the snapshot (`.js` → `.ts`/`.tsx`/`.js`, `.mjs` → `.mts`, extensionless → `.ts`, `/index.ts`, `.js`); anything else that is not a Node built-in, a URL or absolute is a package by name. No `package.json` `exports`, no tsconfig `paths` beyond the aliases, no conditions.

## 4. Hashing

Each declaration's hash (xxh3) covers (analyze.rs, end of `analyze`):

- the bytes of every token inside the declaration's span (oxc `TokensParserConfig`), skipping tokens inside TypeScript-only spans: type annotations, type parameters and arguments, `implements`, index signatures, `this` parameters, interfaces, type aliases, `declare` items, overload signatures, abstract properties, and the type part of `as`, `satisfies`, `!` and `<T>x`. Comments and whitespace are not tokens, so they never affect a hash;
- the AST node kinds in source order (`kind.ty()`), so the same tokens parsed differently (ASI after `return`) hash differently;
- for each `Ref::Import`, the specifier and imported name; for each `Ref::All`, the specifier; for each global, its name. Changing `import { a } from './x'` to `'./y'` changes every declaration that uses `a`. The resolved target is not hashed: a resolution change without a specifier change is only seen through file additions and deletions or a config change;
- in the parent, a marker and the key of each ordered member (object properties, enum members, static fields, namespace members) where it starts, so reordering properties changes the parent but moving methods does not;
- for an enum member without an initializer, the previous member's hash (implicit values).

A member's tokens go to the member, not the parent. The initializer's tokens include all non-declaration top-level statements. Import declarations and `export { … }` lists own no tokens (`Owner::Skip`, `Owner::ExportList`), so editing the import list changes no hash; the edges and ref hashes carry it.

Change detection (`changed_nodes`): for a module present in both snapshots, seeds are head declarations whose `(key, hash)` is new and base declarations whose `(key, hash)` is gone. Added, removed and non-module files seed all their nodes. A declaration renamed counts as removed plus added.

## 5. Load-time effects and evaluation order

The question is which declarations run code when the module is loaded and whether that code can affect anything outside the module.

**Deferred code.** One pass over oxc's node list (parents before children) marks nodes as deferred when they are inside a function body that is not called at load, an instance field initializer, a decorator, or the consequent of `if (C)` where `C` is a top-level `const C = false`. A function expression is not deferred when it is an IIFE or an argument to a call or `new` that itself runs at load (`list.forEach(x => register(x))`), and a local function passed by name to such a call (`[1].map(write)`) is a load-time call of it.

**Escape analysis.** For each load-time call, `new`, assignment, update, `delete`, tagged template, `await`, dynamic import, decorator and static block, `escapes` walks the callee or target to its root identifier:

- an import or an unresolved global → effect outside the module;
- a known pure global (`PURE_GLOBALS`: `Object`, `Math`, `JSON`, `Map`, `console`, `crypto`, `URL`, typed arrays, …) → no effect for calls; any write to a global or a member of one (`Error.stackTraceLimit = …`, `Array.prototype.last = …`, `Object.assign(globalThis.x, …)`) is an effect (`write_escapes`);
- methods in `PURE_METHODS` (`map`, `slice`, `get`, `has`, `includes`, …) on any receiver, calls whose callee is a configured pure function or a method of a configured pure object (`localize`, `URI.parse`), and `Object.*` methods except the mutators are pure;
- a local function, parameter or local variable called directly → `Escape::Call(symbol)`, resolved later.

**Impurity fixpoint.** For each declaration's deferred code, `escaping` (direct effects), `local_calls` and `member_calls` (`X.name()` on a local declaration with that member, `this.name()` in a class or object) are collected. Constructing a class runs its constructor, instance fields and superclass, not its other methods. A fixpoint marks declarations impure when they call something impure or unknown. A load-time call of an impure function, or any load-time escaping effect, sets `global_effects` on the module and `pinned` on the owning declaration.

**Pinned declarations** get an `<init>` → declaration edge. Since every importer's `<init>` depends on the imported `<init>`, any test that loads the module (transitively) depends on all its pinned declarations and what they reference. npm packages are not analyzed, so loading one counts as an effect, and so does loading a `.css` file.

**Evaluation order.** Two mechanisms:

- `FileFacts::order`: the top-level statements and members whose load-time code is order-relevant (an impure call, a read of a `let`/`var`, `new`, assignment, update, `delete`, `await`, tagged template, decorator, static block, or a read of a constant that load-time code writes), identified by declaration key (by content for initializer statements). `reordered` compares the relative order of the entries common to base and head and seeds the ones that moved. Function declarations are hoisted and excluded. Moving pure declarations selects nothing.
- `Graph::effect_sequence`: for each changed module, the depth-first, each-once ESM evaluation order of the modules with global effects and the packages it loads transitively. If the sequence differs between base and head, the module's `<init>` is seeded in both graphs. This catches reordering imports of modules with effects, and loading a module directly that a later import loaded before.

## 6. Mutable module state

`writes: (state, writer)` is collected from load-time code and becomes `state → writer` edges, so readers of the state depend on the code that wrote it:

- assignments, updates and `delete` on a top-level variable or a member of one (`state_of` walks to the root identifier and keeps the first property name, so `X.member = …` writes the member if `X` has a tracked member of that name, else `X` if it is a variable);
- calls of methods on module state that may mutate it (anything not in `PURE_METHODS`), and module state passed as an argument to a non-pure call or `new` of an escaping callee;
- `Object.assign/defineProperty/defineProperties/setPrototypeOf/freeze/seal/preventExtensions` on module state (unless the first argument is a fresh literal);
- writes inside functions, constructors and methods that load-time code calls, transitively through `local_calls` and `member_calls` (`mutated_by`).

A write to a whole object is a write to each of its members, since code reaches members directly (`config.mode`). Reads of constants that some load-time code writes become order-relevant (section 5). Not tracked: writes through an alias (`const list = state.items; list.push(x)`), writes by methods of a local value whose members are not tracked, and writes by other modules except through their pinned code.

## 7. Instance-method gating

Instance methods are members with `gate = name_id(name)` and are not in the parent's `members` list, so `X.method` cannot reach them; only the parent → child edge can. Each node records `uses`: property names it reads (`x.name`, `{ name } = x`, `({ name } = x)`), and identifier-like string literals (`'send'`).

Selection is two-phase (`engine.rs` `dependents`):

1. Reverse closure from the seeds, ignoring gates, gives candidate files and whether any gated node was on the way (`dependent_files`). If none was, the candidates are the answer.
2. Otherwise, for each candidate test, a forward search from all its nodes (`Graph::search`) enters a gated node only once some visited node has used the gate's name; gated nodes reached early wait in `pending` keyed by name. `IMPLICIT_METHODS` (`constructor`, `toString`, `toJSON`, `valueOf`, `then`, `handleEvent`, `next`, `return`, `throw`) and configured ones (`dispose`) count as used from the start.

So a test that constructs a large service depends on its constructor, fields and the methods whose names its reachable code mentions.

Classes that code outside the analysis may call by unseen names are "open": all their methods are ungated (graph.rs, `open_classes`). A class is open when it extends a global, a package class or anything unresolvable or unanalyzed, implements a global or package type, or implements an analyzed interface or alias that (through `type_decls`: interfaces' `extends`, aliases' intersection members, re-exports, `export {}` lists) comes from a package. Openness propagates from superclasses to subclasses by fixpoint. Mixins and computed superclasses are open.

## 8. Path strings, computed paths, fixtures and snapshots

String handling (`analyze.rs` last node pass, `graph.rs` `resolve_path`, `data_dir`, `test_data_folders`, `readers`):

- **Relative or alias strings** (`./`, `../`, or a configured alias prefix; 4–239 chars; no whitespace, `*`, `$`, `{`) outside import specifiers are `Ref::All` from the enclosing declaration. If one names a module, it depends on the module's surface, which includes its `<init>` and so everything it loads: worker and child-process entry points behave like imports. If it names a folder, the folder is a read path, except when more than half of over 30 entries are modules (taken as path manipulation). Otherwise nothing.
- **Root strings** (contain `/`, no leading `/` or `.`, none of `*$?{}:#|<>"\` or `//`): if the path exists, the code depends on the file's content (a read), never on what a module there loads.
- **Computed paths**: a template literal with expressions whose first quasi contains `/` splits into folder and static start; with the last quasi as static end, the code reads the data files (not modules) in that folder whose path in it matches start and end. The folder must exist, contain a matching data file and have at least three segments. `` `./fixtures/${name}/transcript.ndjson` `` reads every `*/transcript.ndjson` under `fixtures`.
- **Test data folders**: folders that are direct children of a directory containing test files and contain no module anywhere below (`__snapshots__`, `fixtures`, `test-cases`). A test in that directory reads the folder when its own source, or a module it loads at runtime, contains the folder name as a path segment of any string or template quasi (`path_segments`). No config names the folders.
- `readers(path)` returns the nodes reading the path itself or any ancestor folder, and, for data files, the matching computed-path folders. These are seeds when the file changes.

In VS Code a snapshot helper in the repository contains `'__snapshots__'`. Under Vitest the snapshot machinery lives in `node_modules`, so no analyzed module mentions `__snapshots__` and ripple's rule would select nothing for a `.snap` change unless the test itself names the folder. A port must map `__snapshots__/<test>.snap` (and `resolveSnapshotPath` overrides) to its test by convention.

## 9. npm packages and lockfiles

`deps.rs` and `engine.rs` `dependency_impact` read only the root `package.json` and `package-lock.json` (exact paths):

- `package.json` field diff: `scripts` changes run everything only for configured test scripts and their `pre`/`post` hooks; dependency fields (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`) mark the changed names; `allowScripts` changes mark the package as installed differently; metadata fields and `ignoredFields` are ignored; any other field changes the `package.json` injected global.
- `package-lock.json`: each `packages` entry whose `version`, `resolved` or `integrity` changed marks its name as installed differently. The `dependencies`/`optionalDependencies`/`peerDependencies` of every entry give a reverse map by name, and the installed set is closed over dependents (so bumping `addon` affects `pty`, which depends on it). Declaring an already installed dependency affects only that name.
- Changed packages seed their package nodes; tests that load the package (directly, or a module that does) are selected. A package that a run-everything script loads (found by analyzing those scripts) or a configured toolchain package runs everything.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` and nested manifests are not read: vscode.jsonc lists them under `runEverything`.

Granularity is the package name: any version change of a package selects every test that loads it, and the dependents closure is by name across versions.

## 10. runEverything, harness modules and CI behavior

- `runEverything` / `runEveryIntegrationTest` are named glob groups; a changed path in a group runs all tests (or all integration tests) with that reason. Changes to ripple or its config are in the group, so the planner's own changes run everything.
- Scripts in those groups are parsed, and the scripts they load through relative imports join the group (`runner_scripts`); packages those scripts import join it too (`runner_packages`).
- **Harness modules**: modules that the test runner scripts name by an alias path anywhere in their text (`alias_paths`, a text scan, e.g. `` `${out}/vs/base/common/uri.js` ``). The runner code's property-name uses decide which exports are roots; if a seed is reachable from those roots (gated search), everything runs. Tests cannot import these, so this is the only way their changes count.
- `plan` writes `select=false` (run everything) when any reason exists. CI treats a planning failure, a missing artifact or a parse error as run everything; planning never fails the detect job. Jobs with nothing selected are skipped.

## 11. Known limits

From the README, with what each means for "no fewer tests":

| Limit | Kind |
| --- | --- |
| Shared mutable global state between test files in one process (registries leaked by an earlier test file) | recall; the two real misses in the CI study |
| Dynamic property access with computed names (`obj[name]()` reaching a gated method) | recall |
| Files read by paths computed without a static folder (`join(dir, name)` with `dir` from elsewhere) | recall, unless the folder name is a string somewhere (test data folders) |
| Module state or globals mutated through an alias, or by methods of untracked locals | recall |
| New files that everything depends on but no `runEverything` glob names; files a run-everything script loads by computed path (gulp globs) | recall, config maintenance |
| Modules named by paths without an alias relative to the build output (`FileAccess.asFileUri('bootstrap-fork')`) | recall, patched by a config group |
| Method order (`Object.getOwnPropertyNames(C.prototype)`) ignored | recall in theory; counting it would select more tests on 44 of 708 commits |
| Methods called by external code on objects that only match a package interface's shape (no `implements`) | recall |
| Strings that only look like paths, computed paths standing for every matching data file, module path strings standing for the module's whole load closure | precision |
| Only unit and integration tests are selected; extension host, browser, remote and smoke suites run in full | scope |

Further gaps found reading the code:

- The resolved target of an import is not part of any hash; a change of resolution with the same specifier (alias config, `package.json` `exports`, a new `foo.js` beside `foo.ts`) is seen only through added or deleted files or a config change.
- `escapes` treats any call of an import as an effect and has no notion of curried pure calls (`f(a)(b)` walks to `f`); the impurity fixpoint is per module, so a call of an imported pure function pins its caller.
- Declaration granularity: a load-time call of a local function depends on the whole function's hash, including code in callbacks it returns or defers.
- Env variables, the Node version and the OS are not modeled; VS Code puts `.nvmrc` and the Electron/Node checksum files in `runEverything` and runs a fixed CI matrix.
- Only committed content is visible (snapshots come from git objects); git-ignored and generated files exist only as asset nodes when tracked.
- `tests` (the cost weight) counts direct `test(...)` and `it(...)` calls; Vitest's `test.each`, `describe` nesting and `it.effect` are not counted.

## 12. Measured precision and recall (from the README)

Replay of 708 merged PRs (first-parent commits on `main`, Oct 13–20, 2026), share of unit test work selected, weighted by tests per file, run-everything counted as 100%:

| Selection | Mean | Median | p90 | Selects nothing |
| --- | --- | --- | --- | --- |
| Everything | 100% | 100% | 100% | 0% |
| File-level imports including types | 21.5% | 8.0% | 66.4% | 12.6% |
| File-level runtime loads | 13.2% | 2.9% | 40.0% | 12.6% |
| ripple, declaration-level | 9.1% | 2.0% | 24.1% | 13.4% |

16 of 708 commits ran everything (12 test job definitions, 2 runners, 1 transpiler, 1 `.npmrc`). Single edit examples: the static `Position.isBefore` selects 836 test files against 1,077 file-level and 1,531 counting type imports; `MoveCaretCommand.getEditOperations` selects one.

The largest single step is file-level imports to runtime loads (21.5% → 13.2%: type-only import elision); declarations add 13.2% → 9.1% on the mean and most on p90 (40.0% → 24.1%).

Recall: of 36 Linux unit test failures caused by the PR's own change (75 failing runs, Oct 17–20), ripple selected 34. Both misses were tests that passed only because earlier test files in the same process leaked registrations; the PR (test-only) stopped the leak. These numbers measure selection size and recall on observed failures; there is no ground truth for tests whose outcome could have changed but did not. The README relies on full runs (every push on one platform, the full matrix after merge) as the safety net.

`blame` found 4 candidates among 55 commits in 18 s for a semantic conflict between two PRs, including both halves.

## 13. How t3code differs

Facts checked in this worktree:

- **2,000 test files** outside `.repos/` (apps/web 541, apps/server 484, apps/mobile 291, packages/client-runtime 156, apps/desktop 101, packages/shared 100, …), 6,566 `.ts`/`.tsx`/`.mts` files, 69.2 MB. Vitest 5.1.0 through vite-plus, several projects (root config plus `apps/desktop`, `apps/mobile`, `apps/server`, `apps/web`, `packages/client-runtime`), `setupFiles` per project, browser-mode projects in `apps/web` (`*.browser.test.tsx`, `test/*.renders.tsx`). No `isolate` override, so each test file gets a fresh module graph; ripple's miss class (registries leaked across test files) does not occur while that holds.
- **`verbatimModuleSyntax: true`** in `tsconfig.base.json`. Probe with `transformWithOxc` from `vite-plus` on a file under `apps/server/src` (picks up its tsconfig):

  ```text
  import { A } from "./a.ts";        // A used only as a type  -> kept: import { A } from "./a.ts";
  import { type B } from "./b.ts";   //                         -> import "./b.ts";
  import type { C } from "./c.ts";   //                         -> removed
  import { D, type E } from "./d.ts";//                         -> import { D } from "./d.ts";
  ```

  With `typescript.onlyRemoveTypeImports: false` all three of A, B and C are dropped. ripple's elision rule would mark the A and B imports as type-only and drop their load edges, missing the load-time effects of `a.ts` and `b.ts`. In t3code, 118 imports have the form `import { type X } from` and are side-effect imports at runtime. A port must decide elision from the tsconfig that applies to each file (`verbatimModuleSyntax`, `preserveValueImports`). Child processes run by plain Node use type stripping, which behaves the same way (checked on Node 26.12.1: `import { A }` with `A` used only as a type and `import { type B }` both load their module), so their files need the same rule.
- **Effect at load time.** Typical modules declare `class X extends Context.Service<…>()("id") {}` and `export const layer = Layer.effect(X, Make.make("…"))`. Under ripple's rules both calls are calls of imports, so both declarations are pinned, the module has global effects, and every test that loads it depends on all such declarations and what they reference. `Effect.gen(function* () {…})` at top level is a call whose callback argument counts as load-time code, so the generator body's calls pin too. Without an Effect-aware purity model the declaration level gains little over runtime file level on server code.
- **Service methods are object literal properties** returned from `Effect.gen` inside a layer, not class methods or top-level `const` object members, so instance-method gating and member nodes rarely apply to services. Gating matters more for the web and mobile code.
- **Workspace packages and paths**: imports of `@t3tools/*` resolve through workspace `package.json` `exports`; `apps/web` uses tsconfig `paths` (`~/*`). ripple's resolver would treat `@t3tools/contracts` as an npm package. The findings report shows `exports` and `paths` edits that break tests without changing any source file.
- **pnpm** (`pnpm-lock.yaml`, `pnpm-workspace.yaml` with catalogs, overrides and patches in `patches/`). ripple reads none of it.
- **Child-process entry points** are named by relative strings: `path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts")` in effect-acp tests and `new URL("./bin.ts", import.meta.url)` in `cliCompileCache.test.ts`. ripple's path-string rule turns both into dependencies on the module and its load closure, which covers the two child-process misses in the findings report that runtime read recording cannot see.
- **Fixtures**: `apps/server/src/orchestration-v2/testkit/fixtures/*` mixes modules (`input.ts`, `output.ts`, imported normally) and data (`*.ndjson`, read through `new URL("./fixtures/simple/registry_transcript.ndjson", import.meta.url)` and `` new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url) ``), which the path-string and computed-path rules cover. The folder contains modules, so the test-data-folder rule does not apply.
- **No snapshot assertions** today (`toMatchSnapshot`, `toMatchInlineSnapshot`, `toMatchFileSnapshot` do not occur outside `.repos/`); the convention mapping in section 8 is still needed for the first one.
- **Other inputs**: 431 `process.env` reads in `.ts` files, `define` in the web config fed by env files, Tailwind in `apps/web` (generated CSS depends on class names scanned from all sources, which matters to browser tests that assert styles), one `import.meta.glob` (`apps/web/src/components/files/pdfDocument.ts`), and `vi.mock` in 360 files (a `vi.mock("./x.ts")` string is a path string, so the test depends on `x.ts` whether or not the mock replaces it; correct but coarse).
- **`.repos/`** holds vendored repositories with their own tests and lockfiles; it must be outside `modules` and outside any run-everything group.

Parse cost: `oxc-parser` 0.148 (already in `node_modules`) parses all 6,566 files, materializing the ESTree AST in JS, in 1.49 s on one thread with 0 errors and 53,243 static imports. Analysis in JS will add to that; a blob-id cache keeps incremental runs to the changed files.

## 14. Ideas to implement in TypeScript

oxc is available as `oxc-parser` (ESTree AST, `module` record with static imports/exports, dynamic imports, `import.meta`; no scope analysis exposed, so top-level symbol resolution has to be written over the AST) and `oxc-resolver` (`package.json` `exports`/`imports`, conditions, tsconfig `paths` and `extends`; reads the real filesystem).

Effort: S under a day, M a few days, L a week or more, for a working, tested version in this package. Payoff is stated against file-level runtime selection unless noted.

| # | Idea | Effort | Payoff for exact, fast selection |
| --- | --- | --- | --- |
| 1 | Snapshots from git objects (`ls-tree`, `cat-file --batch`), facts cached by blob id plus analyzer and config version | S | Base and head analyzed without checkouts, and only blobs not in the cache are parsed. An entry is a function of content and analyzer version, so an honest entry is valid on every branch, unlike the plugin's per-run snapshot (findings issue 7); a dishonest writer could still poison it, so restore only entries written by trusted jobs. Resolution against the base tree needs an in-memory resolver (see 4) because `oxc-resolver` reads the disk. |
| 2 | File-level runtime load graph with elision decided per tsconfig (`verbatimModuleSyntax`) | S | The step that gave most of ripple's reduction over type-aware file level (21.5% → 13.2% in VS Code). Must follow Vite's rule shown in section 13, or it loses recall. |
| 3 | Resolution diff: resolve every specifier in base and head, and seed the referencing declarations (or files) whose resolved target changed | S–M | Makes `package.json` `exports`/`imports`, tsconfig `paths` and new resolution candidates precise instead of run-everything (findings issue 2 and the `foo.js`/`__mocks__` edge cases). Requires the resolver to know which manifest and tsconfig fields it read, so their own edits are covered. |
| 4 | Snapshot resolver: workspace packages through their `package.json` `exports`, tsconfig `paths`, `.ts`/`.tsx` candidates; everything in `node_modules` is a package node by name | M | Needed by 1 and 3 for the base snapshot. Packages stay opaque, as in ripple. |
| 5 | Declaration nodes, member nodes, export nodes, surfaces, re-export resolution with `<export>` nodes | L | 13.2% → 9.1% mean, 40% → 24% p90 in VS Code. Unknown for t3code until 6 exists; measure with the replay harness before committing to it. |
| 6 | Token hash per declaration that skips comments, whitespace and type-only syntax, plus node kinds | M (with 5) | Type-only and comment-only edits select nothing. t3code sets `erasableSyntaxOnly`, so enums, runtime namespaces and parameter properties do not occur and need no member model. With `emitDecoratorMetadata` (not used here) type annotations would be runtime. File-level variant (hash the file's runtime tokens) gets the type/comment benefit with idea 2 alone: S. |
| 7 | Load-time effect model with an Effect-aware purity config: pure objects by name with per-method exceptions (`Effect.run*`, `Layer.launch`, `ManagedRuntime.make` run code), curried pure calls (`Context.Service<…>()("id")`, `Effect.fn("n")(…)`), and callbacks of pure combinators treated as deferred (`Effect.gen`, `Effect.sync`, `Layer.effect`, `Schema.transform`) | M | Without it, server modules pin nearly every declaration and 5 degrades to file level there. A wrong entry in the pure list is a recall bug, so the list needs tests that a load-time `Effect.runSync` or `Effect.runFork` still pins. |
| 8 | Cross-module purity summaries (a function whose body has no escaping effects is pure for callers in other modules) | M | Unpins `Layer.effect(X, Make.make("…"))`-style declarations where `make` only builds an Effect. Needs a fixpoint over the import graph; worth it only if 7 leaves many pinned declarations. |
| 9 | Evaluation-order seeds (`order` + `effect_sequence`) | S (with 5, 7) | Recall for reordered side-effect imports and statements; required once declarations exist. |
| 10 | Mutable state writes, including writes inside functions that load-time code calls | M (with 5) | Recall for module-level registries filled at load (`state → writer` edges). Aliased writes stay a gap; a conservative fallback is to treat any binding initialized from module state as that state. |
| 11 | Instance-method gating with the two-phase reverse/forward search | M (with 5) | Precision for web and mobile classes; little for Effect services (section 13). For recall, treat a computed member access with a non-literal key as using every name, and consider counting method order (ripple measured the cost at 44 of 708 commits). Open-class rules must include classes passed to packages by shape only; one conservative approach is to count the property names used in the JS of the packages a test loads. |
| 12 | Path strings, root paths, computed paths, test data folders | S–M | Recall for child-process entry points (both findings issue 4 cases are relative strings), fixtures and `new URL(…, import.meta.url)`. Works at file level too. |
| 13 | Snapshot convention: `__snapshots__/<test>.snap` and `resolveSnapshotPath` map to their test | S | Recall for `.snap` edits, which ripple's folder-name rule misses under Vitest. |
| 14 | pnpm lockfile diff per package: read `importers` and `snapshots`/`packages` of `pnpm-lock.yaml`, mark packages whose resolution, integrity, patch or peer suffix changed, close over dependents, seed package nodes; catalogs, overrides and `patchedDependencies` resolve to the same per-package changes | M | Turns a dependency bump from run-everything into the tests that load the package or its dependents (findings issue 9), and scoped to t3code's own lockfile, not `.repos/`. |
| 15 | Run-everything groups and harness roots, with Vitest specifics: each project's config file and what it imports, `setupFiles` and `globalSetup` closures as roots of every test in the project, the Node version (`engines.node`, `.nvmrc`), the Vitest version, the CI workflow and the selector itself | S | Recall for findings issues 2 and 3 that the module graph cannot see. Setup files as roots instead of run-everything keeps precision. |
| 16 | Env variables as global nodes: `process.env.NAME` and `import.meta.env.NAME` reads become `Global("env:NAME")`; a run hashes the values of the names read, plus env files Vite loads, and seeds the changed names; a computed `process.env[x]` depends on all of them | M | Precise handling of findings issue 3's env cases instead of hashing the whole environment. |
| 17 | `why` (shortest path from a test to a seed, with the name that opened each gated method) | S | Lets a person check a selection; cheap once the graph exists. |
| 18 | `replay` over first-parent history comparing file level, runtime file level and declaration level, and `blame` | S–M | The evaluation harness for this package; it also answers whether 5–11 pay for themselves on t3code. |
| 19 | Fail-open plan output: any parse error, resolver failure or unknown input means run everything with a reason | S | Keeps a broken selector from skipping tests. |

Order that follows from the effort and payoff: 1, 2, 4, 3, 12, 13, 15, 19 give a file-level selector with ripple's non-module coverage and the fixes for the findings report; 14 and 16 remove most run-everything cases; 18 measures it; then 5–11 in that order if the replay shows the declaration level would select less on t3code.

## 15. What static analysis cannot see, and what covers it

Static selection misses what is computed at runtime (paths without a static folder, computed property names, reads by packages, aliased writes). Runtime read recording, as in `@useblacksmith/vitest`, misses what happens outside the Vitest worker (child processes, Vite's main process reading `package.json` and tsconfig, browser mode) and everything a passing run did not touch. Of the selection misses in the findings report, the child-process, `package.json`/tsconfig and browser-mode ones are covered by ripple's path-string rules, a resolution diff (idea 3) or a static graph that does not depend on a run. Env values and git-ignored inputs are missed by both approaches and need explicit modeling (ideas 15 and 16, and a decision on which untracked files count as inputs). A selector that takes the union of both (a test runs when either its static closure or its last recorded reads changed) has the misses of neither alone, at the cost of the union's size; whether that cost is worth paying is a question for the replay harness.
