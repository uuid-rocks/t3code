# @useblacksmith/vitest on replayed t3code commits

Question: how much does the plugin (0.4.0, select mode) speed up t3code CI on
realistic PRs, compared with what t3code CI does today (`changes` gating plus
`test:cached` with a remote task cache)? Full numbers: [results.md](results.md).
Raw per-run data: `raw/<commit>-<arm>.json`.

## Setup

All PRs target `bsv/perf-base` (`4d2817b01`), which is `bsv/main` plus three
changes. PRs into `bsv/main` would have carried the plugin patch's lockfile
change in their diff, and the plugin reruns everything on a lockfile change.

1. **Base-exact plugin restore** (`patches/@useblacksmith__vitest.patch`, diff
   below). The plugin restores the PR base commit's exact entry before falling
   back to the newest entry under the prefix.
2. **Arm switch by PR head branch suffix** in `ci.yml`: `-a`, `-b`, `-c`.
   `workflow_dispatch` with `arm=seed-a|seed-b` seeds both caches at the base tip.
3. **Emulated remote task cache for arm B.** Upstream's `test:cached` reads a
   private Cloudflare task cache (`infra/task-cache`, pingdotgg only). On the
   fork, `test_server` restores `node_modules/.vite/task-cache` from
   `bsv-task-cache-v1-<base sha>-<shard>` with no restore-keys. The seed-b run
   saved that key.

| arm | BSV_MODE | BSV_BYPASS_CHANGES | BSV_SERVER_TEST_CACHED | meaning                                                                              |
| --- | -------- | ------------------ | ---------------------- | ------------------------------------------------------------------------------------ |
| A   | select   | true               | false                  | plugin alone, every job runs                                                         |
| B   | off      | false              | true                   | upstream today: `changes` gating, `test:cached` with a task cache seeded at the base |
| C   | select   | false              | false                  | plugin plus `changes` gating (r01, r04, r07 only)                                    |

Both arms of a commit use the same head commit. Every run was serial, with
nothing else running on the fork.

### Workload (`commits.tsv`)

The 10 upstream commits come from pingdotgg/t3code main, fetched read-only. The
4 commits after `871b00907` are applied forward. The 6 older ones are already in
the base, so their reverse diff is applied (`git diff <c> <c>^`). A reverse diff
changes the same files, and that file set is the only thing selection depends
on. r10 changes `pnpm-lock.yaml`.

## Contamination mechanism

Without the patch, `restoreBundle` asks for the exact key `<prefix><head sha>`
with `restore_keys: [prefix]`. A PR's head (merge) SHA never has an entry, so
every PR got the newest entry under the prefix, from any branch. In seed-a,
before the base existed, the restores came from two unrelated heads
(`dbd9b7df…`, `919cef43…`).

The patch reads the base commit from `GITHUB_EVENT_PATH`
(`pull_request.base.sha`, or `before` for a push). It looks up
`<prefix><base sha>` exactly first, then falls back to the old lookup. With the
patch, all 517 `restored dependency cache` lines across the 14 plugin PR runs
(10 A, 3 C, 1 rerun) ended in `4d2817b01…`, the base. The diff, also a candidate
upstream fix:

