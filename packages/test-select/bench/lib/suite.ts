import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { BENCH_DIR, MAX_WORKERS, PACKAGE_TIMEOUT_SECONDS, hashJson } from "./env.ts";
import { projectId } from "./packages.ts";
import { runLogged } from "./proc.ts";
import {
  type PackageRun,
  type ProjectConfig,
  ReporterOutput,
  type TestPackage,
  type UnitOutcome,
  unitKey,
} from "./schema.ts";

const REPORTER = NodePath.join(BENCH_DIR, "oracle/reporter.ts");
const decodeReport = Schema.decodeUnknownExit(Schema.fromJsonString(ReporterOutput));

/** Restricts a package run to one project and, optionally, to some of its files. */
export interface Scope {
  readonly project: string;
  readonly files: ReadonlyArray<string> | null;
}

export interface RunOptions {
  readonly worktree: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly label: string;
  /** Prepended to the `vp` command, e.g. a tracer. */
  readonly wrap?: ReadonlyArray<string>;
  /** Appended to the package's `vp test run` arguments. */
  readonly extraArgs?: ReadonlyArray<string>;
}

/** Vitest names a browser instance's project `browser (chromium)`; units use the configured name. */
function projectName(name: string): string {
  return name.replace(/ \((?:chromium|firefox|webkit)\)$/, "");
}

/** CLI arguments of a package's test script, narrowed to `scope`. */
function scopedArgs(pkg: TestPackage, scope: Scope | null): ReadonlyArray<string> {
  if (scope === null) return pkg.args;
  const args: Array<string> = [];
  for (let index = 0; index < pkg.args.length; index++) {
    const arg = pkg.args[index] ?? "";
    if (arg === "--project") {
      index++;
      continue;
    }
    if (arg.startsWith("--project=")) continue;
    args.push(arg);
  }
  const hash = scope.project.indexOf("#");
  if (hash !== -1) args.push("--project", scope.project.slice(hash + 1));
  if (scope.files !== null) {
    for (const file of scope.files) args.push(NodePath.relative(pkg.dir, file));
  }
  return args;
}

/**
 * Runs one package's test script the way CI's `vp run test` does: `vp test run <args>` in the
 * package directory with the package's and the root's `node_modules/.bin` first on `PATH`, plus
 * `--maxWorkers=6` and the oracle reporter. Returns per-unit outcomes keyed by unit key.
 */
export async function runPackage(
  pkg: TestPackage,
  scope: Scope | null,
  options: RunOptions,
): Promise<{
  readonly run: PackageRun;
  readonly units: Record<string, UnitOutcome>;
  readonly configs: Record<string, ProjectConfig>;
}> {
  NodeFS.mkdirSync(options.logDir, { recursive: true });
  const slug = `${options.label}-${pkg.dir.replaceAll("/", "_")}${scope === null ? "" : `-${scope.project.replaceAll(/[/#]/g, "_")}`}`;
  const logPath = NodePath.join(options.logDir, `${slug}.log`);
  const reportPath = NodePath.join(options.logDir, `${slug}.report.json`);
  NodeFS.rmSync(reportPath, { force: true });
  NodeFS.writeFileSync(logPath, "");
  const vp = NodePath.join(options.worktree, "node_modules/.bin/vp");
  const args = [
    "test",
    "run",
    ...scopedArgs(pkg, scope),
    ...(options.extraArgs ?? []),
    `--maxWorkers=${MAX_WORKERS}`,
    "--reporter=default",
    `--reporter=${REPORTER}`,
  ];
  const wrap = options.wrap ?? [];
  const command = ["timeout", "-k", "30", String(PACKAGE_TIMEOUT_SECONDS), ...wrap, vp, ...args];
  const started = performance.now();
  const bins = [pkg.dir, "."].map((dir) =>
    NodePath.join(options.worktree, dir, "node_modules/.bin"),
  );
  const result = await runLogged(command[0] ?? "timeout", command.slice(1), {
    cwd: NodePath.join(options.worktree, pkg.dir),
    env: {
      ...options.env,
      PATH: [...bins, options.env.PATH ?? ""].join(":"),
      ORACLE_REPORT: reportPath,
    },
    logPath,
  });
  const seconds = (performance.now() - started) / 1000;
  const units: Record<string, UnitOutcome> = {};
  const configs: Record<string, ProjectConfig> = {};
  const unattributed: Array<string> = [];
  let reporterMissing = true;
  if (NodeFS.existsSync(reportPath)) {
    const parsed = decodeReport(NodeFS.readFileSync(reportPath, "utf8"));
    if (parsed._tag === "Success") {
      reporterMissing = false;
      const normalize = (text: string): string =>
        hashJson(
          text
            .replaceAll(options.worktree, "<wt>")
            .replaceAll(options.env.TMPDIR ?? "<tmp>", "<tmp>"),
        );
      for (const [name, config] of Object.entries(parsed.value.configs)) {
        configs[projectId(pkg.dir, projectName(name))] = {
          config: normalize(config.config),
          membership: normalize(config.membership),
        };
      }
      for (const module of parsed.value.modules) {
        const file = NodePath.relative(options.worktree, module.file);
        units[unitKey({ project: projectId(pkg.dir, projectName(module.project)), file })] = {
          state: module.state,
          tests: module.tests,
          errors: module.errors,
          durationMs: module.durationMs,
        };
      }
      for (const error of parsed.value.unhandledErrors) {
        const path =
          error.testPath === null ? null : NodePath.relative(options.worktree, error.testPath);
        const key =
          path === null
            ? undefined
            : Object.keys(units).find((candidate) => candidate.endsWith(`|${path}`));
        const unit = key === undefined ? undefined : units[key];
        if (key === undefined || unit === undefined) {
          unattributed.push(error.message);
        } else {
          units[key] = { ...unit, errors: [...unit.errors, `unhandled: ${error.message}`] };
        }
      }
    }
  }
  const failedUnits = Object.values(units).some(
    (unit) => unit.state === "failed" || unit.errors.length > 0,
  );
  if (!reporterMissing && result.status !== 0 && !failedUnits && unattributed.length === 0) {
    unattributed.push(`exit ${result.status ?? result.signal} with no failed unit`);
  }
  return {
    run: {
      dir: pkg.dir,
      exitCode: result.status,
      signal: result.signal,
      seconds,
      reporterMissing,
      unattributedErrors: unattributed,
      log: logPath,
    },
    units,
    configs,
  };
}

/** Outcome identity used for "differs between runs": file state, per-test states, and whether errors exist. */
export function outcomeSignature(outcome: UnitOutcome | undefined): string {
  if (outcome === undefined) return "absent";
  const tests = Object.entries(outcome.tests)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, state]) => `${name}=${state}`);
  return JSON.stringify([outcome.state, outcome.errors.length > 0, tests]);
}
