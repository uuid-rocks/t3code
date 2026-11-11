import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { type GenerationContext, generateCases, NOOP_CASE } from "./lib/cases.ts";
import {
  assertTmpDir,
  BENCH_DIR,
  CACHE_DIR,
  DEFAULT_NODE,
  hashJson,
  REPO,
  SCRATCH_ROOT,
} from "./lib/env.ts";
import {
  type Changes,
  changedListings,
  type EvidenceContext,
  hasChanges,
  justify,
  needsHeadRun,
} from "./lib/evidence.ts";
import { changedPaths, listFiles, resolveCommit, showFile, treeKey } from "./lib/git.ts";
import { runInstrumented } from "./lib/instrument.ts";
import { listTestPackages, packageOfProject } from "./lib/packages.ts";
import { run as runProcess, terminateChildren } from "./lib/proc.ts";
import { type CaseResult, type Report, writeReport } from "./lib/report.ts";
import {
  type Case,
  CaseJson,
  type PackageResult,
  PackageResultJson,
  type ProjectConfig,
  type TestPackage,
  type Trace,
  TraceJson,
  type Truth,
  TruthJson,
  type UnitOutcome,
} from "./lib/schema.ts";
import { recordBase, selectHead, selectorArgv } from "./lib/selector.ts";
import { outcomeSignature, runPackage, type Scope } from "./lib/suite.ts";
import { Workspace } from "./lib/workspace.ts";

const USAGE = `usage: node packages/test-select/bench/run.ts --seed N --selector "<command>" [options]

  --seed N             case generation seed (required)
  --selector CMD       selector command line (bench/README.md); e.g.
                       "node packages/test-select/bench/selectors/stub.ts all"
  --base REV           base commit (default HEAD); its full suite should pass
  --minimum N          generated cases per run, at least (default 40)
  --limit N            keep only the first N generated cases (validation runs)
  --packages a,b       restrict the test universe to these package dirs (iteration runs)
  --label NAME         write results/<seed>-<NAME>.json|md instead of results/<seed>.json|md
  --list-cases         print the cases and exit after the base runs`;

const { values: args } = NodeUtil.parseArgs({
  options: {
    seed: { type: "string" },
    selector: { type: "string" },
    base: { type: "string", default: "HEAD" },
    minimum: { type: "string", default: "40" },
    limit: { type: "string" },
    packages: { type: "string" },
    label: { type: "string" },
    "list-cases": { type: "boolean", default: false },
  },
});

if (args.seed === undefined || args.selector === undefined || !/^\d+$/.test(args.seed)) {
  console.error(USAGE);
  process.exit(2);
}
const seed = Number(args.seed);
const selectorCommand = args.selector;
const argv = selectorArgv(selectorCommand).map((part) =>
  !NodePath.isAbsolute(part) && NodeFS.existsSync(NodePath.join(REPO, part))
    ? NodePath.join(REPO, part)
    : part,
);

const log = (line: string): void => {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
};

function readJson<T>(path: string, schema: Schema.Codec<T, string>): T | null {
  if (!NodeFS.existsSync(path)) return null;
  const parsed = Schema.decodeUnknownExit(schema)(NodeFS.readFileSync(path, "utf8"));
  return parsed._tag === "Success" ? parsed.value : null;
}

function writeJson(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(value));
}

const slug = (dir: string): string => dir.replaceAll("/", "_");

function mergeTraces(traces: ReadonlyArray<Trace>): Trace {
  return {
    units: Object.assign({}, ...traces.map((trace) => trace.units)),
    projects: Object.assign({}, ...traces.map((trace) => trace.projects)),
    outcomes: Object.assign({}, ...traces.map((trace) => trace.outcomes)),
    partial: Object.assign({}, ...traces.map((trace) => trace.partial)),
  };
}

/**
 * Content hash of the selector's code, so a changed selector records a new store: files named on
 * its command line and everything under `packages/test-select/src`.
 */
function selectorCodeHash(argv: ReadonlyArray<string>): string {
  const hash = NodeCrypto.createHash("sha256");
  const visit = (path: string): void => {
    const stat = NodeFS.statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(path).toSorted()) {
        if (name !== "node_modules") visit(NodePath.join(path, name));
      }
      return;
    }
    hash.update(path).update("\0").update(NodeFS.readFileSync(path)).update("\0");
  };
  for (const part of argv) if (NodePath.isAbsolute(part) && NodeFS.existsSync(part)) visit(part);
  visit(NodePath.join(REPO, "packages/test-select/src"));
  return hash.digest("hex").slice(0, 16);
}