```diff
--- a/dist/cache.js
+++ b/dist/cache.js
@@ -1,3 +1,4 @@
+import { readFileSync } from 'node:fs';
 import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
@@ -30,7 +31,26 @@ export function cacheKey(input) {
     const prefix = `${DEFAULT_CACHE_PREFIX}-${scope}-`;
-    return { key: `${prefix}${input.head}`, prefix };
+    const base = baseCommit();
+    return { key: `${prefix}${input.head}`, prefix, baseKey: base ? `${prefix}${base}` : null };
+}
+function baseCommit() {
+    const file = process.env.GITHUB_EVENT_PATH;
+    if (!file)
+        return null;
+    try {
+        const event = JSON.parse(readFileSync(file, 'utf8'));
+        const sha = event.pull_request?.base?.sha ?? event.before;
+        return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha) ? sha : null;
+    }
+    catch {
+        return null;
+    }
 }
@@ -55,13 +75,25 @@
-export async function restoreBundle(base, cacheDir, { key, prefix }) {
-    const lookup = await twirp(base, 'GetCacheEntryDownloadURL', {
-        key,
-        restore_keys: [prefix],
-        restoreKeys: [prefix],
-        version: BUNDLE_VERSION,
-    });
+export async function restoreBundle(base, cacheDir, { key, prefix, baseKey }) {
+    let lookup = baseKey
+        ? await twirp(base, 'GetCacheEntryDownloadURL', {
+            key: baseKey,
+            restore_keys: [],
+            restoreKeys: [],
+            version: BUNDLE_VERSION,
+        })
+        : null;
+    let requested = baseKey;
+    if (!lookup?.ok || !field(lookup, 'signed_download_url', 'signedDownloadUrl')) {
+        requested = key;
+        lookup = await twirp(base, 'GetCacheEntryDownloadURL', {
+            key,
+            restore_keys: [prefix],
+            restoreKeys: [prefix],
+            version: BUNDLE_VERSION,
+        });
+    }
@@ -82,7 +114,7 @@
-        key: typeof matched === 'string' && matched !== '' ? matched : key,
+        key: typeof matched === 'string' && matched !== '' ? matched : requested,
```

The patch uses two lookups because a single call with
`restore_keys: [prefix + base, prefix]` depends on the cache service honouring
key order. That was not tested on Blacksmith.

**Arm B task cache.** vite-plus keys task entries by a fingerprint of the task's
inputs (`cache_entries` in `cache.db`, with auto-tracked file reads), not by
branch. An entry from another PR can therefore hit only when this task's inputs
are identical. That makes cross-PR reuse sound, which the plugin's
newest-by-prefix restore is not. Upstream PRs into `main` also write to the
remote cache (`VP_REMOTE_CACHE=read-write`), so upstream can see more hits than
this emulation, which reads only the base's entries.

## Correctness check

Oracle: on each replay branch, `BSV_MODE=off vp test list --filesOnly --changed
origin/bsv/perf-base` from the repo root (Vitest's static import graph, plugin
off; `oracle/<id>.txt`). It is limited to files CI runs through Vitest:
seed-a's executed files plus test files the commit adds, minus the web
`renders` project, which CI does not run. For r03, the root `vite.config.ts`
change makes Vitest list every test (force-rerun trigger). Its oracle is
therefore the static result without that file (`oracle/r03-noconfig.txt`), plus
every test of the configs that load the root config: apps/server and the
`--config ../../vite.config.ts` packages.

Across the 10 commits, the A runs left 17 statically affected tests unselected,
10 distinct files. For each, I appended `throw new Error()` to every changed
source file of that commit and ran the flagged test, together with a selected
test as a control:

| commit                  | not selected                                                                                                                                            | result with the changed modules throwing                            | control                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| r03, r05, r06, r07, r09 | `apps/web/src/components/pullRequest/pullRequestsRouteSearch.test.ts`                                                                                   | passes (reaches the changed files only through a lazy route import) | `markdown-links.test.ts` fails (r06, r07, r09)   |
| r04, r05                | `apps/server/src/cli/{connect,pair,theme}.test.ts`                                                                                                      | pass (`binCli.ts` loads subcommands with deferred imports)          | `ProviderSwitch.integration.test.ts` fails (r04) |
| r05                     | 6 apps/mobile tests (`ZipArchiveView`, `incomingShareImport`, `thread-settings-sheet-state`, `app-updates`, `queued-run-edit`, `thread-outbox-removal`) | pass                                                                | `subagent-card-presentation.test.ts` fails       |

None of the unselected tests load a changed module at runtime, so no false
negative was found on these 10 commits. Arm B skipped the same 3 CLI tests
through task-cache hits. This check cannot see inputs that both the plugin and
Vitest's graph miss (child processes, env vars, ignored files; see
`/tmp/bsv-reviews/findings.md`).

## Findings

Medians over the 10 commits (vCPU-min = sum over jobs of job seconds × runner
vCPU / 60):

