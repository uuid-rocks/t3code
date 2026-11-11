# @useblacksmith/vitest 0.4.0: mutation campaign (opus5)

Commit under test: `4102828b5cbcd156fa7939d4729746b63fa046c3`. Node v26.12.1. Part A seed 5150517, part B seed ?.
Scripts: `bsv/v-opus5/part-a-mutations.mjs`, `bsv/v-opus5/part-b-shards.mjs`. Raw data: `part-a.json`, `part-a-plan.json`, `part-b.json`.

## Part A: single-file mutations

### Seed and no-op control

| project        | seed run (s) | seed files | control selected/total | control (s) | control log                                                                       |
| -------------- | ------------ | ---------- | ---------------------- | ----------- | --------------------------------------------------------------------------------- |
| web            | 142          | 541        | 193/541                | 137         | [blacksmith] 0 files changed since c7a186e43575, 193 test files not covered by it |
| web-unit       | 30           | 348        | 0/348                  | 2           | [blacksmith] 0 files changed since c7a186e43575, 0 test files not covered by it   |
| client-runtime | 11           | 156        | 0/156                  | 1           | [blacksmith] 0 files changed since c7a186e43575, 0 test files not covered by it   |
| shared         | 5            | 100        | 0/100                  | 1           | [blacksmith] 0 files changed since c7a186e43575, 0 test files not covered by it   |
| contracts      | 2            | 32         | 0/32                   | 1           | [blacksmith] 0 files changed since c7a186e43575, 0 test files not covered by it   |

### Totals

- Mutations run: 50 (40 source, 10 test-file, 0 fixture/data). Mutations with at least one ground-truth failure: 25.
- Ground-truth failing test files (summed over mutation x project): 35.
- Of those, selected by select mode: 35. False negatives: 0 (0 reproduced in an isolated rerun on the mutated tree).
- Test files run by select mode (summed): 7962; over-selected (ran, did not fail): 7927.

### Selection per project (select runs only)

| project        | select runs | mean selected/total | summed selected / summed total | browser files run (summed) | mean select-run seconds |
| -------------- | ----------- | ------------------- | ------------------------------ | -------------------------- | ----------------------- |
| contracts      | 17          | 16.9%               | 92 / 544                       | -                          | 2                       |
| shared         | 17          | 28.2%               | 480 / 1700                     | -                          | 7                       |
| client-runtime | 27          | 40.2%               | 1693 / 4212                    | -                          | 15                      |
| web-unit       | 37          | 32.2%               | 4147 / 12876                   | -                          | 31                      |
| web            | 8           | 35.8%               | 1550 / 4328                    | 1544                       | 198                     |

Browser projects always rerun: every select run of the CI web command (unit + browser) ran all 193 browser files (1544 in 8 runs), because @vitest/browser writes no per-file dependency record (seed record: project 'browser (chromium)' has 0 files). The no-op control reran 193/541 web files in 137 s, against 2 s for the unit-only no-op control. Most web mutations were measured with a separately seeded `--project unit` record (`web-unit`); browser files cannot be false negatives because they are always selected.

### False negatives

None.

### Every mutation

