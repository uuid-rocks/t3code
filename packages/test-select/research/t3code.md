# t3code test setup

Map of how t3code (worktree `select/main`, based on `bsv/vite-plus-1.5.1`: vite-plus 1.5.1, Vitest 5.1.0, Node 26.12.1, pnpm 12.14.0) defines, runs and feeds its tests, written for building `packages/test-select`. Numbers are from 2026-11-10.

## 1. Inventory

- 31,909 tracked files; 7,789 outside `.repos/`. `.repos/` holds vendored reference repos (effect, alchemy-effect) with ~4,100 test files of their own. Every config excludes `**/.repos/**`, CI sparse checkouts drop it, and `git ls-files` over the whole tree is >1 MB (Node's default `execFileSync` buffer overflows; pass `-- ':!.repos'`).
- 2,015 test files outside `.repos/` (`*.test|spec.{ts,tsx,mjs,cjs,js}` plus `*.renders.tsx`). No `__snapshots__`, no `.snap` files, and no `toMatch*Snapshot`/`toMatchScreenshot` calls anywhere.
- Workspace (`pnpm-workspace.yaml`): `apps/*`, `evals`, `infra/*`, `oxlint-plugin-t3code`, `packages/*`, `scripts`. 41 manifests, 35 with a `test` script, all `vp test run …`.

| Package (dir) | Test files | Config | Projects / environment |
|---|---|---|---|
| `t3` (apps/server) | 484 | own `apps/server/vite.config.ts` (merges root) | one node project, `fileParallelism: false`, custom sequencer |
| `@t3tools/web` (apps/web) | 541 run in CI (348 unit + 193 browser) + 2 render scenarios | own, does not import root | `unit` (node), `browser` (Playwright Chromium), `renders` (browser, not run in CI) |
| `@t3tools/mobile` (apps/mobile) | 292 | own, does not import root; package is CommonJS (no `"type"`) | `unit` (node), `react` (jsdom, explicit list of 41 files, Babel React Compiler transform) |
| `@t3tools/desktop` (apps/desktop) | ~110 (incl. 2 in `native/kde-snap-shot`, 4 `.mjs` in `scripts/`) | own, does not import root | one node project, `include` adds `../../native/kde-snap-shot/src/*.test.ts` |
| `@t3tools/client-runtime` | 156 | own minimal config | node, `src/**/*.test.ts` |
| `@t3tools/shared` | 100 | root config via `--config ../../vite.config.ts --dir .` | node |
| `@t3tools/scripts` (scripts) | 36 | root config (`--config ../vite.config.ts`) | node |
| `t3code-relay` (infra/relay) | 36 | root config | node |
| `@t3tools/contracts` | 32 | root config | node |
| `oxlint-plugin-t3code` | 30 | root config | node (one file sets `@vitest-environment jsdom`) |
| 25 more packages (`provider-*`, `source-control-*`, `effect-acp`, `effect-codex-app-server`, `ssh`, `tailscale`, `secret-provider-*`, `infra/task-cache`, `evals`) | 1–22 each | root config | node |

Outside Vitest, CI also runs `.github/scripts/*.test.cjs` with `node --test`, `.github/scripts/stage-preview-bundle.test.py` with python, and Rust tests (`test:resource-monitor`, cargo). These run unconditionally in the `test` job and are not Vitest's concern, but a repo-root `vp test run` would collect the `.test.cjs` files into the `root` project (unverified whether they fail there).

## 2. Vitest configs

### Root `vite.config.ts`

Loaded directly by the 28 "borrowing" packages (`vp test run --config ../../vite.config.ts --dir .`, cwd = package dir) and merged into `apps/server`'s config.

- Imports `infra/task-cache/src/remoteCache.ts` and `scripts/lib/cached-tests.ts`. `remoteCacheUrl()` reads `.task-cache.json` (tracked) and `~/.config/t3-task-cache/credentials.json` (outside the repo). Only the `run` (task) block uses them.
- `test`: `environment: "node"`, `exclude` (`.repos`, `.t3`, `node_modules`, `dist`, `dist-electron`, dot dirs), 60 s hook/test timeouts, `retry: 0`, `allowOnly: !process.env.CI`, `env: { VP_REMOTE_CACHE: "off", VP_REMOTE_CACHE_URL: "" }` (fixture subprocesses), full `fakeTimers.toFake` list.
- `setupFiles`: `packages/shared/src/testing/longTempDir.ts` (imports `packages/shared/src/HostProcess.ts`; canonicalizes TEMP on Windows) and `packages/shared/src/testing/providerEnv.ts` (deletes every `ANTHROPIC_*`, `CLAUDE_*`, `CODEX_*`, `OPENAI_*`, `T3CODE_*` env var except `T3CODE_TRANSFER_BUDGET_REPORT_PATH`, `T3CODE_TRANSFER_BUDGET_RESULT_PATH`, `T3CODE_TEST_HEADLESS_SHELL`, unless `T3CODE_TEST_KEEP_PROVIDER_ENV=1`). Every package config repeats these two setup files, so they are inputs of almost every test.
- `resolve.alias`: `~` → `apps/web/src`.
- When `process.cwd()` is the repo root, `test.projects` = the five own-config packages (`apps/desktop`, `apps/mobile`, `apps/server`, `apps/web`, `packages/client-runtime`) plus a `root` project for everything else. This is only for repo-root runs such as `vp test run <file>` and the `test:perf:v2-wire` script; CI always runs per package.
- `run.tasks` gets `cachedTestTasks(process.env.T3_CACHED_TESTS)`: the env var turns the config into a generator of per-file cached test tasks (see §3.3).

### `apps/server/vite.config.ts`

- Spreads the root config minus `projects` and `run`, then sets `fileParallelism: false` ("parallel sqlite/git/worktree/orchestration tests introduce load-sensitive flakes"), `hookTimeout`/`testTimeout` 120 s, extra `setupFiles` `src/testUtils/gitConfig.setup.ts` (injects `GIT_CONFIG_COUNT/KEY/VALUE` for autocrlf, filemode, gpgsign, `init.defaultBranch=main`) and `src/testUtils/managedServiceEnv.setup.ts` (deletes `T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT`, the launcher-context var; imports `src/cloud/serviceProtocol.ts`).
- `sequence.sequencer: WeightedShardSequencer` (`src/testUtils/weightedShardSequencer.ts`).
- Config-time imports: root config, `scripts/lib/public-config.ts` (`loadRepoEnv()` reads `.env` and `.env.local` at the repo root), root and server `package.json`, `scripts/lib/cli-external-packages.ts`, the sequencer and `shardWeights.json`. Throws at load if `T3CODE_TELEMETRY_CHANNEL` is set to an unknown value. `T3CODE_PACK_EXE*`, `T3CODE_CLI_ASSET_DIR` and the `.env` values only affect `pack`, not tests.

### `apps/web/vite.config.ts`

- Does not import the root config. Root-only settings (`retry`, `allowOnly`, `fakeTimers`, `env`, 60 s timeouts) do not apply; `unit` re-lists the two shared setup files.
- Config-time: `loadRepoEnv()` then `Object.assign(process.env, repoEnv)`, so `.env`/`.env.local` values enter the test process environment. `define` bakes `import.meta.env.*` from env: `VITE_WS_URL`, `VITE_HTTP_URL`, relay URL, Clerk keys, OTLP settings, `VITE_HOSTED_APP_URL` (or `VERCEL_ENV`/`VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL`), `VITE_HOSTED_APP_CHANNEL`, `VITE_RELEASE_CHANNEL`/`T3CODE_BUILT_DEV`, `APP_VERSION` (falls back to `package.json` version), `T3CODE_DESKTOP_UPDATE_REPOSITORY` falling back to `GITHUB_REPOSITORY` (differs between the fork and upstream CI), `T3CODE_FEATURE_SECRETS`. Also reads `PORT`, `HOST`, `T3CODE_SINGLE_ORIGIN_DEV`, `T3CODE_BUNDLED_DEV`, `T3CODE_WEB_SOURCEMAP`, `T3CODE_DEV_ALLOWED_HOSTS`, `T3CODE_PORT`.
- Plugins active in tests: `tanstackRouter` (generates the tracked `src/routeTree.gen.ts`), `react({ compiler: true })`, Tailwind, a license plugin reading `third-party-licenses.config.json` and the web/server/desktop `package.json`s, and local plugins from `apps/web/vite/`. Imports `scripts/lib/public-config.ts`, `scripts/lib/third-party-licenses.ts`, `pdfjs-dist/package.json`.
- `resolve.tsconfigPaths: true` (`apps/web/tsconfig.json`: `~/*` → `./src/*`), `resolve.alias` for `@betteroffice/fonts-cjk`, `dedupe` react/react-dom, `assetsInclude: **/*.wasm`.
- Projects: `unit` (`src/**/*.test.{ts,tsx}` minus `*.browser.test.*`, 15 s timeouts), `browser` (`src/**/*.browser.test.{ts,tsx}`, Playwright Chromium headless, `setupFiles: ./test/browserSetup.ts`, API port hashed from the checkout path into 61000–64999, large `optimizeDeps.include`), `renders` (`test/*.renders.tsx`, run only by `scripts/render-metrics.ts`, needs `T3CODE_RENDER_REPORT_DIR`). The package script selects `--project unit --project browser --passWithNoTests`.

### `apps/mobile/vite.config.ts`

- No root import. Uses `createRequire` to load `@babel/core` and `./babel.config.js` (CommonJS, not in Vite's module graph). `T3_MOBILE_TEST_PLATFORM` (`ios` default, or `android`) changes the Babel caller platform for the `react` project.
- `unit`: `**/*.test.{ts,tsx,mjs}` minus `node_modules` and the 41-file `reactTests` list, so it includes `app.config.test.ts`, `plugins/`, `scripts/`, `modules/*/` tests. `react`: exactly the `reactTests` list, `environment: "jsdom"`, a `pre` transform running Babel with the React Compiler on `src/**/*.ts(x)` (non-test) files. Moving a test in or out of that list changes which project runs it.

### `apps/desktop/vite.config.ts` and `packages/client-runtime/vite.config.ts`

- Desktop: no root import; imports `scripts/lib/desktop-external-packages.ts`, `scripts/lib/public-config.ts` (`.env` for a pack-time define). Test: `defaultInclude` plus `native/kde-snap-shot`, 15 s timeout, the shared setup files. `scripts/main-process-bundle.test.mjs` imports `../vite.config.ts` and calls `vite-plus/pack` `build()`.
- client-runtime: node, `src/**/*.test.ts`, shared setup files. Nothing else.

### Resolution facts that matter

- Workspace packages export source, not builds: `exports` in `packages/*/package.json` point at `./src/*.ts` (`@t3tools/shared` has 135 subpath exports, `@t3tools/client-runtime` 138, no root export). A `package.json` `exports` edit changes module resolution for importers in other packages.
- `tsconfig.base.json` has no `paths`. Only `apps/web/tsconfig.json` has `paths` (`~/*`), mirrored by the root `~` alias. tsconfig otherwise affects nothing at runtime except `tsconfigPaths` in web.
- 360 test files call `vi.mock` (159 web, 119 mobile, 34 desktop, 26 server). No `__mocks__` directories. No `import.meta.glob` in tests.
- `?raw`/`?url` imports in tests reach outside packages: `native/libghostty-vt/VERSION?raw`, `native/libghostty-vt/include/ghostty/vt/key/event.h?raw`, `apps/web/index.html?raw`, `pdfjs-dist` worker, `sql.js` wasm, a font file under `node_modules/@betteroffice/fonts`.

## 3. CI (`.github/workflows/ci.yml`)

### 3.1 Jobs

| Job | Runner | What it runs | Gate |
|---|---|---|---|
| `changes` | 2 vCPU | sparse checkout of manifests + `.github/scripts/ci-changes.cjs` | always |
| `test` | 8 vCPU | `vp run --parallel --concurrency-limit 4 <filters> test` over every package except `t3`, `@t3tools/web`, root; plus node:test, python and Electron install (`ensure:electron`), apt `libsecret-1-dev pkg-config` for the desktop browser-secret helper | `test` output; `test_packages` narrows the filter |
| `test_web` | 8 vCPU | `vp run --filter @t3tools/web test` with Chromium headless shell (cached by Playwright version) | `test_web` |
| `test_server` ×8 | 4 vCPU | `vp run test:cached -- --shard i/8 --uncached apps/server/integration/transferBudgetV2.integration.test.ts --verify-hits 1 --report … apps/server`, Chromium for server browser tests | each shard runs `ci-changes` itself and stops after checkout when `test_server` is false |
| `check` | 2 vCPU | requires every job to succeed or to be skipped by its gate; requires the `thread-transfer-results` artifact when server ran | always |

`release.yml` mirrors the split but runs `vp run --filter t3 test --shard i/8` (no task cache). `windows-tests.yml` is manual (`workflow_dispatch`, optional package/files). Setup is `./.github/actions/setup-ci-deps`: cached `~/.vite-plus`, pnpm store tarball keyed by `pnpm-lock.yaml`/`pnpm-workspace.yaml`/`package.json`, `vp install`. The shared remote task cache is enabled only when `github.repository == 'pingdotgg/t3code'`, so on the fork every server shard runs with an empty task cache.

### 3.2 Change detection (`ci-changes.cjs`, shared with `scripts/check-changed.ts`)

Package-granular. For a PR it diffs `HEAD^1..HEAD` of the merge commit (`--no-renames`); pushes to `main`/`bsv/main` pass `--full`. Fails open.

- Inert: `docs/`, `.agents|.cursor|.vscode|.devcontainer|.macroscope|.repos/`, root `*.md`, `LICENSE` (plus `EXTRA_OWNERS` matches, e.g. `docs/user/t3-connect-troubleshooting.md` → `t3`).
- Runs everything: any `package.json`, `packages/shared/src/HostProcess.ts`, the two shared setup files, `apps/mobile/deps/`, and any path no package owns (root `vite.config.ts`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.github/**`, `patches/`, `.pnpmfile.cjs`).
- Extra owners for reads not visible in manifests: `scripts/lib/` → desktop, mobile, web, t3 (configs import it); `native/browser-secret|kde-snap-shot` → desktop; `native/libghostty-vt` → web; `apps/desktop/gnome-extension` → scripts; Rust crates → scripts.
- Owners then expand to transitive dependents (workspace deps; `t3`'s build-only dep on web excluded), then `TEST_ONLY_DEPS` (`evals` reads `t3` source, `provider-pi` reads client-runtime, `scripts` tests read desktop/mobile/web/t3/provider-cursor).

Effect today (number of test files whose package gets selected, from `decide()`):

| Changed file | Packages | Test files |
|---|---|---|
| `packages/shared/src/git.ts` | 35 | 1,921 |
| `packages/contracts/src/index.ts` | 37 | 1,954 |
| `packages/source-control-github/src/index.ts` | 11 | 1,686 |
| `packages/client-runtime/src/clock.ts` | 7 | 1,176 |
| `apps/web/src/main.tsx` | 2 | 577 |
| `apps/server/src/server.ts` | 3 | 526 |
| `pnpm-lock.yaml` | all | 2,006 |

### 3.3 Server sharding and `test:cached`

- `scripts/test-cached.ts --shard i/8 apps/server` calls `shardedTestFiles()` (`scripts/lib/sharded-tests.ts`: `createVitest` in `apps/server`, `globTestSpecifications`, the config's sequencer `shard()`), then sets `T3_CACHED_TESTS={files, groupSize, uncached}` and runs `vp run test-cache`. The root config turns that into one `vp` task per group (`groupSize` 1 in CI, so one task and one `vp test run '<file>'` process per test file, cwd = owning package), cached with `input: [{auto:true}, "!**/node_modules/.vite/**", "!**/node_modules/.vitest-cache/**"]`. `{auto:true}` is vite-plus file-system tracking: files read, missing-file probes and directory listings by the command. vite-plus does not track env reads; tasks run with a filtered environment (only `PATH`, `HOME`, `CI` and a few others pass through unless listed in `cache.env`/`untrackedEnv`).
- `--uncached` keeps `transferBudgetV2.integration.test.ts` out of the cache (it writes the transfer-budget report CI requires). `--verify-hits 1` reruns one cache hit with `--no-cache`, chosen by hashing run id + task name.
- `WeightedShardSequencer.shard()`: sort files by recorded seconds (desc, then path), greedy assign each to the currently lightest shard, keep those landing on `index-1`. Weights: `apps/server/src/testUtils/shardWeights.json`, 214 entries summing to 392.6 s (4 for deleted files), last updated 2026-10-27. 274 of the 484 server test files have no entry and count as 0.6 s. Heaviest: `AcpAdapterV2.test.ts` 25.5 s, `ProviderSwitch.integration.test.ts` 16.1, `GitManager.test.ts` 13.7, `ClaudeReplayFixtures.integration.test.ts` 13.7, `serviceLauncher.test.ts` 11.2.
- Each shard depends on the full file list: adding or removing a server test file reassigns other files between shards. A selector that shards its own selection must not reuse this split for unrelated reasons.

## 4. Durations

From fork CI runs on 2026-11-10 (Blacksmith runners):

| Job | Upstream CI (`test:cached`, empty cache), run 42895681295 | Plain `vp test run --shard`, run 42915717591 |
|---|---|---|
| server shard Test step | 105–145 s (57 files, 57 processes on shard 1) | 75–118 s (shard 1: 57 files, Vitest `Duration` 117.8 s) |
| server shard job | 153–190 s | 101–146 s |
| `test_web` Test step | 87 s | 95 s (541 files, Vitest `Duration` 92.8 s) |
| `test` Test step | 125 s | 101 s |
| checkout + setup per job | ~10 s + 13–18 s | ~10 s + 7–9 s |

- On the fork, `test:cached` with an empty cache costs ~25–30 s per server shard compared with one Vitest process per shard: 57 Vitest startups and server config loads.
- Server total ≈ 8 × 100 s of 4-vCPU runner time; a server test file averages ~1.5–2 s including import. Import is ~24% and tests ~65% of server Vitest time.
- Web: unit 348 files with per-file test time summing to 28 s; browser 193 files summing to 255 s. Browser dominates `test_web`.
- `test` job, per-package Vitest `Duration` from the same run: mobile 292 files 95.4 s (the job's long pole), client-runtime 156 files 26.4 s, oxlint-plugin 30 files 23.0 s, a 4-file package 18.2 s, desktop 110 files 17.4 s, a 6-file package 15.0 s, relay 36 files 13.0 s, scripts 36 files 12.4 s, shared 100 files 11.5 s, contracts 32 files 3.0 s, most small packages 1–5 s. Four packages run at a time, so the job takes about as long as mobile.
- Local, warm, 6 workers: `packages/source-control-core` (5 files, 57 tests) runs in 0.97 s wall (`Duration` 1.20 s); `vp test list --filesOnly` for it takes 0.32 s. That is the floor for one Vitest invocation with the root config.

## 5. Test inputs outside the static import graph

What a selector has to treat as an input for tests to stay exact. Counts are test files outside `.repos/`.

### 5.1 Config-level inputs (affect every test of a project)

- Each config file and everything it imports: root config → `infra/task-cache/src/remoteCache.ts`, `scripts/lib/cached-tests.ts`, `.task-cache.json`, `~/.config/t3-task-cache/credentials.json`; server → root config, `scripts/lib/public-config.ts`, `scripts/lib/cli-external-packages.ts`, both `package.json`s, sequencer, `shardWeights.json`; web → `scripts/lib/public-config.ts`, `scripts/lib/third-party-licenses.ts`, `apps/web/vite/*`, `third-party-licenses.config.json`, web/server/desktop `package.json`, `pdfjs-dist/package.json`, `apps/web/tsconfig.json`; mobile → `babel.config.js` (and the Babel presets in `node_modules`); desktop → `scripts/lib/desktop-external-packages.ts`, `scripts/lib/public-config.ts`.
- Setup files: `packages/shared/src/testing/{longTempDir,providerEnv}.ts` and `packages/shared/src/HostProcess.ts` (all packages); `apps/server/src/testUtils/{gitConfig,managedServiceEnv}.setup.ts` + `src/cloud/serviceProtocol.ts`; `apps/web/test/browserSetup.ts`.
- Git-ignored `.env` and `.env.local` at the repo root (`.gitignore` has `.env*` with `!.env.example`): read by web (into `process.env` and `define`), server and desktop (pack-only).
- Lockfile, `patches/`, `.pnpmfile.cjs`, `pnpm-workspace.yaml` catalog: change installed dependency code. Vitest externalizes `node_modules`, so dependency files never appear in its module graph.

### 5.2 Environment and toolchain

- Config time: `CI` (`allowOnly`), `T3_CACHED_TESTS`, `VP_REMOTE_CACHE*`, `T3_MOBILE_TEST_PLATFORM`, `T3CODE_TELEMETRY_CHANNEL`, and the web list in §2 including `GITHUB_REPOSITORY` and `VERCEL_*`.
- Test time: 52 test files read `process.env` directly (`PATH`, `HOME`, `T3_SERVICE_LAUNCHER_CONTEXT`, `T3CODE_DESKTOP_CLI_LAUNCHER`, `APPIMAGE`, `APP_VARIANT`, `EAS_PROJECT_ID`, `JAVA_HOME`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, …). `providerEnv.ts` deletes the provider prefixes first, so those variables cannot change outcomes, except the three it keeps and `T3CODE_TEST_KEEP_PROVIDER_ENV`.
- Conditional tests: `skipIf(!symlinksSupported)` ×58, platform checks (`HostProcess.Platform`, `windowsHost`, `process.platform`) ×95, `skipIf(process.getuid === undefined)`, `skipIf(process.env.CI)`, `runIf(process.env.T3_TEST_NU_PATH !== undefined)`, `runIf(builtinFetchUsesHttp2(process.versions.undici))` (Node version), `skipIf(posixShellRunner === null)`, `skipIf(hostPlatform !== "linux")` for the libsecret helper. Node version, OS and installed tools change which tests run.
- External binaries: real `git` in server (27+ files), source-control, client-runtime, mobile, scripts tests; `cc`/`pkg-config`/`libsecret` (desktop `browser-secret-native.test.mjs`); Chromium headless shell (web browser project; 11 server files under `preview/`, `htmlRender/` and others via `playwright-core`); Electron runtime (desktop job installs it).

### 5.3 Child processes

- ~175 test files touch child processes: 80 server, 23 desktop, ~15 scripts, the rest across packages. 53 spawn `process.execPath` (Node) on a repo file, which Vitest never sees in its module graph. Examples: `infra/task-cache/src/runHook.test.ts` runs `../scripts/install.ts` and `install-ci.ts`; `packages/effect-acp/src/client.test.ts` and `effect-codex-app-server` run mock peers from `test/fixtures/`; `scripts/check-changed-command.test.ts` runs a generated `run.mjs`; desktop `scripts/*.test.mjs` run builds and bundles; server `cliCompileCache`, `serviceLauncher`, `device/*`, `provider/acp/*`, `orchestration-v2/Adapters/Acp*` spawn scripts or the CLI.
- 11 files spawn `vp`/`pnpm`/`bun`/`tsx`. The root config's `test.env` sets `VP_REMOTE_CACHE=off` for them.

### 5.4 Files read at runtime

- 55 test files use `readFileSync`, 38 `readFile(`, 64 build paths from `import.meta.url`, 19 import JSON, 57 mention `package.json`.
- Replay fixtures: `apps/server/src/orchestration-v2/testkit/fixtures/` (103 directories, 383 files) read by path templates, e.g. `new URL(\`./fixtures/${path}/claude_transcript.ndjson\`, import.meta.url)`. Others: `apps/server/src/peer/fixtures`, `apps/server/integration/fixtures`, `packages/effect-acp/test/fixtures`, `packages/effect-codex-app-server/test/fixtures`, `apps/web/test/fixtures`, `scripts/fixtures`.
- Non-JS inputs across packages: `ConnectReachability.test.ts` checks headings in `docs/user/t3-connect-troubleshooting.md` (inside an otherwise inert `docs/`); `scripts/build-desktop-artifact.test.ts` reads Rust crate sources and `apps/desktop/gnome-extension`; `scripts/check-changed.test.ts` imports `.github/scripts/ci-changes.cjs` (CommonJS, loaded by Node, outside Vite's graph) and copies it into a temp repo.
- Directory enumeration (77 files use `readdir`/glob/`git ls-files`). Whole-tree scans whose result depends on which files exist: `apps/web/src/reactCompilerCoverage.test.ts` (compiles every non-test `.ts(x)` under `apps/web/src` with `oxc-transform-react`; any web source edit or addition changes it), `apps/mobile/src/reactCompilerCoverage.test.ts`, `apps/mobile/src/dependency-graph.test.ts` (walks `apps/mobile/src`, resolves platform extensions), `scripts/lib/cli-external-packages.test.ts`, `scripts/knip-schemas.test.ts`.
- Tests importing configs: `apps/desktop/scripts/main-process-bundle.test.mjs` (`../vite.config.ts`), `scripts/lib/cached-tests.test.ts`, `scripts/lib/sharded-tests.test.ts`.
- Writes during a run: the web config's TanStack Router plugin can regenerate the tracked `apps/web/src/routeTree.gen.ts`; `transferBudgetV2.integration.test.ts` writes report files to the paths in its env vars.

### 5.5 Browser and jsdom tests

- 193 web browser tests run in Chromium through Vitest browser mode; their modules load in the browser via the Vite dev server, not Node workers, so Node-side read hooks do not see them. Server-side module graph data (Vite's) does cover them.
- 41 mobile `react` tests run in jsdom after a Babel transform whose output depends on `babel.config.js`, the Babel/React Compiler versions and `T3_MOBILE_TEST_PLATFORM`.

## 6. What this means for exact, fast selection

1. Package gating is coarse: a change in `shared` or `contracts` selects ~1,900 of 2,006 test files today. File- or declaration-level impact can cut most of that; the `test` job (unsharded, four packages at a time, mobile 95 s long pole) and the web browser project gain the most.
2. Per-project config closure is a real input set and differs per project: the root config closure for 28 packages plus the server; separate closures for web, mobile, desktop, client-runtime. Changing a config file or its imports must rerun exactly the projects that load it, not the whole repo.
3. Environment: the env vars read at config time (web `define`, mobile platform, `CI`) and the Node version, OS and toolchain must be part of the selection key. `.env`/`.env.local` are git-ignored but read by the web config.
4. Many tests read files Vitest never imports: path-template fixture reads, docs, CJS modules, child-process scripts, directory scans. Static import analysis alone misses these; runtime read recording in the test worker misses child processes; vite-plus `{auto:true}` tracking records what the whole command reads but only per task.
5. No snapshots exist, so snapshot handling is not on t3code's critical path. Files a run writes (`routeTree.gen.ts`, the transfer report) must not count as inputs.
6. Server: `fileParallelism: false` and one Vitest process per file in `test:cached` cost ~25–30 s per shard on the fork. Running the selected server files in one Vitest process per shard, split by `shardWeights.json`, is cheaper. When nothing is selected, a shard should stop before setup (~25 s of checkout and install), as `ci-changes` already does at package level.
7. Floor costs: one Vitest invocation with the root config is ~1 s warm locally; CI checkout + install is ~20–28 s per job. Selection overhead should stay well below both, and a "nothing to run" answer should be available before `vp install`.