| arm                                | median wall s | median vCPU-min | total vCPU-min                          |
| ---------------------------------- | ------------- | --------------- | --------------------------------------- |
| A plugin                           | 148           | 68.2            | 698.7                                   |
| B upstream-like                    | 164           | 84.9            | 774.4                                   |
| C plugin + changes (r01, r04, r07) | 117           | 28.3            | 98.5 (B on the same 3: 116.5, A: 140.5) |

- **Test job (non-server packages).** This is where A gains most. Test steps:
  r02 11 vs 71 s, r03 67 vs 105, r05 14 vs 82, r07 39 vs 88, r09 42 vs 104.
  `changes` gating reruns whole packages and their dependents (637-984 files),
  while the plugin picks 2-490. On r06 (contracts), the plugin still selected
  490 files: 109 vs 114 s.
- **Server shards.** The plugin and B's emulated task cache selected nearly the
  same files (r02 263 vs 265, r04 123 vs 124, r06 395 vs 397, r08 166 vs 168).
  A's shard steps were shorter, mostly because `test:cached` starts one Vitest
  process per file. The full runs show the same: plain shards 75-118 s
  (norec-n), cold `test:cached` 101-134 s (seed-b).
- **Where the plugin loses:**
  - _Shard overhead with nothing selected._ A shard that selects 0 files still
    costs a median 29.5 s job (checkout, install, Chromium cache) on 4 vCPU, so
    about 16 vCPU-min per run across 8 shards. `changes` gating stops such a
    shard after checkout (9-18 s). On web-only or client-only changes, A
    therefore costs more than B: r01 32.5 vs 25.5 vCPU-min, r07 51.5 vs 35.8.
    Arm C removes this: r01 23.1, r07 28.3.
  - _Browser tests._ The 193 browser files are never recorded and always run,
    so the Test Web step never drops below ~47 s, and A runs it even for
    server-only changes. B skips the job there (r04, r08). Against B's full web
    run (73-88 s step), A saved 20-31 s when few unit tests were selected (r01, r02, r03, r09).
  - _Lockfile (r10)._ The plugin runs everything (`pnpm-lock.yaml changed,
    running every test`). B's task cache also missed every entry. A 173 s /
    95.8 vCPU-min against B 205 s / 113.2: no selection benefit for either.
  - _Root config change (r03)._ All of apps/server and every root-config
    package reran (Test 436, Server 484), the same as B.
- **Plugin overhead per Vitest invocation** (server shards and Test Web, A
  runs): restore median 0.27 s (max 2.85), tree hash + selection 0.45 s (max
  1.15), save 0.63 s (max 1.36), bundle median 329 KiB (max 605).
- **Recording cost on a full run**, same tree: seed-a (plugin `all`,
  recording) took 176 s wall and 106.7 vCPU-min. norec-n (no plugin, plain
  shards) took 172 s and 99.9. Steps: Test 104 vs 101, Web 100 vs 95, server
  74-112 vs 75-118. On the lockfile commit, A's forced full run (r10-a, 95.8)
  cost less than B's (113.2), because of `test:cached`'s per-file processes.
- **Runner variance.** Rerunning r07-a with the identical selection (330 web
  files) gave a 71 s Test Web step instead of 129 s, and a 21 s Test step
  instead of 39 s. Single-run wall differences under ~30 s are within noise;
  the medians and vCPU totals are more reliable than any one row.

## Reproduce

```sh
git fetch https://github.com/pingdotgg/t3code.git +main:refs/bsv-upstream/main
gh workflow run ci.yml -R uuid-rocks/t3code --ref bsv/perf-base -f arm=seed-a   # then seed-b
bsv/perf/drive.sh r01 a          # replay.sh + wait + collect.py -> raw/r01-a.json
bsv/perf/analyze.py bsv/perf/oracle > bsv/perf/results.md
```

27 CI runs in total: 2 seeds, 20 A/B, 3 C, 1 no-plugin control and 1 rerun.
PRs #13-#36 are closed.