const passed = (outcome: UnitOutcome | undefined): boolean =>
  outcome !== undefined && outcome.state === "passed" && outcome.errors.length === 0;

async function main(): Promise<void> {
  assertTmpDir();
  NodeFS.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const baseCommit = resolveCommit(args.base);
  const runId = `${seed}-${Date.now()}`;
  const logDir = NodePath.join(SCRATCH_ROOT, "logs", runId);
  const workspace = new Workspace(baseCommit, logDir);
  const started = new Date();
  const onSignal = (): void => {
    terminateChildren();
    setTimeout(() => {
      workspace.close();
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    log(`base ${baseCommit.slice(0, 12)}; opening scratch worktree ${workspace.dir}`);
    workspace.open();
    await workspace.resetToBase(DEFAULT_NODE);
    const baseEnv = workspace.env(DEFAULT_NODE);
    const baseKey = `${treeKey(baseCommit)}-${hashJson({ ...baseEnv, TMPDIR: "<tmp>" })}`;
    const baseCache = NodePath.join(CACHE_DIR, "base", baseKey);
    const allPackages = listTestPackages(workspace.dir);
    const wanted = args.packages
      ?.split(",")
      .map((dir) => dir.trim())
      .filter((dir) => dir !== "");
    const packages =
      wanted === undefined ? allPackages : allPackages.filter((pkg) => wanted.includes(pkg.dir));
    if (wanted !== undefined && packages.length !== wanted.length) {
      throw new Error(
        `unknown package dirs in --packages: ${wanted.filter((dir) => !packages.some((pkg) => pkg.dir === dir)).join(", ")}`,
      );
    }
    const readSource = (relative: string): string | null => {
      try {
        return NodeFS.readFileSync(NodePath.join(workspace.dir, relative), "utf8");
      } catch {
        return null;
      }
    };

    const runCached = async (
      path: string,
      pkg: TestPackage,
      scope: Scope | null,
      env: Record<string, string>,
      label: string,
    ): Promise<PackageResult> => {
      const cached = readJson(path, PackageResultJson);
      if (cached !== null) return cached;
      workspace.clearTmp();
      const result = await runPackage(pkg, scope, { worktree: workspace.dir, env, logDir, label });
      const value: PackageResult = {
        run: result.run,
        units: result.units,
        configs: result.configs,
      };
      writeJson(path, value);
      log(
        `${label} ${pkg.dir}${scope === null ? "" : ` ${scope.project} (${scope.files?.length ?? "all"} files)`}: ${Object.keys(value.units).length} units, exit ${value.run.exitCode ?? value.run.signal}, ${value.run.seconds.toFixed(0)}s`,
      );
      return value;
    };
    const traceCached = async (
      path: string,
      pkg: TestPackage,
      scope: Scope | null,
      env: Record<string, string>,
      label: string,
    ): Promise<Trace> => {
      const cached = readJson(path, TraceJson);
      if (cached !== null) return cached;
      workspace.clearTmp();
      const started = performance.now();
      const trace = await runInstrumented(pkg, scope, {
        worktree: workspace.dir,
        env,
        logDir,
        label,
        readSource,
      });
      writeJson(path, trace);
      log(
        `${label} ${pkg.dir}: instrumented ${Object.keys(trace.units).length} units in ${((performance.now() - started) / 1000).toFixed(0)}s`,
      );
      return trace;
    };

    log(`base runs for ${packages.length} packages (cached under ${baseCache})`);
    const base1: Array<PackageResult> = [];
    const base2: Array<PackageResult> = [];
    for (const pkg of packages)
      base1.push(
        await runCached(
          NodePath.join(baseCache, slug(pkg.dir), "run1.json"),
          pkg,
          null,
          baseEnv,
          "base1",
        ),
      );
    for (const pkg of packages)
      base2.push(
        await runCached(
          NodePath.join(baseCache, slug(pkg.dir), "run2.json"),
          pkg,
          null,
          baseEnv,
          "base2",
        ),
      );
    const traces1: Array<Trace> = [];
    const traces2: Array<Trace> = [];
    for (const pkg of packages)
      traces1.push(
        await traceCached(
          NodePath.join(baseCache, slug(pkg.dir), "trace1.json"),
          pkg,
          null,
          baseEnv,
          "trace1",
        ),
      );
    for (const pkg of packages)
      traces2.push(
        await traceCached(
          NodePath.join(baseCache, slug(pkg.dir), "trace2.json"),
          pkg,
          null,
          baseEnv,
          "trace2",
        ),
      );
    const baseUnits: Record<string, UnitOutcome> = Object.assign(
      {},
      ...base1.map((result) => result.units),
    );
    const baseUnits2: Record<string, UnitOutcome> = Object.assign(
      {},
      ...base2.map((result) => result.units),
    );
    const baseConfigs: Record<string, ProjectConfig> = Object.assign(
      {},
      ...base1.map((result) => result.configs),
    );
    const baseConfigs2: Record<string, ProjectConfig> = Object.assign(
      {},
      ...base2.map((result) => result.configs),
    );
    for (const [project, config] of Object.entries(baseConfigs)) {
      if (baseConfigs2[project]?.config !== config.config) {
        log(
          `project ${project}: serialized config differs between the base runs; E4 config evidence is off for it`,
        );
        delete baseConfigs[project];
      }
    }
    const baseTraces = [mergeTraces(traces1), mergeTraces(traces2)];
    const flaky = Object.keys(baseUnits).filter(
      (key) => outcomeSignature(baseUnits[key]) !== outcomeSignature(baseUnits2[key]),
    );
    const baseFailing = Object.keys(baseUnits).filter(
      (key) => !flaky.includes(key) && (!passed(baseUnits[key]) || !passed(baseUnits2[key])),
    );
    const excluded = new Set([...flaky, ...baseFailing]);
    log(
      `base: ${Object.keys(baseUnits).length} units, ${flaky.length} flaky, ${baseFailing.length} failing at base`,
    );

    const files = listFiles(baseCommit);
    const tracked = new Set(files);
    const baseDirs = new Set<string>(["."]);
    for (const file of files) {
      for (
        let dir = NodePath.dirname(file);
        dir !== "." && !baseDirs.has(dir);
        dir = NodePath.dirname(dir)
      )
        baseDirs.add(dir);
    }
    const baseText = new Map<string, string | null>();
    const readBase = (path: string): string | null => {
      if (!baseText.has(path)) baseText.set(path, showFile(baseCommit, path));
      return baseText.get(path) ?? null;
    };
    const unitList = Object.keys(baseUnits)
      .filter((key) => !excluded.has(key))
      .map((key) => ({
        project: key.slice(0, key.indexOf("|")),
        file: key.slice(key.indexOf("|") + 1),
      }));
    const context: GenerationContext = {
      files,
      tracked,
      read: readBase,
      units: unitList,
      projects: [...new Set(unitList.map((unit) => unit.project))].toSorted(),
      trace: baseTraces[0] as Trace,
      isIgnored: (path) =>
        runProcess("git", ["check-ignore", "-q", "--no-index", path], { cwd: workspace.dir })
          .status === 0,
    };
    const generated = generateCases(seed, context, Number(args.minimum)).filter(
      (entry) => entry.id !== NOOP_CASE.id,
    );
    const limited = args.limit === undefined ? generated : generated.slice(0, Number(args.limit));
    const regressionDir = NodePath.join(BENCH_DIR, "regressions");
    const regressions: Array<Case> = [];
    for (const name of NodeFS.readdirSync(regressionDir)
      .filter((entry) => entry.endsWith(".json"))
      .toSorted()) {
      const parsed = readJson(NodePath.join(regressionDir, name), CaseJson);
      if (parsed === null)
        throw new Error(`bench/regressions/${name} does not match the Case schema`);
      regressions.push({ ...parsed, id: `regression-${parsed.id}` });
    }
    const cases = [NOOP_CASE, ...limited, ...regressions];
    log(
      `cases: ${generated.length} generated (${limited.length} kept), ${regressions.length} regressions, plus no-op`,
    );
    if (args["list-cases"]) {
      for (const entry of cases)
        console.log(
          `${entry.id}\t${entry.category}\t${entry.project ?? "-"}\t${entry.description}`,
        );
      return;
    }

    const selectorKey = hashJson({ argv, code: selectorCodeHash(argv) });
    const storeDir = NodePath.join(CACHE_DIR, "stores", selectorKey, baseKey);
    let recordSeconds: number | null = null;
    if (!NodeFS.existsSync(NodePath.join(storeDir, ".recorded"))) {
      NodeFS.rmSync(storeDir, { recursive: true, force: true });
      recordSeconds = recordBase(argv, {
        repo: workspace.dir,
        base: baseCommit,
        store: storeDir,
        env: baseEnv,
        logPath: NodePath.join(logDir, "selector-record.log"),
      }).seconds;
      NodeFS.writeFileSync(NodePath.join(storeDir, ".recorded"), "");
    }

    const pnpmEntries = (): Set<string> => {
      const dir = NodePath.join(workspace.dir, "node_modules/.pnpm");
      return new Set(NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : []);
    };
    const baseInstalled = pnpmEntries();
    const results: Array<CaseResult> = [];
    let standing = new Set<string>();
    const standingReasons: Record<string, string> = {};

    for (const entry of cases) {
      const caseStarted = performance.now();
      log(`case ${entry.id}: ${entry.description}`);
      try {
        await workspace.resetToBase(DEFAULT_NODE);
        const node = entry.node ?? DEFAULT_NODE;
        const head = await workspace.applyCase(entry, node);
        const headEnv = workspace.env(node, entry.env.set, entry.env.unset);

        const changedTracked = changedPaths(workspace.dir, baseCommit, head);
        const changedFiles = new Map<
          string,
          { readonly base: string | null; readonly head: string | null }
        >();
        for (const path of changedTracked)
          changedFiles.set(path, { base: readBase(path), head: showFile(head, path) });
        for (const edit of entry.ignored) {
          changedFiles.set(edit.path, {
            base: null,
            head: edit.op === "write" ? edit.content : edit.op === "symlink" ? edit.target : null,
          });
        }
        const added = [...changedFiles]
          .filter(([, value]) => value.base === null && value.head !== null)
          .map(([path]) => path);
        const removed = [...changedFiles]
          .filter(([, value]) => value.base !== null && value.head === null)
          .map(([path]) => path);
        const envNames = new Set([...Object.keys(baseEnv), ...Object.keys(headEnv)]);
        const installedNow = pnpmEntries();
        const changes: Changes = {
          files: changedFiles,
          listings: changedListings(
            added,
            removed,
            (dir) => baseDirs.has(dir),
            (dir) => NodeFS.existsSync(NodePath.join(workspace.dir, dir)),
          ),
          env: new Set(
            [...envNames].filter((name) => name !== "PATH" && baseEnv[name] !== headEnv[name]),
          ),
          node: node !== DEFAULT_NODE,
          installed: new Set(
            [...installedNow, ...baseInstalled]
              .filter((name) => installedNow.has(name) !== baseInstalled.has(name))
              .map((name) => `pnpm:${name}`),
          ),
        };
        const caseKey = hashJson({
          baseKey,
          id: entry.id,
          head: treeKey(head),
          ignored: entry.ignored,
          env: entry.env,
          node,
          install: entry.install,
          packages: packages.map((pkg) => pkg.dir),
        });
        const caseCache = NodePath.join(CACHE_DIR, "truth", caseKey);

        const storeCopy = NodePath.join(SCRATCH_ROOT, "store");
        NodeFS.rmSync(storeCopy, { recursive: true, force: true });
        NodeFS.cpSync(storeDir, storeCopy, { recursive: true });
        const selection = selectHead(argv, {
          repo: workspace.dir,
          base: baseCommit,
          store: storeCopy,
          env: headEnv,
          logPath: NodePath.join(logDir, `select-${entry.id}.log`),
        });

        let truth = readJson(NodePath.join(caseCache, "truth.json"), TruthJson);
        if (truth === null) {
          truth = await groundTruth({
            changes,
            packages,
            env: headEnv,
            caseCache,
            baseUnits,
            baseConfigs,
            excluded,
            existsAtHead: (path) => NodeFS.existsSync(NodePath.join(workspace.dir, path)),
            runCached,
          });
          writeJson(NodePath.join(caseCache, "truth.json"), truth);
        }
        const changed = new Set(truth.changed);
        const headUnitKeys = new Set(Object.keys(truth.headUnits));
        const selectedKeys = new Set(
          selection.value.all === true
            ? [...headUnitKeys]
            : selection.value.selected.map((unit) => `${unit.project}|${unit.file}`),
        );
        const unknownSelected = [...selectedKeys].filter((key) => !headUnitKeys.has(key));
        const evidence: EvidenceContext = {
          changes,
          changed,
          baseTraces,
          baseConfigs,
          headConfigs: truth.headConfigs,
          baseUnits: new Set(Object.keys(baseUnits)),
          headUnits: headUnitKeys,
          headTrace: null,
        };
        const considered = [...headUnitKeys].filter(
          (key) => !excluded.has(key) && !truth.flaky.includes(key),
        );
        const justification = new Map<string, string>();
        for (const key of considered) {
          const reason = justify(key, evidence);
          if (reason !== null) justification.set(key, reason);
        }
        const unverified = new Map<string, string>();
        const headRunUnits = [...selectedKeys].filter((key) => {
          if (justification.has(key) || !headUnitKeys.has(key) || excluded.has(key)) return false;
          const partial = baseTraces[0]?.partial[key];
          if (partial === "no worker process ran this unit") {
            unverified.set(key, "browser unit: no Node worker, coverage not collected");
            return false;
          }
          return needsHeadRun(key, evidence);
        });
        if (headRunUnits.length > 0) {
          const byProject = new Map<string, Array<string>>();
          for (const key of headRunUnits) {
            const project = key.slice(0, key.indexOf("|"));
            byProject.set(project, [
              ...(byProject.get(project) ?? []),
              key.slice(key.indexOf("|") + 1),
            ]);
          }
          const headTraces: Array<Trace> = [];
          for (const [project, projectFiles] of byProject) {
            const pkg = packages.find((candidate) => candidate.dir === packageOfProject(project));
            if (pkg === undefined) continue;
            const filesKey = NodeCrypto.createHash("sha256")
              .update(projectFiles.toSorted().join("\n"))
              .digest("hex")
              .slice(0, 16);
            headTraces.push(
              await traceCached(
                NodePath.join(caseCache, `head-trace-${slug(project)}-${filesKey}.json`),
                pkg,
                { project, files: projectFiles },
                headEnv,
                `head-trace-${entry.id}`,
              ),
            );
          }
          const headContext: EvidenceContext = { ...evidence, headTrace: mergeTraces(headTraces) };
          for (const key of headRunUnits) {
            const reason = justify(key, headContext);
            if (reason !== null) justification.set(key, reason);
          }
        }

        const misses = [...changed].filter((key) => !selectedKeys.has(key));
        const extras = [...selectedKeys].filter(
          (key) =>
            headUnitKeys.has(key) &&
            !justification.has(key) &&
            !unverified.has(key) &&
            !excluded.has(key) &&
            !truth.flaky.includes(key),
        );
        if (entry.id === NOOP_CASE.id) {
          standing = new Set([...selectedKeys].filter((key) => headUnitKeys.has(key)));
          for (const key of standing)
            standingReasons[key] =
              selection.value.reasons?.[key] ?? (selection.value.all === true ? "all" : "");
        }
        const softRecall = [...justification.keys()].filter(
          (key) => !selectedKeys.has(key) && !changed.has(key),
        );
        const duration = (keys: Iterable<string>): number => {
          let total = 0;
          for (const key of keys)
            total += (baseUnits[key]?.durationMs ?? truth.headUnits[key]?.durationMs ?? 0) / 1000;
          return total;
        };
        results.push({
          id: entry.id,
          category: entry.category,
          project: entry.project,
          description: entry.description,
          expectStanding: entry.expectStanding,
          head,
          units: headUnitKeys.size,
          changed: [...changed].toSorted(),
          caseFlaky: [...truth.flaky].toSorted(),
          bisected: [...truth.bisected],
          selected: selectedKeys.size,
          selectedAll: selection.value.all === true,
          unknownSelected,
          misses: misses.toSorted(),
          extras: extras
            .toSorted()
            .map((key) => ({ unit: key, selectorReason: selection.value.reasons?.[key] ?? null })),
          over: [],
          justified: Object.fromEntries(
            [...justification].filter(([key]) => selectedKeys.has(key)).toSorted(),
          ),
          unverified: Object.fromEntries([...unverified].toSorted()),
          softRecall: softRecall
            .toSorted()
            .map((key) => ({ unit: key, evidence: justification.get(key) ?? "" })),
          headRunUnits: headRunUnits.length,
          selectSeconds: selection.seconds,
          truthSeconds: truth.seconds,
          selectedTestSeconds: duration(selectedKeys),
          allTestSeconds: duration(headUnitKeys),
          caseSeconds: (performance.now() - caseStarted) / 1000,
          error: null,
        });
        log(
          `case ${entry.id}: changed ${changed.size}, selected ${selectedKeys.size}, misses ${misses.length}, extras ${extras.length}`,
        );
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log(`case ${entry.id} failed: ${message}`);
        results.push({
          id: entry.id,
          category: entry.category,
          project: entry.project,
          description: entry.description,
          expectStanding: entry.expectStanding,
          head: null,
          units: 0,
          changed: [],
          caseFlaky: [],
          bisected: [],
          selected: 0,
          selectedAll: false,
          unknownSelected: [],
          misses: [],
          extras: [],
          over: [],
          justified: {},
          unverified: {},
          softRecall: [],
          headRunUnits: 0,
          selectSeconds: 0,
          truthSeconds: 0,
          selectedTestSeconds: 0,
          allTestSeconds: 0,
          caseSeconds: (performance.now() - caseStarted) / 1000,
          error: message,
        });
      }
    }
    for (const result of results) {
      result.over = result.extras.filter((extra) => !standing.has(extra.unit));
    }
    const report: Report = {
      seed,
      selector: selectorCommand,
      base: baseCommit,
      baseKey,
      packages: packages.map((pkg) => pkg.dir),
      universeRestricted: wanted !== undefined,
      limit: args.limit === undefined ? null : Number(args.limit),
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      recordSeconds,
      baseUnits: Object.keys(baseUnits).length,
      flaky: flaky.toSorted(),
      baseFailing: baseFailing.toSorted(),
      standing: Object.fromEntries(
        [...standing].toSorted().map((key) => [key, standingReasons[key] ?? ""]),
      ),
      cases: results,
    };
    const name = args.label === undefined ? String(seed) : `${seed}-${args.label}`;
    const paths = writeReport(NodePath.join(BENCH_DIR, "results"), name, report);
    log(`wrote ${paths.json} and ${paths.markdown}`);
  } finally {
    workspace.close();
    NodeFS.rmSync(NodePath.join(SCRATCH_ROOT, "store"), { recursive: true, force: true });
  }
}

/**
 * Ground truth (DESIGN.md §14.2): the full head run of every package, units whose outcome
 * differs from base, reproduced twice, and run-level errors bisected to units.
 */
async function groundTruth(options: {
  readonly changes: Changes;
  readonly packages: ReadonlyArray<TestPackage>;
  readonly env: Record<string, string>;
  readonly caseCache: string;
  readonly baseUnits: Readonly<Record<string, UnitOutcome>>;
  readonly baseConfigs: Readonly<Record<string, ProjectConfig>>;
  readonly excluded: ReadonlySet<string>;
  readonly existsAtHead: (path: string) => boolean;
  readonly runCached: (
    path: string,
    pkg: TestPackage,
    scope: Scope | null,
    env: Record<string, string>,
    label: string,
  ) => Promise<PackageResult>;
}): Promise<Truth> {
  const started = performance.now();
  if (!hasChanges(options.changes)) {
    return {
      changed: [],
      flaky: [],
      bisected: [],
      headUnits: { ...options.baseUnits },
      headConfigs: { ...options.baseConfigs },
      runs: [],
      seconds: 0,
    };
  }
  const headUnits: Record<string, UnitOutcome> = {};
  const headConfigs: Record<string, ProjectConfig> = {};
  const runs: Array<PackageResult["run"]> = [];
  const bisectTargets: Array<TestPackage> = [];
  for (const pkg of options.packages) {
    const result = await options.runCached(
      NodePath.join(options.caseCache, `${slug(pkg.dir)}.json`),
      pkg,
      null,
      options.env,
      "head",
    );
    Object.assign(headUnits, result.units);
    Object.assign(headConfigs, result.configs);
    runs.push(result.run);
    const crashed =
      result.run.reporterMissing ||
      (result.run.exitCode !== 0 && Object.keys(result.units).length === 0);
    if (crashed) {
      for (const key of Object.keys(options.baseUnits)) {
        const file = key.slice(key.indexOf("|") + 1);
        if (
          packageOfProject(key.slice(0, key.indexOf("|"))) !== pkg.dir ||
          !options.existsAtHead(file)
        )
          continue;
        headUnits[key] = {
          state: "not run: package run failed",
          tests: {},
          errors: ["package run failed"],
          durationMs: 0,
        };
      }
    } else if (result.run.unattributedErrors.length > 0) {
      bisectTargets.push(pkg);
    }
  }
  const differs = (key: string, outcome: UnitOutcome | undefined): boolean => {
    const before = options.baseUnits[key];
    if (before === undefined) return !passed(outcome);
    return outcomeSignature(outcome) !== outcomeSignature(before);
  };
  const candidates = Object.keys({ ...headUnits, ...options.baseUnits }).filter(
    (key) => !options.excluded.has(key) && key in headUnits && differs(key, headUnits[key]),
  );

  const bisected: Array<string> = [];
  for (const pkg of bisectTargets) {
    const keys = Object.keys(headUnits).filter(
      (key) => packageOfProject(key.slice(0, key.indexOf("|"))) === pkg.dir,
    );
    const reproduces = async (group: ReadonlyArray<string>, label: string): Promise<boolean> => {
      const byProject = new Map<string, Array<string>>();
      for (const key of group) {
        const project = key.slice(0, key.indexOf("|"));
        byProject.set(project, [
          ...(byProject.get(project) ?? []),
          key.slice(key.indexOf("|") + 1),
        ]);
      }
      for (const [project, projectFiles] of byProject) {
        const result = await options.runCached(
          NodePath.join(options.caseCache, `bisect-${label}-${slug(project)}.json`),
          pkg,
          { project, files: projectFiles },
          options.env,
          "bisect",
        );
        if (result.run.unattributedErrors.length > 0 || result.run.reporterMissing) return true;
      }
      return false;
    };
    const search = async (group: ReadonlyArray<string>, label: string): Promise<void> => {
      if (!(await reproduces(group, label))) return;
      if (group.length === 1) {
        bisected.push(group[0] as string);
        return;
      }
      const middle = Math.ceil(group.length / 2);
      await search(group.slice(0, middle), `${label}a`);
      await search(group.slice(middle), `${label}b`);
    };
    await search(keys, "r");
  }

  const toConfirm = [...new Set([...candidates, ...bisected])];
  const changed: Array<string> = [];
  const flaky: Array<string> = [];
  const byProject = new Map<string, Array<string>>();
  for (const key of toConfirm) {
    const project = key.slice(0, key.indexOf("|"));
    byProject.set(project, [...(byProject.get(project) ?? []), key]);
  }
  for (const [project, keys] of byProject) {
    const pkg = options.packages.find((candidate) => candidate.dir === packageOfProject(project));
    if (pkg === undefined) continue;
    const scope: Scope = { project, files: keys.map((key) => key.slice(key.indexOf("|") + 1)) };
    const repeats: Array<PackageResult> = [];
    for (const attempt of [1, 2]) {
      repeats.push(
        await options.runCached(
          NodePath.join(options.caseCache, `repro${attempt}-${slug(project)}.json`),
          pkg,
          scope,
          options.env,
          `repro${attempt}`,
        ),
      );
    }
    for (const key of keys) {
      const isBisected = bisected.includes(key);
      const reproduced = repeats.every((repeat) =>
        isBisected
          ? repeat.run.unattributedErrors.length > 0 ||
            repeat.run.reporterMissing ||
            differs(key, repeat.units[key])
          : differs(key, repeat.units[key]),
      );
      (reproduced ? changed : flaky).push(key);
    }
  }
  return {
    changed,
    flaky,
    bisected,
    headUnits,
    headConfigs,
    runs,
    seconds: (performance.now() - started) / 1000,
  };
}

await main();
