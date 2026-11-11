import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  Reporter,
  SerializedError,
  TestModule,
  TestRunEndReason,
  Vitest,
} from "vite-plus/test/node";

/**
 * Writes each test module's outcome to `$ORACLE_REPORT`: file state, `fullName → state` per test,
 * attributed errors, run-level errors with the test path Vitest attaches when it has one, and each
 * project's serialized config with membership fields split out.
 */
export default class OracleReporter implements Reporter {
  private configs: Record<string, { readonly config: string; readonly membership: string }> = {};

  onInit(vitest: Vitest): void {
    for (const project of vitest.projects) {
      const { include, exclude, dir, ...rest } = project.config;
      this.configs[project.name] = {
        config: serialize(project.serializedConfig) + serialize(rest),
        membership: serialize({ include, exclude, dir }),
      };
    }
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const target = process.env.ORACLE_REPORT;
    if (target === undefined) return;
    const modules = testModules.map((module) => {
      const tests: Record<string, string> = {};
      for (const test of module.children.allTests()) {
        const name = test.fullName;
        tests[tests[name] === undefined ? name : `${name} #${Object.keys(tests).length}`] =
          test.result().state;
      }
      const errors = [
        ...module.errors().map(describe),
        ...[...module.children.allSuites()].flatMap((suite) => suite.errors().map(describe)),
        ...[...module.children.allTests()].flatMap((test) =>
          (test.result().errors ?? []).map((error) => `${test.fullName}: ${describe(error)}`),
        ),
      ];
      return {
        project: module.project.name,
        file: module.moduleId,
        state: module.state(),
        tests,
        errors,
        durationMs: module.diagnostic().duration,
      };
    });
    const runErrors = unhandledErrors.map((error) => {
      const path = (error as { VITEST_TEST_PATH?: unknown }).VITEST_TEST_PATH;
      return { message: describe(error), testPath: typeof path === "string" ? path : null };
    });
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(
      target,
      JSON.stringify({
        modules,
        unhandledErrors: runErrors,
        reason: String(reason),
        configs: this.configs,
      }),
    );
  }
}

/** Keys whose values Vitest draws per run: the sequence seed (`Date.now()`) and the API token. */
const PER_RUN_KEYS = new Set(["seed", "webSocketToken"]);

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, entry: unknown) => {
    if (PER_RUN_KEYS.has(key)) return undefined;
    if (typeof entry === "function") return `fn:${entry.toString().slice(0, 2000)}`;
    if (entry instanceof RegExp) return `re:${String(entry)}`;
    if (typeof entry === "object" && entry !== null) {
      if (seen.has(entry)) return "[cycle]";
      seen.add(entry);
      if (
        !Array.isArray(entry) &&
        !(entry.constructor === Object || entry.constructor === undefined)
      ) {
        return `obj:${entry.constructor?.name ?? "?"}`;
      }
      return Object.fromEntries(
        Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return entry;
  });
}

function describe(error: SerializedError): string {
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : String(error);
  return `${name}: ${message.split("\n").slice(0, 3).join(" ").slice(0, 400)}`;
}
