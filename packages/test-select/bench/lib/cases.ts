import * as NodePath from "node:path";

import { DEFAULT_NODE } from "./env.ts";
import { type Mutation, mutateScript, pick, type Random, seededRandom, shuffle } from "./mutate.ts";
import { packageOfProject } from "./packages.ts";
import type { Case, FileEdit, Trace, Unit } from "./schema.ts";
import { isScript, type Range } from "./tokens.ts";

/** What case generation reads about the base state. */
export interface GenerationContext {
  /** Tracked paths at base, outside `.repos/`. */
  readonly files: ReadonlyArray<string>;
  readonly tracked: ReadonlySet<string>;
  readonly read: (path: string) => string | null;
  readonly units: ReadonlyArray<Unit>;
  readonly projects: ReadonlyArray<string>;
  /** Base instrumented run. */
  readonly trace: Trace;
  readonly isIgnored: (path: string) => boolean;
}

const NO_ENV = { set: {}, unset: [] } as const;

function makeCase(
  partial: Pick<Case, "id" | "category" | "description" | "edits"> &
    Partial<Omit<Case, "id" | "category" | "description" | "edits">>,
): Case {
  return {
    project: null,
    ignored: [],
    env: NO_ENV,
    node: null,
    install: false,
    expectStanding: false,
    ...partial,
  };
}

