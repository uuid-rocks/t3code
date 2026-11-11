import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";
import * as Schema from "effect/Schema";

import { type BrowserCoverageFile, NodeCoverageFile, SourceMapJson } from "./schema.ts";
import type { Range } from "./tokens.ts";

type V8Function = (typeof NodeCoverageFile.Type)["result"][number]["functions"][number];

/** Flat partition of a script into `[start, end, count]` by the innermost range at each offset. */
function partition(functions: ReadonlyArray<V8Function>): Array<readonly [number, number, number]> {
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .toSorted((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const out: Array<readonly [number, number, number]> = [];
  const stack: Array<{ readonly end: number; readonly count: number }> = [];
  let cursor = 0;
  const emit = (until: number): void => {
    while (cursor < until) {
      while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= cursor) stack.pop();
      const top = stack.at(-1);
      if (top === undefined) {
        cursor = until;
        return;
      }
      const stop = Math.min(until, top.end);
      if (stop > cursor) out.push([cursor, stop, top.count]);
      cursor = stop;
    }
  };
  for (const range of ranges) {
    emit(range.startOffset);
    cursor = Math.max(cursor, range.startOffset);
    stack.push({ end: range.endOffset, count: range.count });
  }
  emit(Number.MAX_SAFE_INTEGER);
  return out;
}

function countAt(parts: ReadonlyArray<readonly [number, number, number]>, offset: number): number {
  let low = 0;
  let high = parts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const part = parts[mid];
    if (part === undefined) break;
    if (offset < part[0]) high = mid - 1;
    else if (offset >= part[1]) low = mid + 1;
    else return part[2];
  }
  return 0;
}

