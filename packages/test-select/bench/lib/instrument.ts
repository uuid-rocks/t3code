import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";
import ts from "typescript";

import { browserCoverage, processCoverage } from "./coverage.ts";
import { BENCH_DIR, INSTRUMENTED_TIMEOUT_SECONDS } from "./env.ts";
import { projectId } from "./packages.ts";
import {
  BrowserCoverageFile,
  type Observed,
  ProcessRecordJson,
  type ProjectObserved,
  type TestPackage,
  type Trace,
  unitKey,
} from "./schema.ts";
import { parseStrace, straceCommand, type TracedProcess } from "./strace.ts";
import { type RunOptions, runPackage, type Scope } from "./suite.ts";
import type { Range } from "./tokens.ts";

const decodeProcessRecord = Schema.decodeUnknownExit(ProcessRecordJson);
const decodeBrowserCoverage = Schema.decodeUnknownExit(BrowserCoverageFile);

const PRELOAD = NodeURL.pathToFileURL(NodePath.join(BENCH_DIR, "oracle/preload.ts")).href;

type ProcessRecord = typeof ProcessRecordJson.Type;

interface Accumulator {
  readonly executed: Map<string, Array<Range>>;
  readonly unmapped: Set<string>;
  readonly paths: Set<string>;
  readonly listed: Set<string>;
  readonly env: Set<string>;
  envEnumerated: boolean;
  readonly transformed: Map<string, string>;
}

const empty = (): Accumulator => ({
  executed: new Map(),
  unmapped: new Set(),
  paths: new Set(),
  listed: new Set(),
  env: new Set(),
  envEnumerated: false,
  transformed: new Map(),
});

const sorted = (values: Iterable<string>): Array<string> =>
  [...values].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function freeze(acc: Accumulator): Observed {
  const executed: Record<string, ReadonlyArray<readonly [number, number]>> = {};
  for (const file of sorted(acc.executed.keys())) executed[file] = acc.executed.get(file) ?? [];
  return {
    executed,
    unmapped: sorted(acc.unmapped),
    paths: sorted(acc.paths),
    listed: sorted(acc.listed),
    env: sorted(acc.env),
    envEnumerated: acc.envEnumerated,
    transformed: Object.fromEntries(
      sorted(acc.transformed.keys()).map((id) => [id, acc.transformed.get(id) ?? ""]),
    ),
  };
}

/** Hash of transformed code with comments (and so its inline source map) removed. */
function codeIdentity(code: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
  const hash = NodeCrypto.createHash("sha256");
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    hash.update(scanner.getTokenText()).update("\0");
    kind = scanner.scan();
  }
  return hash.digest("hex").slice(0, 24);
}

/** Packages with a Vitest browser project; their instrumented runs collect CDP coverage. */
const BROWSER_PACKAGES = new Set(["apps/web"]);

/** Copies the oracle's web config wrapper and browser setup file into the checkout under test. */
function prepareBrowser(
  worktree: string,
  dir: string,
): { readonly dir: string; readonly config: string; readonly out: string } {
  const target = NodePath.join(worktree, dir, ".oracle");
  const out = NodePath.join(target, "coverage");
  NodeFS.rmSync(target, { recursive: true, force: true });
  NodeFS.mkdirSync(out, { recursive: true });
  const config = NodePath.join(target, "web-config.ts");
  NodeFS.copyFileSync(NodePath.join(BENCH_DIR, "oracle/web-config.ts"), config);
  const setup = NodeFS.readFileSync(NodePath.join(BENCH_DIR, "oracle/browser-setup.ts"), "utf8");
  NodeFS.writeFileSync(
    NodePath.join(target, "browser-setup.ts"),
    setup.replaceAll("__ORACLE_OUT__", out),
  );
  return { dir: target, config, out };
}

/**
 * Runs a package under the oracle's instruments: `strace -f` for file access and the process
 * tree, the preload for env reads, module code and worker attribution, and `NODE_V8_COVERAGE`.
 */
