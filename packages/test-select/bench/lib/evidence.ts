import * as NodePath from "node:path";

import { intersects } from "./coverage.ts";
import type { Observed, ProjectConfig, Trace } from "./schema.ts";
import { changedRanges, type ChangedRanges, isScript } from "./tokens.ts";

/** What differs between the base state and the head state of a case. */
export interface Changes {
  /** Changed paths (tracked edits, ignored files, symlinks) with their base and head content. */
  readonly files: ReadonlyMap<
    string,
    { readonly base: string | null; readonly head: string | null }
  >;
  /** Directories whose entry list differs. */
  readonly listings: ReadonlySet<string>;
  /** Env var names whose value or presence differs. */
  readonly env: ReadonlySet<string>;
  readonly node: boolean;
  /** `pnpm:<entry>` names of installed packages that differ. */
  readonly installed: ReadonlySet<string>;
}

export function hasChanges(changes: Changes): boolean {
  return (
    changes.files.size > 0 ||
    changes.listings.size > 0 ||
    changes.env.size > 0 ||
    changes.node ||
    changes.installed.size > 0
  );
}

/**
 * Directories whose entry list differs: the parent of the topmost added (or removed) ancestor of
 * each added (or removed) path, e.g. adding `a/b/c.ts` where only `a` exists lists `a`.
 */