const isTestFile = (path: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$|\.renders\.tsx$/.test(path);

/** Executed ranges per file, over every unit of `projects` (all units when null). */
function executedByProjects(
  trace: Trace,
  projects: ReadonlySet<string> | null,
): Map<string, Array<Range>> {
  const out = new Map<string, Array<Range>>();
  for (const [key, observed] of Object.entries(trace.units)) {
    const project = key.slice(0, key.indexOf("|"));
    if (projects !== null && !projects.has(project)) continue;
    for (const [file, ranges] of Object.entries(observed.executed)) {
      const list = out.get(file) ?? [];
      list.push(...ranges);
      out.set(file, list);
    }
  }
  return out;
}

/** Picks a file with probability proportional to its executed length, then mutates inside it. */
function coveredMutation(
  random: Random,
  context: GenerationContext,
  executed: Map<string, Array<Range>>,
  filter: (file: string) => boolean,
): { readonly file: string; readonly mutation: Mutation } | null {
  const candidates = [...executed.entries()].filter(
    ([file]) => filter(file) && isScript(file) && context.tracked.has(file),
  );
  const weighted = candidates.map(([file, ranges]) => ({
    file,
    ranges,
    weight: ranges.reduce((sum, [start, end]) => sum + (end - start), 0),
  }));
  for (let attempt = 0; attempt < 12 && weighted.length > 0; attempt++) {
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let target = random() * total;
    let chosen = weighted[0];
    for (const entry of weighted) {
      target -= entry.weight;
      if (target <= 0) {
        chosen = entry;
        break;
      }
    }
    if (chosen === undefined) return null;
    const text = context.read(chosen.file);
    if (text === null) continue;
    const mutation = mutateScript(random, chosen.file, text, chosen.ranges);
    if (mutation !== null) return { file: chosen.file, mutation };
    chosen.weight = 0;
  }
  return null;
}

function uncoveredMutation(
  random: Random,
  context: GenerationContext,
  allExecuted: Map<string, Array<Range>>,
  projectFiles: ReadonlyArray<string>,
): { readonly file: string; readonly mutation: Mutation } | null {
  for (const file of shuffle(random, projectFiles).slice(0, 12)) {
    const text = context.read(file);
    if (text === null) continue;
    const mutation = mutateScript(random, file, text, null, allExecuted.get(file) ?? []);
    if (mutation !== null) return { file, mutation };
  }
  return null;
}

/** Source files a project's units loaded, or for unobserved (browser) projects, its package's sources. */
function projectSources(
  context: GenerationContext,
  project: string,
  executed: Map<string, Array<Range>>,
): Array<string> {
  const own = [...executed.keys()].filter(
    (file) => !isTestFile(file) && isScript(file) && context.tracked.has(file),
  );
  if (own.length > 0) return own;
  const dir = packageOfProject(project);
  return context.files.filter(
    (file) => file.startsWith(`${dir}/src/`) && isScript(file) && !isTestFile(file),
  );
}

function mutationCase(
  random: Random,
  context: GenerationContext,
  project: string,
  index: number,
): Case | null {
  const executed = executedByProjects(context.trace, new Set([project]));
  const allExecuted = executedByProjects(context.trace, null);
  for (const main of Object.values(context.trace.projects)) {
    for (const [file, ranges] of Object.entries(main.later.executed)) {
      allExecuted.set(file, [...(allExecuted.get(file) ?? []), ...ranges]);
    }
    for (const [file, ranges] of Object.entries(main.config.executed)) {
      allExecuted.set(file, [...(allExecuted.get(file) ?? []), ...ranges]);
    }
  }
  const roll = random();
  const unitsOfProject = context.units.filter((unit) => unit.project === project);
  const observed = Object.keys(context.trace.units).some(
    (key) => key.startsWith(`${project}|`) && context.trace.partial[key] === undefined,
  );
  if (roll < 0.2 && unitsOfProject.length > 0) {
    const unit = pick(random, unitsOfProject);
    const text = unit === undefined ? null : context.read(unit.file);
    if (unit !== undefined && text !== null) {
      const mutation = mutateScript(
        random,
        unit.file,
        text,
        observed ? (executed.get(unit.file) ?? null) : null,
      );
      if (mutation !== null) {
        return makeCase({
          id: `test-file-${index}`,
          category: "Test-file mutations",
          project,
          description: `${mutation.operator} in test file ${unit.file}:${mutation.line}`,
          edits: [{ op: "write", path: unit.file, content: mutation.text }],
        });
      }
    }
  }
  if (roll >= 0.2 && roll < 0.35 && observed) {
    const found = uncoveredMutation(
      random,
      context,
      allExecuted,
      projectSources(context, project, executed),
    );
    if (found !== null) {
      return makeCase({
        id: `uncovered-${index}`,
        category: "Uncovered-location mutations",
        project,
        description: `${found.mutation.operator} at uncovered ${found.file}:${found.mutation.line}`,
        edits: [{ op: "write", path: found.file, content: found.mutation.text }],
        expectStanding: true,
      });
    }
  }
  const found = observed
    ? coveredMutation(random, context, executed, (file) => !isTestFile(file))
    : (() => {
        for (const file of shuffle(random, projectSources(context, project, executed)).slice(
          0,
          12,
        )) {
          const text = context.read(file);
          const mutation = text === null ? null : mutateScript(random, file, text, null);
          if (mutation !== null) return { file, mutation };
        }
        return null;
      })();
  if (found === null) return null;
  const category = project.endsWith("#browser")
    ? "Source mutations, browser"
    : project.startsWith("apps/mobile")
      ? "Source mutations, mobile"
      : "Source mutations, node projects";
  return makeCase({
    id: `source-${index}`,
    category,
    project,
    description: `${found.mutation.operator} in ${found.file}:${found.mutation.line}`,
    edits: [{ op: "write", path: found.file, content: found.mutation.text }],
  });
}

type Template = (random: Random, context: GenerationContext) => Case | null;

/** Replaces the first match of `pattern` in a tracked file; `null` when the file or match is missing. */
function replaceIn(
  context: GenerationContext,
  path: string,
  pattern: RegExp | string,
  replacement: string,
): FileEdit | null {
  const text = context.read(path);
  if (text === null) return null;
  const next = text.replace(pattern, replacement);
  return next === text ? null : { op: "write", path, content: next };
}

function single(
  id: string,
  category: string,
  description: string,
  edit: FileEdit | null,
  extra: Partial<Case> = {},
): Case | null {
  return edit === null ? null : makeCase({ id, category, description, edits: [edit], ...extra });
}

/** Files some unit read at base, matching `pattern`. */
function readByUnits(context: GenerationContext, pattern: RegExp): Array<string> {
  const out = new Set<string>();
  for (const observed of Object.values(context.trace.units)) {
    for (const path of observed.paths)
      if (pattern.test(path) && context.tracked.has(path)) out.add(path);
  }
  return [...out].toSorted();
}

function commentEdit(
  random: Random,
  context: GenerationContext,
  executed: Map<string, Array<Range>>,
): Case | null {
  const files = [...executed.keys()].filter(
    (file) => isScript(file) && !isTestFile(file) && context.tracked.has(file),
  );
  const file = pick(random, files);
  const text = file === undefined ? null : context.read(file);
  if (file === undefined || text === null) return null;
  const lines = text.split("\n");
  const kind = Math.floor(random() * 5);
  const at = Math.floor(random() * lines.length);
  if (kind === 0) {
    lines.splice(at, 0, "// test-select: comment-only edit");
  } else if (kind === 1) {
    lines.splice(at, 0, "", "");
  } else if (kind === 2) {
    const last = lines.findLastIndex((line) => /^import\s/.test(line));
    lines.splice(last + 1, 0, "type TestSelectBenchAlias = { readonly a: number };");
  } else if (kind === 3) {
    const last = lines.findLastIndex((line) => /^import\s/.test(line));
    lines.splice(
      last + 1,
      0,
      `import type * as TestSelectBenchSelf from "./${NodePath.basename(file)}";`,
    );
  } else {
    lines.push("export interface TestSelectBenchInterface {", "  readonly value: string;", "}");
  }
  const label =
    ["comment line", "blank lines", "type alias", "import type", "interface"][kind] ?? "comment";
  return makeCase({
    id: "type-only",
    category: "Comment, whitespace and type-only edits",
    description: `${label} added to ${file}${kind < 2 ? `:${at + 1}` : ""}`,
    edits: [{ op: "write", path: file, content: lines.join("\n") }],
    expectStanding: true,
  });
}

/** One generator per non-code row of DESIGN.md §14.4; each returns `null` when its anchor is missing. */
const TEMPLATES: ReadonlyArray<readonly [string, ReadonlyArray<Template>]> = [
  [
    "Fixture and data",
    [
      (random, context) => {
        const file = pick(random, readByUnits(context, /\/fixtures\/.*\.(ndjson|json|txt|md)$/));
        const text = file === undefined ? null : context.read(file);
        if (file === undefined || text === null) return null;
        const content = file.endsWith(".json")
          ? text.replace(/"([^"]{1,40})"/, '"$1_bench"')
          : `${text}${text.endsWith("\n") ? "" : "\n"}\n`;
        return single("fixture", "Fixture and data", `edit fixture ${file}`, {
          op: "write",
          path: file,
          content,
        });
      },
      (_random, context) =>
        single(
          "fixture-doc",
          "Fixture and data",
          "rename a heading in docs/user/t3-connect-troubleshooting.md",
          replaceIn(
            context,
            "docs/user/t3-connect-troubleshooting.md",
            /^## (.+)$/m,
            "## $1 (bench)",
          ),
        ),
      (_random, context) =>
        single(
          "fixture-raw",
          "Fixture and data",
          "bump native/libghostty-vt/VERSION (?raw import)",
          replaceIn(context, "native/libghostty-vt/VERSION", /\s*$/, "-bench\n"),
        ),
    ],
  ],
  [
    "Child-process files",
    [
      (random, context) => {
        const candidates = [
          "packages/effect-acp/test/fixtures/acp-mock-peer.ts",
          "apps/server/src/bin.ts",
          "infra/task-cache/scripts/install.ts",
          ".github/scripts/ci-changes.cjs",
        ].filter((file) => context.read(file) !== null);
        for (const file of shuffle(random, candidates)) {
          const text = context.read(file);
          const executed = executedByProjects(context.trace, null).get(file) ?? null;
          const mutation = text === null ? null : mutateScript(random, file, text, executed);
          if (mutation !== null) {
            return single(
              "child-process",
              "Child-process files",
              `${mutation.operator} in ${file}:${mutation.line}`,
              {
                op: "write",
                path: file,
                content: mutation.text,
              },
            );
          }
        }
        return null;
      },
    ],
  ],
  [
    "Config",
    [
      (_random, context) =>
        single(
          "config-timeout",
          "Config",
          "root vite.config.ts testTimeout 60s → 61s",
          replaceIn(context, "vite.config.ts", "testTimeout: 60_000", "testTimeout: 61_000"),
        ),
      (_random, context) =>
        single(
          "config-babel",
          "Config",
          "apps/mobile/babel.config.js: unstable_transformImportMeta false",
          replaceIn(
            context,
            "apps/mobile/babel.config.js",
            "unstable_transformImportMeta: true",
            "unstable_transformImportMeta: false",
          ),
        ),
      (_random, context) =>
        single(
          "config-shard-weights",
          "Config",
          "apps/server shardWeights.json: change one weight",
          replaceIn(
            context,
            "apps/server/src/testUtils/shardWeights.json",
            /: (\d+)(\.\d+)?/,
            ": 9$1$2",
          ),
        ),
      (_random, context) =>
        single(
          "config-desktop-timeout",
          "Config",
          "apps/desktop vite.config.ts testTimeout 15s → 16s",
          replaceIn(
            context,
            "apps/desktop/vite.config.ts",
            "testTimeout: 15_000",
            "testTimeout: 16_000",
          ),
        ),
    ],
  ],
  [
    "`include` patterns",
    [
      (random, context) => {
        const unit = pick(
          random,
          context.units.filter((candidate) => !candidate.project.endsWith("#browser")),
        );
        if (unit === undefined) return null;
        const path = unit.file.replace(/(\.test\.[cm]?[jt]sx?)$/, ".bench-added$1");
        return single("include-add", "`include` patterns", `add passing test file ${path}`, {
          op: "write",
          path,
          content:
            'import { expect, it } from "vitest";\n\nit("bench-added", () => {\n  expect(1).toBe(1);\n});\n',
        });
      },
      (random, context) => {
        const unit = pick(random, context.units);
        return unit === undefined
          ? null
          : single("include-delete", "`include` patterns", `delete test file ${unit.file}`, {
              op: "delete",
              path: unit.file,
            });
      },
      (_random, context) => {
        const text = context.read("apps/mobile/vite.config.ts");
        const first = text === null ? null : /const reactTests = \[\n\s+"([^"]+)",\n/.exec(text);
        if (text === null || first === null) return null;
        return single(
          "include-move",
          "`include` patterns",
          `move ${first[1]} out of mobile reactTests into unit`,
          {
            op: "write",
            path: "apps/mobile/vite.config.ts",
            content: text.replace(first[0], "const reactTests = [\n"),
          },
        );
      },
    ],
  ],
  [
    "`package.json`",
    [
      (_random, context) =>
        single(
          "manifest-version",
          "`package.json`",
          "apps/web/package.json version bump",
          replaceIn(
            context,
            "apps/web/package.json",
            /"version": "(\d+)\.(\d+)\.(\d+)"/,
            '"version": "$1.$2.99"',
          ),
        ),
      (_random, context) =>
        single(
          "manifest-description",
          "`package.json`",
          "packages/contracts/package.json: add a description field",
          replaceIn(
            context,
            "packages/contracts/package.json",
            /^\{\n/,
            '{\n  "description": "bench",\n',
          ),
          { expectStanding: true },
        ),
    ],
  ],
  [
    "tsconfig",
    [
      (random, context) => {
        const candidates = context.files.filter((file) =>
          /^(packages|apps)\/[^/]+\/tsconfig\.json$/.test(file),
        );
        const file = pick(random, candidates);
        return file === undefined
          ? null
          : single(
              "tsconfig-strictness",
              "tsconfig",
              `${file}: add noUnusedLocals`,
              replaceIn(
                context,
                file,
                /"compilerOptions": \{/,
                '"compilerOptions": {\n    "noUnusedLocals": true,',
              ),
              { expectStanding: true },
            );
      },
    ],
  ],
  [
    "Lockfile",
    [
      (_random, context) => {
        const file =
          ".repos/alchemy-effect/packages/integration-tests/test/AWS/Lambda/fixtures/lockfile-pinning/bun/bun.lock";
        return single(
          "lockfile-repos",
          "Lockfile",
          `edit ${file}`,
          replaceIn(context, file, /\s*$/, "\n\n"),
          { expectStanding: true },
        );
      },
    ],
  ],
  [
    "Env vars",
    [
      () =>
        makeCase({
          id: "env-mobile-platform",
          category: "Env vars",
          description: "T3_MOBILE_TEST_PLATFORM=android",
          edits: [],
          env: { set: { T3_MOBILE_TEST_PLATFORM: "android" }, unset: [] },
        }),
      () =>
        makeCase({
          id: "env-ci-unset",
          category: "Env vars",
          description: "CI unset",
          edits: [],
          env: { set: {}, unset: ["CI"] },
        }),
      () =>
        makeCase({
          id: "env-keep-provider",
          category: "Env vars",
          description: "T3CODE_TEST_KEEP_PROVIDER_ENV=1",
          edits: [],
          env: { set: { T3CODE_TEST_KEEP_PROVIDER_ENV: "1" }, unset: [] },
        }),
      () =>
        makeCase({
          id: "env-github-repository",
          category: "Env vars",
          description: "GITHUB_REPOSITORY=pingdotgg/t3code (web define)",
          edits: [],
          env: { set: { GITHUB_REPOSITORY: "pingdotgg/t3code" }, unset: [] },
        }),
      () =>
        makeCase({
          id: "env-unread",
          category: "Env vars",
          description: "a variable nothing reads",
          edits: [],
          env: { set: { TEST_SELECT_BENCH_UNREAD: "1" }, unset: [] },
          expectStanding: true,
        }),
    ],
  ],
  [
    "`.env` files",
    [
      () =>
        makeCase({
          id: "dotenv-http-url",
          category: "`.env` files",
          description: ".env.local with VITE_HTTP_URL",
          edits: [],
          ignored: [
            { op: "write", path: ".env.local", content: "VITE_HTTP_URL=http://127.0.0.1:3999\n" },
          ],
        }),
      () =>
        makeCase({
          id: "dotenv-unread",
          category: "`.env` files",
          description: ".env with a key nothing reads",
          edits: [],
          ignored: [{ op: "write", path: ".env", content: "TEST_SELECT_BENCH_UNREAD=1\n" }],
        }),
    ],
  ],
  [
    "Node version",
    [
      () =>
        makeCase({
          id: "node-24",
          category: "Node version",
          description: `Node ${DEFAULT_NODE} → 24.21.0`,
          edits: [],
          node: "24.21.0",
        }),
      () =>
        makeCase({
          id: "node-22",
          category: "Node version",
          description: `Node ${DEFAULT_NODE} → 22.23.4`,
          edits: [],
          node: "22.23.4",
        }),
    ],
  ],
  [
    "Git-ignored inputs",
    [
      (random, context) => {
        const listed = new Set<string>();
        for (const observed of Object.values(context.trace.units)) {
          for (const dir of observed.listed)
            if (
              !dir.startsWith("pnpm:") &&
              !dir.includes("node_modules") &&
              context.files.some((file) => file.startsWith(`${dir}/`))
            )
              listed.add(dir);
        }
        for (const dir of shuffle(random, [...listed])) {
          for (const name of ["bench.log", ".env", "dist"]) {
            const path = `${dir}/${name}`;
            if (context.isIgnored(path)) {
              return makeCase({
                id: "ignored-listed",
                category: "Git-ignored inputs",
                description: `ignored ${path} in a directory a unit lists`,
                edits: [],
                ignored: [
                  {
                    op: "write",
                    path: name === "dist" ? `${path}/bench.txt` : path,
                    content: "bench\n",
                  },
                ],
              });
            }
          }
        }
        return null;
      },
      () =>
        makeCase({
          id: "ignored-unread",
          category: "Git-ignored inputs",
          description: "ignored file nothing reads",
          edits: [],
          ignored: [{ op: "write", path: ".logs/test-select-bench.log", content: "bench\n" }],
          expectStanding: true,
        }),
    ],
  ],
  [
    "Resolution edge cases",
    [
      (random, context) => {
        const executed = executedByProjects(context.trace, null);
        const file = pick(
          random,
          [...executed.keys()].filter(
            (path) => /\.ts$/.test(path) && !isTestFile(path) && context.tracked.has(path),
          ),
        );
        const text = file === undefined ? null : context.read(file);
        if (file === undefined || text === null || text.includes("\r\n")) return null;
        return single(
          "resolution-crlf",
          "Resolution edge cases",
          `CRLF-only edit of ${file}`,
          { op: "write", path: file, content: text.replaceAll("\n", "\r\n") },
          { expectStanding: true },
        );
      },
      (random, context) => {
        const executed = executedByProjects(context.trace, null);
        const file = pick(
          random,
          [...executed.keys()].filter(
            (path) => /\.ts$/.test(path) && !isTestFile(path) && context.tracked.has(path),
          ),
        );
        if (file === undefined) return null;
        const sibling = file.replace(/\.ts$/, ".js");
        if (context.tracked.has(sibling)) return null;
        return single(
          "resolution-js-sibling",
          "Resolution edge cases",
          `add ${sibling} beside ${file}`,
          {
            op: "write",
            path: sibling,
            content: 'throw new Error("test-select bench: .js sibling loaded");\n',
          },
        );
      },
    ],
  ],
  [
    "Tailwind",
    [
      (_random, context) =>
        single(
          "tailwind-css",
          "Tailwind",
          "apps/web/src/index.css: add a rule",
          replaceIn(
            context,
            "apps/web/src/index.css",
            /\s*$/,
            "\n\n.test-select-bench {\n  color: red;\n}\n",
          ),
        ),
    ],
  ],
  [
    "Selector self-change",
    [
      () =>
        makeCase({
          id: "selector-self",
          category: "Selector self-change",
          description: "add a file under packages/test-select/src",
          edits: [
            {
              op: "write",
              path: "packages/test-select/src/bench-self-change.ts",
              content: "export const benchSelfChange = 1;\n",
            },
          ],
        }),
    ],
  ],
];

export const NOOP_CASE: Case = makeCase({
  id: "noop",
  category: "No-op",
  description: "head = base",
  edits: [],
});

/**
 * The seed's cases: one mutation per test project (covered source, test file, or an uncovered
 * location), one case per non-code category, more mutations until there are `minimum`, and the
 * no-op case.
 */
export function generateCases(
  seed: number,
  context: GenerationContext,
  minimum: number,
): ReadonlyArray<Case> {
  const random = seededRandom(seed);
  const cases: Array<Case> = [];
  let index = 0;
  const projects = shuffle(random, context.projects);
  for (const project of projects) {
    const found = mutationCase(random, context, project, index++);
    if (found !== null) cases.push(found);
  }
  const executed = executedByProjects(context.trace, null);
  for (const [, templates] of TEMPLATES) {
    for (const template of shuffle(random, templates)) {
      const found = template(random, context);
      if (found !== null) {
        cases.push(found);
        break;
      }
    }
  }
  const typeOnly = commentEdit(random, context, executed);
  if (typeOnly !== null) cases.push(typeOnly);
  let rounds = 0;
  while (cases.length + 1 < minimum && projects.length > 0 && rounds < minimum * 4) {
    const project = projects[rounds % projects.length] as string;
    const found = mutationCase(random, context, project, index++);
    if (found !== null) cases.push(found);
    rounds++;
  }
  cases.push(NOOP_CASE);
  return cases.map((entry) =>
    entry.id === "noop" ? entry : { ...entry, id: `s${seed}-${entry.id}` },
  );
}