| id  | stratum      | file                                                            | operator   | projects run                                | selected | truth failing | FN  |
| --- | ------------ | --------------------------------------------------------------- | ---------- | ------------------------------------------- | -------- | ------------- | --- |
| m01 | weighted     | `shared/src/HostProcess.ts`                                     | return     | contracts, shared, client-runtime, web-unit | 636      | 0             | 0   |
| m02 | weighted     | `shared/src/threadPullRequests.ts`                              | return     | contracts, shared, client-runtime, web-unit | 160      | 1             | 0   |
| m03 | weighted     | `contracts/src/desktopBrowser.ts`                               | string     | contracts, shared, client-runtime, web-unit | 381      | 0             | 0   |
| m04 | weighted     | `contracts/src/settingsSecretValue.ts`                          | return     | contracts, shared, client-runtime, web-unit | 387      | 1             | 0   |
| m05 | weighted     | `contracts/src/mcpApps.ts`                                      | return     | contracts, shared, client-runtime, web-unit | 382      | 0             | 0   |
| m06 | weighted     | `contracts/src/orchestrationV2IdTable.ts`                       | return     | contracts, shared, client-runtime, web-unit | 385      | 2             | 0   |
| m07 | weighted     | `web/state/entities.ts`                                         | return     | web-unit                                    | 33       | 0             | 0   |
| m08 | weighted     | `shared/src/assistantCitations.ts`                              | return     | contracts, shared, client-runtime, web-unit | 23       | 3             | 0   |
| m09 | weighted     | `shared/src/advertisedEndpoint.ts`                              | return     | contracts, shared, client-runtime, web-unit | 194      | 0             | 0   |
| m10 | weighted     | `client-runtime/src/errors/network.ts`                          | string     | client-runtime, web-unit                    | 189      | 0             | 0   |
| m11 | weighted     | `shared/src/hostClassification.ts`                              | return     | contracts, shared, client-runtime, web-unit | 193      | 1             | 0   |
| m12 | weighted     | `client-runtime/src/state/olderSettledThreads.ts`               | return     | client-runtime, web-unit                    | 74       | 1             | 0   |
| m13 | weighted     | `contracts/src/chatAttachment.ts`                               | return     | contracts, shared, client-runtime, web-unit | 394      | 5             | 0   |
| m14 | weighted     | `contracts/src/composerContext.ts`                              | return     | contracts, shared, client-runtime, web-unit | 385      | 1             | 0   |
| m15 | weighted     | `contracts/src/server.ts`                                       | return     | contracts, shared, client-runtime, web-unit | 383      | 0             | 0   |
| m16 | weighted     | `client-runtime/src/state/shellCommands.ts`                     | return     | client-runtime, web-unit                    | 80       | 0             | 0   |
| m17 | weighted     | `client-runtime/src/pullRequestQuery.ts`                        | return     | client-runtime, web-unit                    | 68       | 1             | 0   |
| m18 | weighted     | `contracts/src/providerInstance.ts`                             | operator   | contracts, shared, client-runtime, web-unit | 397      | 1             | 0   |
| m19 | weighted     | `contracts/src/providerSetup.ts`                                | return     | contracts, shared, client-runtime, web-unit | 383      | 0             | 0   |
| m20 | weighted     | `contracts/src/orchestrationDispatch.ts`                        | string     | contracts, shared, client-runtime, web-unit | 382      | 0             | 0   |
| m21 | weighted     | `contracts/src/speech.ts`                                       | return     | contracts, shared, client-runtime, web-unit | 388      | 0             | 0   |
| m22 | weighted     | `web/hooks/useCopyToClipboard.ts`                               | return     | web-unit                                    | 35       | 0             | 0   |
| m23 | weighted     | `client-runtime/src/state/threadHistoryController.ts`           | return     | client-runtime, web-unit                    | 75       | 3             | 0   |
| m24 | weighted     | `contracts/src/previewCapture.ts`                               | return     | contracts, shared, client-runtime, web-unit | 381      | 0             | 0   |
| m25 | browser-only | `web/components/Sidebar.tsx`                                    | return     | web                                         | 194      | 0             | 0   |
| m26 | browser-only | `web/components/DiffPanel.tsx`                                  | return     | web                                         | 194      | 0             | 0   |
| m27 | browser-only | `web/components/AddProjectToMachineDialog.tsx`                  | return     | web                                         | 194      | 1             | 0   |
| m28 | browser-only | `web/components/chat/TimelineWorkEntryRow.logic.ts`             | return     | web                                         | 194      | 1             | 0   |
| m29 | browser-only | `web/components/chat/ChangedFilesTree.tsx`                      | return     | web                                         | 194      | 1             | 0   |
| m30 | browser-only | `web/components/pullRequest/PullRequestSummaryTab.tsx`          | return     | web                                         | 194      | 0             | 0   |
| m31 | leaf         | `web/components/device/DeviceToolsPanel.tsx`                    | return     | web-unit                                    | 1        | 0             | 0   |
| m32 | leaf         | `web/hooks/useSidebarProjectGroups.ts`                          | return     | web-unit                                    | 1        | 0             | 0   |
| m33 | leaf         | `web/components/desktopUpdate.toast.tsx`                        | return     | web-unit                                    | 1        | 0             | 0   |
| m34 | leaf         | `web/components/ProviderUpdatesAction.tsx`                      | return     | web-unit                                    | 1        | 0             | 0   |
| m35 | leaf         | `web/components/files/ProjectFilePicker.tsx`                    | return     | web-unit                                    | 1        | 0             | 0   |
| m36 | leaf         | `web/components/BranchPicker.tsx`                               | return     | web-unit                                    | 1        | 0             | 0   |
| m37 | leaf         | `web/components/settings/ProviderSettingsForm.tsx`              | return     | web-unit                                    | 4        | 0             | 0   |
| m38 | leaf         | `web/components/pullRequest/PullRequestCommentBody.tsx`         | return     | web-unit                                    | 1        | 0             | 0   |
| m39 | leaf         | `web/composer-logic.ts`                                         | return     | web-unit                                    | 3        | 1             | 0   |
| m40 | leaf         | `web/onboarding/firstRun.logic.ts`                              | return     | web-unit                                    | 2        | 0             | 0   |
| m41 | test         | `client-runtime/src/work-log/embeddedScripts.test.ts`           | test-throw | client-runtime                              | 1        | 1             | 0   |
| m42 | test         | `web/components/chat/markdownStreamBlocks.test.tsx`             | test-throw | web-unit                                    | 1        | 1             | 0   |
| m43 | test         | `web/components/files/filePath.test.ts`                         | test-throw | web-unit                                    | 1        | 1             | 0   |
| m44 | test         | `client-runtime/src/state/server.test.ts`                       | test-throw | client-runtime                              | 1        | 1             | 0   |
| m45 | test         | `web/components/chat/useComposerContextImport.browser.test.tsx` | test-throw | web                                         | 193      | 2             | 0   |
| m46 | test         | `web/hooks/useThreadActions.undo.test.ts`                       | test-throw | web-unit                                    | 1        | 1             | 0   |
| m47 | test         | `client-runtime/src/queuedRunEdit.test.ts`                      | test-throw | client-runtime                              | 1        | 1             | 0   |
| m48 | test         | `client-runtime/src/platform/orchestrationCache.test.ts`        | test-throw | client-runtime                              | 1        | 1             | 0   |
| m49 | test         | `client-runtime/src/state/threadVisits.test.ts`                 | test-throw | client-runtime                              | 1        | 1             | 0   |
| m50 | test         | `web/components/settings/AboutVersionTitle.browser.test.tsx`    | test-throw | web                                         | 193      | 1             | 0   |