export async function runInstrumented(
  pkg: TestPackage,
  scope: Scope | null,
  options: RunOptions & { readonly readSource: (relative: string) => string | null },
): Promise<Trace> {
  const slug = `${options.label}-${pkg.dir.replaceAll("/", "_")}${scope === null ? "" : `-${scope.project.replaceAll(/[/#]/g, "_")}`}`;
  const dir = NodePath.join(options.logDir, `instr-${slug}`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  const coverageDir = NodePath.join(dir, "coverage");
  const oracleDir = NodePath.join(dir, "oracle");
  NodeFS.mkdirSync(coverageDir, { recursive: true });
  NodeFS.mkdirSync(oracleDir, { recursive: true });
  const stracePath = NodePath.join(dir, "strace.txt");
  const env = {
    ...options.env,
    NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ""} --import=${PRELOAD}`.trim(),
    NODE_V8_COVERAGE: coverageDir,
    ORACLE_DIR: oracleDir,
  };
  const browser = BROWSER_PACKAGES.has(pkg.dir) ? prepareBrowser(options.worktree, pkg.dir) : null;
  const { run, units: outcomes } = await runPackage(pkg, scope, {
    ...options,
    env,
    wrap: straceCommand(options.worktree, stracePath),
    timeoutSeconds: INSTRUMENTED_TIMEOUT_SECONDS,
    ...(browser === null ? {} : { extraArgs: ["--config", browser.config] }),
  });
  // With -qq strace prints only errors, such as its output filter exiting early.
  const straceError = /^strace: .*$/m.exec(NodeFS.readFileSync(run.log, "utf8"));
  if (straceError !== null) {
    throw new Error(`instrumented run of ${pkg.dir} lost tracer output: ${straceError[0]}`);
  }

  const records = new Map<number, ProcessRecord>();
  const procDir = NodePath.join(oracleDir, "proc");
  for (const name of NodeFS.existsSync(procDir) ? NodeFS.readdirSync(procDir) : []) {
    const parsed = decodeProcessRecord(NodeFS.readFileSync(NodePath.join(procDir, name), "utf8"));
    if (parsed._tag === "Success") records.set(parsed.value.pid, parsed.value);
  }
  const trace = await parseStrace(stracePath);
  const workers = [...records.values()].filter((record) => record.isWorker);
  const workerUnits = new Map<number, Array<string>>();
  for (const worker of workers) {
    const keys = worker.files.map((file) =>
      unitKey({
        project: projectId(pkg.dir, worker.projectName ?? ""),
        file: NodePath.relative(options.worktree, file),
      }),
    );
    workerUnits.set(worker.pid, keys);
  }
  const mainPids = new Set(
    workers.map((worker) => trace.processes.get(worker.pid)?.parent ?? worker.ppid),
  );
  const firstUnitStart = Math.min(
    ...workers.map(
      (worker) => trace.processes.get(worker.pid)?.startedAt ?? Number.POSITIVE_INFINITY,
    ),
  );

  /** Units a process belongs to: those of its nearest worker ancestor, or none for main-side processes. */
  const unitsOf = (pid: number): ReadonlyArray<string> => {
    let current: number | null = pid;
    const seen = new Set<number>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const keys = workerUnits.get(current);
      if (keys !== undefined) return keys;
      const record = records.get(current);
      if (record?.unitPid !== null && record?.unitPid !== undefined) {
        const inherited = workerUnits.get(record.unitPid);
        if (inherited !== undefined) return inherited;
      }
      current = trace.processes.get(current)?.parent ?? null;
    }
    return [];
  };

  const unitAcc = new Map<string, Accumulator>();
  const accFor = (key: string): Accumulator => {
    let acc = unitAcc.get(key);
    if (acc === undefined) {
      acc = empty();
      unitAcc.set(key, acc);
    }
    return acc;
  };
  for (const key of Object.keys(outcomes)) accFor(key);
  const configAcc = empty();
  const laterAcc = empty();

  const realpaths = new Map<string, string>();
  const real = (absolute: string): string => {
    let resolved = realpaths.get(absolute);
    if (resolved === undefined) {
      try {
        resolved = NodeFS.realpathSync(absolute);
      } catch {
        resolved = absolute;
      }
      realpaths.set(absolute, resolved);
    }
    return resolved;
  };
  const relative = (path: string): string | null => {
    const absolute =
      path.includes("/node_modules/") && !path.includes("/node_modules/.pnpm/") ? real(path) : path;
    const rel = NodePath.relative(options.worktree, absolute);
    if (rel === "") return ".";
    if (rel.startsWith("..") || NodePath.isAbsolute(rel)) return null;
    const parts = rel.split(NodePath.sep);
    const nm = parts.indexOf("node_modules");
    if (nm === -1) return rel;
    if (parts[nm + 1] === ".pnpm" && parts[nm + 2] !== undefined) {
      return `pnpm:${parts[nm + 2]}`;
    }
    return parts.slice(0, nm + 3).join("/");
  };
  const addReads = (acc: Accumulator, proc: TracedProcess, cutoff: number | null): void => {
    for (const [path, at] of proc.reads) {
      if (cutoff !== null && at >= cutoff) continue;
      const rel = relative(path);
      if (rel !== null) acc.paths.add(rel);
    }
    for (const [path, at] of proc.listed) {
      if (cutoff !== null && at >= cutoff) continue;
      const rel = relative(path);
      if (rel !== null) acc.listed.add(rel);
    }
  };
  const addLaterReads = (acc: Accumulator, proc: TracedProcess, cutoff: number): void => {
    for (const [path, at] of proc.reads) {
      if (at < cutoff) continue;
      const rel = relative(path);
      if (rel !== null) acc.paths.add(rel);
    }
    for (const [path, at] of proc.listed) {
      if (at < cutoff) continue;
      const rel = relative(path);
      if (rel !== null) acc.listed.add(rel);
    }
  };

  for (const proc of trace.processes.values()) {
    const keys = unitsOf(proc.pid);
    if (keys.length > 0) {
      for (const key of keys) addReads(accFor(key), proc, null);
      continue;
    }
    addReads(configAcc, proc, firstUnitStart);
    addLaterReads(laterAcc, proc, firstUnitStart);
  }

  const partial: Record<string, string> = {};
  const coverageFiles = new Map<number, Array<string>>();
  for (const name of NodeFS.readdirSync(coverageDir)) {
    const match = /^coverage-(\d+)-/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    const list = coverageFiles.get(pid) ?? [];
    list.push(NodePath.join(coverageDir, name));
    coverageFiles.set(pid, list);
  }
  const codeDir = NodePath.join(oracleDir, "code");
  const codeIds = new Map<string, string>();
  for (const record of records.values()) {
    const keys = unitsOf(record.pid);
    const isMain = keys.length === 0;
    const targets = isMain ? [laterAcc] : keys.map(accFor);
    for (const target of targets) {
      for (const name of record.env) target.env.add(name);
      if (record.envEnumerated) target.envEnumerated = true;
    }
    if (isMain && mainPids.has(record.pid)) {
      for (const name of record.env) configAcc.env.add(name);
      if (record.envEnumerated) configAcc.envEnumerated = true;
    }
    for (const [id, sha] of Object.entries(record.scripts)) {
      const rel = relative(id.split("?")[0] ?? id);
      if (rel === null) continue;
      const query = id.includes("?") ? id.slice(id.indexOf("?")) : "";
      let identity = codeIds.get(sha);
      if (identity === undefined) {
        const path = NodePath.join(codeDir, `${sha}.js`);
        identity = NodeFS.existsSync(path) ? codeIdentity(NodeFS.readFileSync(path, "utf8")) : sha;
        codeIds.set(sha, identity);
      }
      for (const target of targets) target.transformed.set(`${rel}${query}`, identity);
    }
    const coverage = processCoverage({
      files: coverageFiles.get(record.pid) ?? [],
      scripts: record.scripts,
      codeDir,
      worktree: options.worktree,
      readSource: options.readSource,
    });
    for (const target of targets) {
      for (const [file, ranges] of coverage.executed) {
        const list = target.executed.get(file) ?? [];
        list.push(...ranges);
        target.executed.set(file, list);
      }
      for (const file of coverage.unmapped) target.unmapped.add(file);
    }
  }
  for (const proc of trace.processes.values()) {
    if (records.has(proc.pid)) continue;
    const isNode = proc.execs.some((exec) => /\/node$/.test(exec));
    if (!isNode) continue;
    for (const key of unitsOf(proc.pid)) {
      partial[key] =
        `node process ${proc.pid} ran without the oracle preload (environment replaced)`;
    }
  }
  const attributed = new Set([...workerUnits.values()].flat());
  if (browser !== null) {
    const root = NodePath.join(options.worktree, pkg.dir);
    for (const name of NodeFS.existsSync(browser.out) ? NodeFS.readdirSync(browser.out) : []) {
      const parsed = decodeBrowserCoverage(
        NodeFS.readFileSync(NodePath.join(browser.out, name), "utf8"),
      );
      if (parsed._tag === "Failure") continue;
      const key = unitKey({
        project: projectId(pkg.dir, "browser"),
        file: NodePath.relative(options.worktree, parsed.value.testFile),
      });
      const coverage = browserCoverage({
        scripts: parsed.value.scripts,
        root,
        worktree: options.worktree,
        readSource: options.readSource,
      });
      const target = accFor(key);
      for (const [file, ranges] of coverage.executed)
        target.executed.set(file, [...(target.executed.get(file) ?? []), ...ranges]);
      for (const file of coverage.unmapped) target.unmapped.add(file);
      for (const [id, source] of coverage.transformed)
        target.transformed.set(id, codeIdentity(source));
      attributed.add(key);
    }
    NodeFS.rmSync(browser.dir, { recursive: true, force: true });
  }
  for (const key of unitAcc.keys()) {
    if (!(key in outcomes)) partial[key] ??= "observed without an outcome";
    else if (!attributed.has(key)) partial[key] ??= "no worker process ran this unit";
  }
  if (run.reporterMissing) {
    for (const key of unitAcc.keys()) partial[key] = "reporter output missing";
  }

  const units: Record<string, Observed> = {};
  for (const [key, acc] of unitAcc) {
    for (const [file, ranges] of acc.executed) acc.executed.set(file, merge(ranges));
    units[key] = freeze(acc);
  }
  const projects: Record<string, ProjectObserved> = {};
  const projectIds = new Set(Object.keys(units).map((key) => key.slice(0, key.indexOf("|"))));
  const config = freeze(configAcc);
  const later = freeze(laterAcc);
  for (const project of projectIds) projects[project] = { config, later };
  NodeFS.rmSync(dir, { recursive: true, force: true });
  return { units, projects, outcomes, partial };
}

function merge(ranges: ReadonlyArray<Range>): Array<Range> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
