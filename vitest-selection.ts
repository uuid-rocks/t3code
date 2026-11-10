// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Vitest loads this from config, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import blacksmithExport from "@useblacksmith/vitest";
import type { Plugin } from "vite-plus";
import type { TestModule, Vitest } from "vite-plus/test/node";

// apps/mobile is a CommonJS package: Vite bundles its config to CJS, and the
// interop wraps this ESM-only package's namespace once more.
const blacksmith: typeof blacksmithExport =
  typeof blacksmithExport === "function"
    ? blacksmithExport
    : (blacksmithExport as unknown as { default: typeof blacksmithExport }).default;

const COUNTER = Symbol.for("t3code.bsv.selectionCounter");

// Prints `BSV_SELECTION ... selected=<ran> total=<owned by this shard>` once per
// vitest run. Counts are test specifications
// (file x project), so a file two projects run counts twice in both numbers.
class SelectionCounter {
  readonly [COUNTER] = true;
  private vitest: Vitest | undefined;
  private reported = false;

  constructor(private readonly mode: string) {}

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  // onTestRunStart receives the specifications before --shard applies, so
  // the modules handed to onTestRunEnd are the count of what ran.
  async onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const vitest = this.vitest;
    if (!vitest || this.reported) return;
    this.reported = true;
    const all = await vitest.globTestSpecifications();
    const { shard, root } = vitest.config;
    const owned = shard ? await new vitest.config.sequence.sequencer(vitest).shard(all) : all;
    const repo = process.env.GITHUB_WORKSPACE || NodePath.resolve(import.meta.dirname);
    const line =
      `BSV_SELECTION root=${NodePath.relative(repo, root) || "."}` +
      ` shard=${shard ? `${shard.index}/${shard.count}` : "-"}` +
      ` mode=${this.mode} selected=${testModules.length} total=${owned.length}`;
    console.log(line);
    // bsv/perf/analyze.py compares these against the changed files' importers.
    const files = testModules.map((module) => NodePath.relative(repo, module.moduleId)).sort();
    console.log(`BSV_FILES root=${NodePath.relative(repo, root) || "."} files=${files.join(",")}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`${line}\`\n\n`);
    }
    // .github/scripts/bsv-report.sh sums these per CI step.
    if (process.env.RUNNER_TEMP) {
      NodeFS.appendFileSync(
        NodePath.join(process.env.RUNNER_TEMP, "bsv-selection.log"),
        `${line}\n`,
      );
    }
  }
}

function selectionCounter(mode: string): Plugin {
  return {
    name: "t3code:bsv-selection-counter",
    configureVitest({ vitest }) {
      const reporters = vitest.config.reporters as unknown[];
      if (
        reporters.some(
          (reporter) => typeof reporter === "object" && reporter && COUNTER in reporter,
        )
      ) {
        return;
      }
      reporters.push(new SelectionCounter(mode));
    },
  };
}

// BSV_MODE picks how @useblacksmith/vitest runs; see bsv/README-experiment.md.
// The root config's plugins reach apps/server and the packages that borrow it
// through --config, so only configs that do not extend it add these.
export function testSelectionPlugins(): Plugin[] {
  const mode = process.env.BSV_MODE || "off";
  // scripts/test-cached.ts runs one vitest per file and reports its own counts.
  const counter = process.env.T3_CACHED_TESTS ? [] : [selectionCounter(mode)];
  switch (mode) {
    case "off":
      return counter;
    case "select":
      return [blacksmith(), ...counter];
    case "shadow":
      return [blacksmith({ shadow: true }), ...counter];
    case "all":
      return [blacksmith({ runAllTests: true }), ...counter];
    default:
      throw new Error(`BSV_MODE must be off, select, shadow or all, got "${mode}".`);
  }
}