Stopped by the coordinator after m50 of 55. Not run: m51-m55 (all five fixture/data edits), the module-throw second pass, and the clean-tree verify step. m01-m24 used seed generation 1 (commit 4102828b5), m25-m50 generation 2 (c7a186e43, which adds only bsv/ files); generation 1's records were lost when the VM rebooted. Deviations: Node 26.12.1; web runs pass --testTimeout=60000 --retry=2 (browser tests timed out at load averages of 40-70; a mutation's failure fails every retry); the vitest transform cache was kept between mutations (its key includes file content, and no mutation touches package.json). src/reactCompilerCoverage.test.ts loads nearly every web module, so any web source change selects at least that file.

## Part B: apps/server shards (8)

Not completed. All 8 shards were seeded twice on Node 26 (no-op control: 0 selected on every shard) but the per-shard records were lost in VM reboots before the new-file and weight phases finished, and the coordinator stopped the run. Runs excluded src/storageCleanup.test.ts (git rejects its gitfile on this host) and src/process/externalLauncher.test.ts (OrbStack mounts the Mac's /Applications, so it finds VS Code). Simulation only (no test runs): adding one unweighted test file moves 35-329 existing files depending on its name (313 for src/bsvShardProbe.test.ts); scaling any single weight by 1.5 moves 242-458 files (median 341) of 484. Under the plugin every moved file is uncovered in its new shard and reruns. Earlier sessions observed the wrapped WeightedShardSequencer in effect (server config sets it; the plugin wraps it with stableShards); the seed-run agreement check was not recorded.
