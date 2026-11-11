import * as Schema from "effect/Schema";

export type UnitKey = string;

/** One test file in one Vitest project, e.g. `{ project: "apps/web#browser", file: "apps/web/src/a.browser.test.tsx" }`. */
export type Unit = typeof Unit.Type;
export const Unit = Schema.Struct({ project: Schema.String, file: Schema.String });

export const unitKey = (unit: Unit): UnitKey => `${unit.project}|${unit.file}`;

export const parseUnitKey = (key: UnitKey): Unit => {
  const bar = key.indexOf("|");
  return { project: key.slice(0, bar), file: key.slice(bar + 1) };
};

export type ProjectConfig = typeof ProjectConfig.Type;
export const ProjectConfig = Schema.Struct({ config: Schema.String, membership: Schema.String });

export const ModuleOutcome = Schema.Struct({
  project: Schema.String,
  file: Schema.String,
  state: Schema.String,
  tests: Schema.Record(Schema.String, Schema.String),
  errors: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});

/** What `oracle/reporter.ts` writes for one Vitest invocation. */
export const ReporterOutput = Schema.Struct({
  modules: Schema.Array(ModuleOutcome),
  unhandledErrors: Schema.Array(
    Schema.Struct({ message: Schema.String, testPath: Schema.NullOr(Schema.String) }),
  ),
  reason: Schema.String,
  configs: Schema.Record(Schema.String, ProjectConfig),
});

export type FileEdit = typeof FileEdit.Type;
export const FileEdit = Schema.Union([
  Schema.Struct({ op: Schema.Literal("write"), path: Schema.String, content: Schema.String }),
  Schema.Struct({ op: Schema.Literal("delete"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("symlink"), path: Schema.String, target: Schema.String }),
]);

export type CaseEnv = typeof CaseEnv.Type;
export const CaseEnv = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.String),
  unset: Schema.Array(Schema.String),
});

/**
 * One `(base, head)` pair. `edits` become the head commit; `ignored` are git-ignored files written
 * after it; `env` and `node` apply to every process of the head state.
 */
export type Case = typeof Case.Type;
export const Case = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  description: Schema.String,
  /** Test project the case was generated for, or `null` for repo-wide cases. */
  project: Schema.NullOr(Schema.String),
  edits: Schema.Array(FileEdit),
  ignored: Schema.Array(FileEdit),
  env: CaseEnv,
  node: Schema.NullOr(Schema.String),
  /** Runs `pnpm install` at head, for lockfile, patch and manifest dependency changes. */
  install: Schema.Boolean,
  /** The only correct selection is Standing. */
  expectStanding: Schema.Boolean,
});

export const CaseJson = Schema.fromJsonString(Case);

/** Selector output; `all: true` is the run-everything fallback. */
export type Selection = typeof Selection.Type;
export const Selection = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean),
  selected: Schema.Array(Unit),
  reasons: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export const SelectionJson = Schema.fromJsonString(Selection);

/** One package's `test` script, as `vp test run <args>` run in `dir`. */
export type TestPackage = typeof TestPackage.Type;
export const TestPackage = Schema.Struct({
  dir: Schema.String,
  name: Schema.String,
  args: Schema.Array(Schema.String),
});

export const PackageManifestJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

/** Outcome of one unit in a run: file state, per-test map and attributed errors. */
export type UnitOutcome = typeof UnitOutcome.Type;
export const UnitOutcome = Schema.Struct({
  state: Schema.String,
  tests: Schema.Record(Schema.String, Schema.String),
  errors: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});

export type PackageRun = typeof PackageRun.Type;
export const PackageRun = Schema.Struct({
  dir: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  seconds: Schema.Number,
  reporterMissing: Schema.Boolean,
  unattributedErrors: Schema.Array(Schema.String),
  log: Schema.String,
});

/** Executed `[start, end)` source ranges per repo-relative file. */
export const Executed = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
);

