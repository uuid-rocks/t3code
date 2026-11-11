# Ordinary-change mutation measurement

Base: `4102828b5cbcd156fa7939d4729746b63fa046c3`. Seed: `20261110`. Node: `v26.12.1`. Status: stopped_by_user. Local only; no CI.

Reproduce the recorded mutations from this commit: `export TMPDIR="$HOME/.cache/agent-tmp/sol4/tmp"; mkdir -p "$TMPDIR"; pnpm install; python3 bsv/mutations/run.py --sample bsv/mutations/sample.json`. This reruns the baseline and all controls. `--resume` resumes interrupted work while its cache remains in $HOME/.cache/agent-tmp/sol4/work.

Ground truth: every control runs BSV_MODE=all over the same complete 655-file scope as select, including all scoped packages and apps/server. No related-test controls contribute to the final counts. An eight-worker fixture control had an unrelated interrupted-fiber failure in the ACP inline-exit test and is excluded from the accepted results. The five accepted controls ran the full 655-file scope, including all 481 included server files. The user stopped further testing; the fixture attempt remains inconclusive and excluded. Earlier owning-package-only and server-only controls are superseded. Commands, file statuses, and key output are in results.json; complete terminal output is in evidence/*.log.gz.

The user stopped the campaign after five complete rows: four widely imported source files and one test-file edit. These are the first four weighted sources and the first test from the original fixed-seed draw; weights are sqrt(recorded importing-test count). The planned 20-row batch and the ten-full-server-control target were not completed. No fixture row contributes to the final rate. Module-load throws are deliberate behavior-breaking mutations. Assertions negate the first equality/containment matcher. Data mutations append an invalid NDJSON record. Sampling does not use the review reports.

The retained historical runs used up to eight workers. The reproducible runner now enforces one worker and disk-backed TMPDIR under $HOME/.cache/agent-tmp/sol4. Historical command strings are evidence, not safe commands to replay verbatim under the new temporary-storage policy. The same passing baseline cache is restored before each select and control run, and node_modules/.vitest-cache is deleted. Over-selection means selected files absent from both the failing-test set and the baseline transitive dependency set (including recorded filesystem reads). In these five rows every selected file failed in the full control, so zero over-selection is exact without relying on recorded imports. Counts are mutation–test-file pairs, not individual assertions or globally unique files. The measured file-level false-negative rate applies only to this early-stopped sample; it does not establish a repository-wide rate.

Baseline seeding: Genuine passing BSV_MODE=select run; plugin records and covered-file list are unmodified. Excluded baseline-failing files: apps/server/src/storageCleanup.test.ts, apps/server/src/process/externalLauncher.test.ts, apps/server/src/preview/ServerBrowserPage.test.ts.

```json
{
  "overall": {
    "mutations": 5,
    "kinds": {
      "source": 4,
      "test": 1
    },
    "groundTruthFailingTests": 726,
    "selected": 725,
    "falseNegatives": 1,
    "overSelected": 0,
    "noGroundTruthFailures": 0,
    "meanSelected": 145.0,
    "totalScopedTests": 655,
    "meanSelectedOverTotal": 0.22137404580152673,
    "falseNegativeRate": 0.0013774104683195593
  },
  "groups": {
    "full-scope": {
      "mutations": 5,
      "groundTruthFailingTests": 726,
      "selected": 725,
      "falseNegatives": 1,
      "overSelected": 0,
      "noGroundTruthFailures": 0,
      "falseNegativeRate": 0.0013774104683195593,
      "meanSelectedOverTotal": 0.22137404580152673
    },
    "related-ground-truth": {
      "mutations": 0,
      "groundTruthFailingTests": 0,
      "selected": 0,
      "falseNegatives": 0,
      "overSelected": 0,
      "noGroundTruthFailures": 0,
      "falseNegativeRate": null,
      "meanSelectedOverTotal": null
    }
  }
}
```

| ID | Kind | Ground truth | Mutated file | Importers | Selected | GT failures | False negatives | Over-selected | Select exit | Control exit |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01 | source | full-scope | `packages/provider-core/src/server/instanceIdentity.ts` | 145 | 145 | 145 | 0 | 0 | 1 | 1 |
| 02 | source | full-scope | `packages/source-control-github/src/server/gitHubPullRequests.ts` | 267 | 267 | 268 | 1 | 0 | 1 | 1 |
| 03 | source | full-scope | `apps/server/src/background/BackgroundPolicy.ts` | 144 | 144 | 144 | 0 | 0 | 1 | 1 |
| 04 | source | full-scope | `packages/provider-core/src/server/adapterDriver.ts` | 168 | 168 | 168 | 0 | 0 | 1 | 1 |
| 41 | test | full-scope | `apps/server/src/mcp/WorktreeMcpService.test.ts` | 1 | 1 | 1 | 0 | 0 | 1 | 1 |

## False negatives

### 02: `packages/source-control-github/src/server/gitHubPullRequests.ts`

- `apps/server/src/cliCompileCache.test.ts`

Confirmed on T3: a subprocess dependency gap. apps/server/src/cliCompileCache.test.ts spawns Node on apps/server/src/bin.ts --help. The passing baseline records only its setup modules, serviceProtocol.ts, the test and a snapshot as repository dependencies; neither bin.ts nor the changed gitHubPullRequests.ts is recorded. Under the mutation the full control finds its CLI child exiting 1 instead of the expected 0 (test line 59), while select omits the test. Child-process imports do not reach the parent Vitest dependency recorder. See evidence/cli-subprocess-dependencies.json, 02-select.log.gz and 02-control-full.log.gz. No additional isolated probe was run after the stop instruction.