export function changedListings(
  added: ReadonlyArray<string>,
  removed: ReadonlyArray<string>,
  existsAtBase: (dir: string) => boolean,
  existsAtHead: (dir: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  const climb = (path: string, exists: (dir: string) => boolean): void => {
    let top = path;
    while (NodePath.dirname(top) !== "." && !exists(NodePath.dirname(top)))
      top = NodePath.dirname(top);
    out.add(NodePath.dirname(top));
  };
  for (const path of added) climb(path, existsAtBase);
  for (const path of removed) climb(path, existsAtHead);
  return out;
}

export interface EvidenceContext {
  readonly changes: Changes;
  readonly changed: ReadonlySet<string>;
  readonly baseTraces: ReadonlyArray<Trace>;
  readonly baseConfigs: Readonly<Record<string, ProjectConfig>>;
  readonly headConfigs: Readonly<Record<string, ProjectConfig>>;
  readonly baseUnits: ReadonlySet<string>;
  readonly headUnits: ReadonlySet<string>;
  /** Head instrumented observations, for the units that had a head run. */
  readonly headTrace: Trace | null;
}

const rangesCache = new WeakMap<Changes, Map<string, ChangedRanges>>();

function scriptRanges(changes: Changes, path: string): ChangedRanges | null {
  const entry = changes.files.get(path);
  if (entry === undefined || !isScript(path)) return null;
  let cache = rangesCache.get(changes);
  if (cache === undefined) {
    cache = new Map();
    rangesCache.set(changes, cache);
  }
  let ranges = cache.get(path);
  if (ranges === undefined) {
    try {
      ranges = changedRanges(path, entry.base, entry.head);
    } catch {
      ranges = {
        base: entry.base === null ? [] : [[0, entry.base.length]],
        head: entry.head === null ? [] : [[0, entry.head.length]],
      };
    }
    cache.set(path, ranges);
  }
  return ranges;
}

function moduleFile(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

/** E1 against one observation: a changed range on `side` was executed, or a changed non-script module was evaluated. */
function executesChange(
  observed: Observed,
  changes: Changes,
  side: "base" | "head",
): string | null {
  for (const path of changes.files.keys()) {
    const ranges = scriptRanges(changes, path);
    if (ranges !== null) {
      if (ranges[side].length === 0) continue;
      if (observed.unmapped.includes(path)) return `E1 ${path} (evaluated, coverage unmapped)`;
      const executed = observed.executed[path];
      if (executed !== undefined && intersects(executed, ranges[side])) return `E1 ${path}`;
      continue;
    }
    for (const id of Object.keys(observed.transformed)) {
      if (moduleFile(id) === path) return `E1 ${path} (module)`;
    }
  }
  return null;
}

function readsChange(observed: Observed, changes: Changes): string | null {
  for (const path of observed.paths) {
    if (changes.files.has(path)) return `E2 reads ${path}`;
    if (changes.installed.has(path)) return `E2 reads installed ${path.slice(5)}`;
  }
  for (const dir of observed.listed) {
    if (changes.listings.has(dir)) return `E2 lists ${dir}`;
  }
  return null;
}

function readsEnv(observed: Observed, changes: Changes): string | null {
  if (changes.env.size === 0) return null;
  for (const name of observed.env) if (changes.env.has(name)) return `E3 reads ${name}`;
  if (observed.envEnumerated) return "E3 enumerates the environment";
  return null;
}

const projectOf = (key: string): string => key.slice(0, key.indexOf("|"));

/**
 * Evidence that a unit could be affected (DESIGN.md §14.3), or `null`. Base-run evidence uses
 * base-side changed ranges; head-run evidence uses head-side ranges and compares the head run
 * with the base runs (transformed code per module, E5).
 */
export function justify(key: string, context: EvidenceContext): string | null {
  const { changes } = context;
  if (context.changed.has(key)) return "E0 outcome changed";
  const project = projectOf(key);
  if (changes.node) return "E4 Node version differs";
  if (context.baseUnits.has(key) !== context.headUnits.has(key)) return "E4 membership changed";
  const baseConfig = context.baseConfigs[project];
  const headConfig = context.headConfigs[project];
  if (
    baseConfig !== undefined &&
    headConfig !== undefined &&
    baseConfig.config !== headConfig.config
  ) {
    return "E4 project config differs";
  }
  for (const trace of context.baseTraces) {
    const main = trace.projects[project];
    if (main !== undefined) {
      for (const path of main.config.paths) {
        const entry = changes.files.get(path);
        if (entry !== undefined && !isScript(path)) return `E2 config load reads ${path}`;
        if (changes.installed.has(path)) return `E2 config load reads installed ${path.slice(5)}`;
      }
      for (const dir of main.config.listed)
        if (changes.listings.has(dir)) return `E2 config load lists ${dir}`;
      const env = readsEnv(main.config, changes);
      if (env !== null) return `${env} at config load`;
    }
    const observed = trace.units[key];
    if (observed === undefined) continue;
    const reason =
      executesChange(observed, changes, "base") ??
      readsChange(observed, changes) ??
      readsEnv(observed, changes);
    if (reason !== null) return reason;
  }
  const head = context.headTrace?.units[key];
  if (head !== undefined) {
    const reason =
      executesChange(head, changes, "head") ??
      readsChange(head, changes) ??
      readsEnv(head, changes);
    if (reason !== null) return `${reason} (head run)`;
    const base = context.baseTraces[0]?.units[key];
    if (base !== undefined) {
      for (const [id, identity] of Object.entries(head.transformed)) {
        if (changes.files.has(moduleFile(id))) continue;
        const before = base.transformed[id];
        if (before === undefined) return `E2 resolves ${id} (head only)`;
        if (before !== identity) return `E2 transformed code of ${id} differs`;
      }
      for (const id of Object.keys(base.transformed)) {
        if (!(id in head.transformed) && !changes.files.has(moduleFile(id)))
          return `E2 no longer loads ${id}`;
      }
      const differential = differs(context.baseTraces, head, key);
      if (differential !== null) return `E5 ${differential}`;
    }
  }
  return null;
}

/** Whether the head observation differs from base beyond the variation between the base runs. */
function differs(baseTraces: ReadonlyArray<Trace>, head: Observed, key: string): string | null {
  const bases = baseTraces
    .map((trace) => trace.units[key])
    .filter((entry): entry is Observed => entry !== undefined);
  const first = bases[0];
  if (first === undefined) return null;
  const noisyFiles = new Set<string>();
  const noisyPaths = new Set<string>();
  for (const other of bases.slice(1)) {
    for (const file of symmetric(Object.keys(first.executed), Object.keys(other.executed)))
      noisyFiles.add(file);
    for (const path of symmetric(first.paths, other.paths)) noisyPaths.add(path);
  }
  for (const file of symmetric(Object.keys(first.executed), Object.keys(head.executed))) {
    if (!noisyFiles.has(file)) return `executes a different file set (${file})`;
  }
  for (const path of symmetric(first.paths, head.paths)) {
    if (
      !noisyPaths.has(path) &&
      !path.startsWith("node_modules/.vite") &&
      !path.startsWith("node_modules/.vitest")
    ) {
      return `reads a different path set (${path})`;
    }
  }
  return null;
}

function symmetric(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<string> {
  const left = new Set(a);
  const right = new Set(b);
  return [...a.filter((entry) => !right.has(entry)), ...b.filter((entry) => !left.has(entry))];
}

const cssCache = new WeakMap<Trace, ReadonlySet<string>>();

function cssProjects(trace: Trace): ReadonlySet<string> {
  let projects = cssCache.get(trace);
  if (projects === undefined) {
    const found = new Set<string>();
    for (const [unit, observed] of Object.entries(trace.units)) {
      if (Object.keys(observed.transformed).some((id) => /\.css(?:\?|$)/.test(id)))
        found.add(projectOf(unit));
    }
    projects = found;
    cssCache.set(trace, projects);
  }
  return projects;
}

/**
 * Whether a unit without base evidence needs a head instrumented run: the Vite main process read a
 * changed input after config load, so transformed code or resolution may differ (scripts count
 * only in projects whose units load CSS, which Tailwind generates from scanned sources).
 */
export function needsHeadRun(key: string, context: EvidenceContext): boolean {
  const project = projectOf(key);
  const { changes } = context;
  for (const trace of context.baseTraces) {
    const main = trace.projects[project];
    if (main === undefined) continue;
    const loadsCss = cssProjects(trace).has(project);
    const transformInput = (path: string): boolean =>
      (changes.files.has(path) && (loadsCss || !isScript(path))) || changes.installed.has(path);
    if (main.later.paths.some(transformInput)) return true;
    if (main.later.listed.some((dir) => changes.listings.has(dir))) return true;
  }
  return false;
}