function lineStarts(text: string): Array<number> {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function mergeRanges(ranges: ReadonlyArray<Range>): Array<Range> {
  const sorted = ranges.toSorted((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const INLINE_MAP =
  /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,([A-Za-z0-9+/=]+)\s*$/m;
const decodeSourceMap = Schema.decodeUnknownExit(Schema.fromJsonString(SourceMapJson));
const decodeCoverageFile = Schema.decodeUnknownExit(NodeCoverageFile);

/** Executed source ranges of a module the Vite module runner evaluated from `wrapped`. */
function moduleRanges(
  wrapped: string,
  file: string,
  sourceText: string,
  parts: ReadonlyArray<readonly [number, number, number]>,
): ReadonlyArray<Range> | null {
  const marker = "=>{{";
  const prefix = wrapped.startsWith("'use strict';async (")
    ? wrapped.indexOf(marker) + marker.length
    : 0;
  const all = [...wrapped.matchAll(new RegExp(INLINE_MAP.source, "gm"))];
  const encoded = all.at(-1)?.[1];
  if (encoded === undefined) return null;
  const json = Buffer.from(encoded, "base64").toString("utf8");
  const decoded = decodeSourceMap(json);
  if (decoded._tag === "Failure") return null;
  const map = new TraceMap(json);
  const code = wrapped.slice(prefix);
  const genStarts = lineStarts(code);
  const srcStarts = lineStarts(sourceText);
  const sources = map.resolvedSources;
  const isOwn = (source: string): boolean =>
    sources.length === 1 ||
    NodePath.resolve(NodePath.dirname(file), source) === file ||
    NodePath.basename(source) === NodePath.basename(file);
  const points: Array<readonly [number, boolean]> = [];
  eachMapping(map, (mapping) => {
    if (mapping.source === null || mapping.originalLine === null || mapping.originalColumn === null)
      return;
    if (!isOwn(mapping.source)) return;
    const genLine = genStarts[mapping.generatedLine - 1];
    const srcLine = srcStarts[mapping.originalLine - 1];
    if (genLine === undefined || srcLine === undefined) return;
    const generated = prefix + genLine + mapping.generatedColumn;
    points.push([srcLine + mapping.originalColumn, countAt(parts, generated) > 0]);
  });
  points.sort((a, b) => a[0] - b[0]);
  const ranges: Array<Range> = [];
  let runStart: number | null = null;
  for (const [offset, executed] of points) {
    if (executed && runStart === null) runStart = offset;
    if (!executed && runStart !== null) {
      if (offset > runStart) ranges.push([runStart, offset]);
      runStart = null;
    }
  }
  if (runStart !== null) ranges.push([runStart, sourceText.length]);
  return mergeRanges(ranges);
}

export interface ProcessCoverage {
  /** Executed ranges per repo-relative file. */
  readonly executed: Map<string, ReadonlyArray<Range>>;
  /** Files evaluated whose coverage could not be mapped. */
  readonly unmapped: Set<string>;
}

/**
 * Reads every `NODE_V8_COVERAGE` file of one process. `scripts` maps Vite module ids to the sha of
 * the code the preload saved under `codeDir`; other repo scripts were loaded by Node from disk.
 */
export function processCoverage(options: {
  readonly files: ReadonlyArray<string>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly codeDir: string;
  readonly worktree: string;
  readonly readSource: (relative: string) => string | null;
}): ProcessCoverage {
  const executed = new Map<string, Array<Range>>();
  const unmapped = new Set<string>();
  const inRepo = (absolute: string): string | null => {
    const relative = NodePath.relative(options.worktree, absolute);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
    if (relative.split(NodePath.sep).includes("node_modules")) return null;
    return relative;
  };
  const add = (file: string, ranges: ReadonlyArray<Range>): void => {
    const list = executed.get(file) ?? [];
    list.push(...ranges);
    executed.set(file, list);
  };
  const covered = new Set<string>();
  const byUrl = new Map<string, string>();
  for (const id of Object.keys(options.scripts)) {
    byUrl.set(id, id);
    const query = id.indexOf("?");
    const path = query === -1 ? id : id.slice(0, query);
    if (NodePath.isAbsolute(path)) {
      byUrl.set(NodeURL.pathToFileURL(path).href + (query === -1 ? "" : id.slice(query)), id);
    }
  }
  for (const coverageFile of options.files) {
    const parsed = decodeCoverageFile(NodeFS.readFileSync(coverageFile, "utf8"));
    if (parsed._tag === "Failure") continue;
    for (const script of parsed.value.result) {
      const url = script.url;
      const id = byUrl.get(url);
      const sha = id === undefined ? undefined : options.scripts[id];
      if (id !== undefined && sha !== undefined) {
        const absolute = id.split("?")[0] ?? id;
        const relative = inRepo(absolute);
        if (relative === null) continue;
        covered.add(id);
        const source = options.readSource(relative);
        const codePath = NodePath.join(options.codeDir, `${sha}.js`);
        if (source === null || !NodeFS.existsSync(codePath)) {
          unmapped.add(relative);
          continue;
        }
        const ranges = moduleRanges(
          NodeFS.readFileSync(codePath, "utf8"),
          absolute,
          source,
          partition(script.functions),
        );
        if (ranges === null) unmapped.add(relative);
        else add(relative, ranges);
        continue;
      }
      if (!url.startsWith("file://")) continue;
      const relative = inRepo(NodeURL.fileURLToPath(url));
      if (relative === null) continue;
      const ranges = partition(script.functions)
        .filter(([, , count]) => count > 0)
        .map(([start, end]): Range => [start, end]);
      add(relative, ranges);
    }
  }
  for (const id of Object.keys(options.scripts)) {
    if (covered.has(id)) continue;
    const relative = inRepo(id.split("?")[0] ?? id);
    if (relative !== null) unmapped.add(relative);
  }
  const merged = new Map<string, ReadonlyArray<Range>>();
  for (const [file, ranges] of executed) merged.set(file, mergeRanges(ranges));
  return { executed: merged, unmapped };
}

/** Whether any of `changed` intersects an executed range. */
export function intersects(executed: ReadonlyArray<Range>, changed: ReadonlyArray<Range>): boolean {
  for (const [start, end] of changed) {
    for (const [runStart, runEnd] of executed) {
      if (runStart < Math.max(end, start + 1) && start < runEnd) return true;
    }
  }
  return false;
}

/**
 * Executed ranges per repo file from one browser test file's CDP coverage. Script URLs are Vite
 * dev-server paths: `/src/a.tsx` under `root`, or `/@fs/<absolute path>`.
 */
export function browserCoverage(options: {
  readonly scripts: ReadonlyArray<(typeof BrowserCoverageFile.Type)["scripts"][number]>;
  readonly root: string;
  readonly worktree: string;
  readonly readSource: (relative: string) => string | null;
}): ProcessCoverage & { readonly transformed: Map<string, string> } {
  const executed = new Map<string, ReadonlyArray<Range>>();
  const unmapped = new Set<string>();
  const transformed = new Map<string, string>();
  for (const script of options.scripts) {
    const url = new URL(script.url);
    const pathname = decodeURIComponent(url.pathname);
    const absolute = pathname.startsWith("/@fs/")
      ? pathname.slice(4)
      : NodePath.join(options.root, pathname);
    const relative = NodePath.relative(options.worktree, absolute);
    if (
      relative.startsWith("..") ||
      NodePath.isAbsolute(relative) ||
      relative.split(NodePath.sep).includes("node_modules")
    ) {
      continue;
    }
    const query = [...url.searchParams.keys()].filter((key) => key !== "v" && key !== "t");
    transformed.set(`${relative}${query.length === 0 ? "" : `?${query.join("&")}`}`, script.source);
    const source = options.readSource(relative);
    const ranges =
      source === null
        ? null
        : moduleRanges(script.source, absolute, source, partition(script.functions));
    if (ranges === null) unmapped.add(relative);
    else executed.set(relative, mergeRanges([...(executed.get(relative) ?? []), ...ranges]));
  }
  return { executed, unmapped, transformed };
}