/** What an instrumented run observed for one unit's process tree, or a project's main process. */
export type Observed = typeof Observed.Type;
export const Observed = Schema.Struct({
  executed: Executed,
  /** Files evaluated whose coverage could not be mapped; any change in them counts as executed. */
  unmapped: Schema.Array(Schema.String),
  /** Repo-relative paths opened, stat'd, exec'd or probed (ENOENT included). */
  paths: Schema.Array(Schema.String),
  /** Repo-relative directories listed. */
  listed: Schema.Array(Schema.String),
  /** Env var names read. */
  env: Schema.Array(Schema.String),
  envEnumerated: Schema.Boolean,
  /** Vite module id (repo-relative, query kept) → hash of the transformed code, comments removed. */
  transformed: Schema.Record(Schema.String, Schema.String),
});

export type ProjectObserved = typeof ProjectObserved.Type;
export const ProjectObserved = Schema.Struct({
  /** Reads and env before the first unit started (config load), shared by every unit. */
  config: Observed,
  /** Main-process activity after config load. */
  later: Observed,
});

/** An instrumented run: observations per unit and per project, plus its outcomes. */
export type Trace = typeof Trace.Type;
export const Trace = Schema.Struct({
  units: Schema.Record(Schema.String, Observed),
  projects: Schema.Record(Schema.String, ProjectObserved),
  outcomes: Schema.Record(Schema.String, UnitOutcome),
  /** Units whose observation is incomplete (a process without a preload record, browser units). */
  partial: Schema.Record(Schema.String, Schema.String),
});

export const TraceJson = Schema.fromJsonString(Trace);

/** A record the oracle preload writes per Node process. */
export const ProcessRecordJson = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    ppid: Schema.Number,
    unitPid: Schema.NullOr(Schema.Number),
    isWorker: Schema.Boolean,
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    startedAt: Schema.Number,
    files: Schema.Array(Schema.String),
    projectName: Schema.NullOr(Schema.String),
    env: Schema.Array(Schema.String),
    envEnumerated: Schema.Boolean,
    scripts: Schema.Record(Schema.String, Schema.String),
  }),
);

const V8Function = Schema.Struct({
  functionName: Schema.String,
  ranges: Schema.Array(
    Schema.Struct({ startOffset: Schema.Number, endOffset: Schema.Number, count: Schema.Number }),
  ),
  isBlockCoverage: Schema.Boolean,
});

/** A `NODE_V8_COVERAGE` output file. */
export const NodeCoverageFile = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Array(
      Schema.Struct({
        scriptId: Schema.String,
        url: Schema.String,
        functions: Schema.Array(V8Function),
      }),
    ),
  }),
);

export const SourceMapJson = Schema.Struct({
  version: Schema.Number,
  sources: Schema.Array(Schema.NullOr(Schema.String)),
  mappings: Schema.String,
});

/** A browser test file's coverage, as `oracle/browser-setup.ts` writes it. */
export const BrowserCoverageFile = Schema.fromJsonString(
  Schema.Struct({
    testFile: Schema.String,
    scripts: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        source: Schema.String,
        functions: Schema.Array(V8Function),
      }),
    ),
  }),
);

/** One package's run, as cached. */
export type PackageResult = typeof PackageResult.Type;
export const PackageResult = Schema.Struct({
  run: PackageRun,
  units: Schema.Record(Schema.String, UnitOutcome),
  configs: Schema.Record(Schema.String, ProjectConfig),
});

export const PackageResultJson = Schema.fromJsonString(PackageResult);

/** Ground truth of one case (DESIGN.md §14.2). */
export type Truth = typeof Truth.Type;
export const Truth = Schema.Struct({
  /** Units whose outcome differs from base in the head run and in both reproduction runs. */
  changed: Schema.Array(Schema.String),
  /** Units that differed in the head run but not in a reproduction run. */
  flaky: Schema.Array(Schema.String),
  /** Units reached by bisecting a run-level error with no attributed file. */
  bisected: Schema.Array(Schema.String),
  headUnits: Schema.Record(Schema.String, UnitOutcome),
  headConfigs: Schema.Record(Schema.String, ProjectConfig),
  runs: Schema.Array(PackageRun),
  seconds: Schema.Number,
});

export const TruthJson = Schema.fromJsonString(Truth);
