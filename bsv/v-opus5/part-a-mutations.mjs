// Part A (see README.md): per mutation and per project that can import the file, select mode from
// the seeded record, then BSV_MODE=all as ground truth. Browser files have no record and always
// run, so a select run's browser results double as their ground truth.
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { LOGS, REPO, git, restoreDir, rng, saveDir, vitestRun } from "./lib.mjs";

const SEED = 5150517;
const RECORD_DIR = "node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709";
const FS_CACHE = NodePath.join(LOGS, "partA-fscache");
const STATE = NodePath.join(LOGS, "partA");
const RESULTS = NodePath.join(import.meta.dirname, "results");
const PLAN = NodePath.join(RESULTS, "part-a-plan.json");
const OUT = NodePath.join(RESULTS, "part-a.json");

const PROJECTS = {
  web: {
    dir: "apps/web",
    // Browser tests time out at load averages of 40-70 on the shared host; a mutation's failure
    // is deterministic and fails every retry, a timing flake does not.
    select: [
      "--passWithNoTests",
      "--testTimeout=60000",
      "--retry=2",
      "--project",
      "unit",
      "--project",
      "browser",
    ],
    all: ["--passWithNoTests", "--testTimeout=60000", "--retry=2", "--project", "unit"],
    browserGlob: /\.browser\.test\.tsx?$/,
  },
  // Unit project alone, with its own seeded record. Browser files have no dependency record and
  // always run, so most mutations measure web through this to keep each run to minutes.
  "web-unit": {
    dir: "apps/web",
    select: ["--passWithNoTests", "--testTimeout=60000", "--retry=2", "--project", "unit"],
    all: ["--passWithNoTests", "--testTimeout=60000", "--retry=2", "--project", "unit"],
  },
  "client-runtime": { dir: "packages/client-runtime", select: [], all: [] },
  shared: {
    dir: "packages/shared",
    select: ["--config", "../../vite.config.ts", "--dir", "."],
    all: null,
  },
  contracts: {
    dir: "packages/contracts",
    select: ["--config", "../../vite.config.ts", "--dir", "."],
    all: null,
  },
};
for (const p of Object.values(PROJECTS)) p.all ??= p.select;

const parser = NodeModule.createRequire(import.meta.url)(
  NodePath.join(REPO, "node_modules/.pnpm/oxc-parser@0.148.0/node_modules/oxc-parser"),
);

const readJson = (f, fallback) =>
  NodeFS.existsSync(f) ? JSON.parse(NodeFS.readFileSync(f, "utf8")) : fallback;
const writeJson = (f, v) => NodeFS.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const recordDir = (proj) => NodePath.join(REPO, PROJECTS[proj].dir, RECORD_DIR);
const seedDir = (proj) => NodePath.join(STATE, "seed", proj);
const isTest = (f) => /\.(test|spec)\.tsx?$/.test(f);

// In-scope projects whose tests can import `file`; packages never import apps/web.
function reach(file, kind) {
  const owner = Object.keys(PROJECTS).find((p) => file.startsWith(`${PROJECTS[p].dir}/`));
  if (kind === "test") return [owner];
  if (file.startsWith("native/")) return ["web"];
  if (owner === "web") return ["web"];
  if (owner === "client-runtime") return ["client-runtime", "web"];
  return ["contracts", "shared", "client-runtime", "web"];
}

function selectRun(proj, label) {
  const p = PROJECTS[proj];
  return vitestRun({
    dir: p.dir,
    args: [...p.select, "--fsModuleCachePath", FS_CACHE],
    mode: "select",
    label,
  });
}

function allRun(proj, label) {
  const p = PROJECTS[proj];
  return vitestRun({
    dir: p.dir,
    args: [...p.all, "--fsModuleCachePath", FS_CACHE],
    mode: "all",
    label,
  });
}

function summarize(run) {
  return {
    status: run.status,
    seconds: run.seconds,
    selection: run.selection,
    blacksmith: run.blacksmith,
    unhandled: run.unhandled,
    ran: Object.keys(run.files).toSorted(),
    failed: Object.entries(run.files)
      .filter(([, s]) => s === "failed")
      .map(([f]) => f)
      .toSorted(),
  };
}

function assertClean() {
  const dirty = git("status", "--porcelain", "--untracked-files=no", "--", ".", ":!bsv").trim();
  if (dirty) throw new Error(`tracked files are modified; restore them first:\n${dirty}`);
}

function seed() {
  assertClean();
  const out = readJson(OUT, {});
  out.seed ??= { projects: {} };
  Object.assign(out.seed, { node: process.version, commit: git("rev-parse", "HEAD").trim() });
  const only = process.env.ONLY_PROJECTS?.split(",");
  for (const proj of Object.keys(PROJECTS)) {
    if (only && !only.includes(proj)) continue;
    let run;
    for (let attempt = 1; attempt <= 3; attempt++) {
      NodeFS.rmSync(recordDir(proj), { recursive: true, force: true });
      run = summarize(selectRun(proj, `seed-${proj}-a${attempt}`));
      run.attempt = attempt;
      console.log("seed", proj, attempt, run.status, run.selection, run.failed);
      if (
        run.status === 0 &&
        NodeFS.readdirSync(recordDir(proj)).some((f) => f.startsWith("blacksmith"))
      )
        break;
    }
    if (run.status !== 0) throw new Error(`seed for ${proj} never passed`);
    saveDir(recordDir(proj), seedDir(proj));
    // No-op control: unchanged tree, seeded record.
    const control = summarize(selectRun(proj, `control-${proj}`));
    restoreDir(seedDir(proj), recordDir(proj));
    console.log("control", proj, control.selection, control.blacksmith.at(-1));
    out.seed.projects[proj] = { seed: { ...run, ran: run.ran.length }, control };
    writeJson(OUT, out);
  }
}

function recordedImporters() {
  const counts = new Map();
  const webCounts = new Map();
  for (const proj of ["web", "client-runtime", "shared", "contracts"]) {
    const records = readJson(NodePath.join(seedDir(proj), "dependencies.json"), null);
    if (!records) throw new Error(`no seeded record for ${proj}`);
    const root = NodePath.join(REPO, PROJECTS[proj].dir);
    for (const project of Object.values(records.projects ?? {})) {
      for (const record of Object.values(project.files)) {
        for (const index of record.deps) {
          const rel = NodePath.relative(REPO, NodePath.resolve(root, project.modules[index] ?? ""));
          counts.set(rel, (counts.get(rel) ?? 0) + 1);
          if (proj === "web") webCounts.set(rel, (webCounts.get(rel) ?? 0) + 1);
        }
      }
    }
  }
  return { counts, webCounts };
}

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("~/")) base = NodePath.join("apps/web/src", spec.slice(2));
  else if (spec.startsWith(".")) base = NodePath.join(NodePath.dirname(fromFile), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (
      NodeFS.existsSync(NodePath.join(REPO, c)) &&
      NodeFS.statSync(NodePath.join(REPO, c)).isFile()
    )
      return c;
  }
  return null;
}

function weightedPick(random, items, count) {
  const pool = [...items];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((a, [, w]) => a + w, 0);
    let r = random() * total;
    const i = pool.findIndex(([, w]) => (r -= w) < 0);
    picked.push(pool.splice(i === -1 ? pool.length - 1 : i, 1)[0][0]);
  }
  return picked;
}

function uniformPick(random, items, count) {
  const pool = [...items];
  const picked = [];
  while (picked.length < count && pool.length > 0)
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return picked;
}

const DATA_POOL = [
  "apps/web/src/test-fixtures.ts",
  "packages/client-runtime/src/state/orchestrationV2TestFixtures.ts",
  "native/libghostty-vt/include/ghostty/vt/key/event.h",
  "native/libghostty-vt/VERSION",
  "apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm",
  "apps/web/src/terminal/ghostty/vendor/ghostty-write-pty.wasm",
];

function pick() {
  const random = rng(SEED);
  const tracked = git("ls-files", ...Object.values(PROJECTS).map((p) => p.dir))
    .trim()
    .split("\n");
  const source = tracked.filter(
    (f) =>
      /\/src\/.*\.tsx?$/.test(f) &&
      !isTest(f) &&
      !f.endsWith(".d.ts") &&
      !/\.(bench|stories)\.tsx?$/.test(f) &&
      !DATA_POOL.includes(f) &&
      !/\/(test|tests|__tests__|__mocks__)\//.test(f),
  );
  const tests = tracked.filter((f) => isTest(f) && /\/src\//.test(f));
  const { counts, webCounts } = recordedImporters();

  const weighted = weightedPick(
    random,
    source.filter((f) => counts.has(f)).map((f) => [f, counts.get(f)]),
    24,
  );
  const browserImports = new Set();
  for (const t of tests.filter((f) => PROJECTS.web.browserGlob.test(f))) {
    const code = NodeFS.readFileSync(NodePath.join(REPO, t), "utf8");
    for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
      const r = resolveImport(t, m[1]);
      // src/reactCompilerCoverage.test.ts loads almost every web module, so "only browser tests
      // exercise it" means no web unit test records it besides that one.
      if (r && source.includes(r) && (webCounts.get(r) ?? 0) <= 1) browserImports.add(r);
    }
  }
  const browserOnly = uniformPick(
    random,
    [...browserImports].filter((f) => !weighted.includes(f)).toSorted(),
    6,
  );
  const leaves = uniformPick(
    random,
    source.filter((f) => !weighted.includes(f) && !browserOnly.includes(f)),
    10,
  );
  const testEdits = uniformPick(random, tests, 10);
  const data = uniformPick(random, DATA_POOL, 5);

  const plan = [
    ...weighted.map((file) => ({ stratum: "weighted", file })),
    ...browserOnly.map((file) => ({ stratum: "browser-only", file })),
    ...leaves.map((file) => ({ stratum: "leaf", file })),
    ...testEdits.map((file) => ({ stratum: "test", file })),
    ...data.map((file) => ({ stratum: "data", file })),
  ].map((m, i) => {
    const kind = m.stratum === "test" ? "test" : m.stratum === "data" ? "data" : "source";
    return {
      id: `m${String(i + 1).padStart(2, "0")}`,
      ...m,
      kind,
      recordedImporters: counts.get(m.file) ?? 0,
      projects: reach(m.file, kind),
      mutation: mutationFor(m.file, kind, rng(SEED + i)),
    };
  });
  writeJson(PLAN, {
    seed: SEED,
    commit: git("rev-parse", "HEAD").trim(),
    pools: {
      source: source.length,
      recordedSource: source.filter((f) => counts.has(f)).length,
      browserOnly: browserImports.size,
      tests: tests.length,
      data: DATA_POOL.length,
    },
    mutations: plan,
  });
  console.log(
    plan.map((m) => `${m.id} ${m.stratum} ${m.file} [${m.projects}] ${m.mutation.op}`).join("\n"),
  );
}

function walk(node, cb, parent = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, cb, parent);
    return;
  }
  if (typeof node.type === "string") cb(node, parent);
  for (const key of Object.keys(node)) {
    if (key !== "parent" && key !== "type")
      walk(node[key], cb, typeof node.type === "string" ? node : parent);
  }
}

const FLIP = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": ">=",
  ">": "<=",
  "<=": ">",
  ">=": "<",
  "&&": "||",
  "||": "&&",
};

function parses(file, code) {
  return parser.parseSync(NodePath.basename(file), code).errors.length === 0;
}

// Priority: replace a return value, flip a comparison or logical operator, flip a boolean,
// change a string literal, else throw at module end. Picks a random site of the first kind present.
function sourceMutation(file, code, random) {
  const { program } = parser.parseSync(NodePath.basename(file), code);
  const sites = { return: [], operator: [], boolean: [], string: [] };
  walk(program, (n, parent) => {
    if (n.type === "ReturnStatement" && n.argument) sites.return.push(n);
    else if ((n.type === "BinaryExpression" || n.type === "LogicalExpression") && FLIP[n.operator])
      sites.operator.push(n);
    else if (n.type === "Literal" && typeof n.value === "boolean") sites.boolean.push(n);
    else if (
      n.type === "Literal" &&
      typeof n.value === "string" &&
      n.value.length > 0 &&
      ![
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
        "TSLiteralType",
        "TSExternalModuleReference",
        "ExpressionStatement",
      ].includes(parent?.type) &&
      !(parent?.type === "Property" && parent.key === n)
    )
      sites.string.push(n);
  });
  for (const op of ["return", "operator", "boolean", "string"]) {
    const candidates = sites[op];
    while (candidates.length > 0) {
      const n = candidates.splice(Math.floor(random() * candidates.length), 1)[0];
      let replacement;
      if (op === "return") replacement = "return undefined as never;";
      else if (op === "operator") {
        const left = code.slice(n.left.start, n.left.end);
        const right = code.slice(n.right.start, n.right.end);
        const between = code.slice(n.left.end, n.right.start).replace(n.operator, FLIP[n.operator]);
        replacement = `${left}${between}${right}`;
      } else if (op === "boolean") replacement = String(!n.value);
      else replacement = JSON.stringify(`${n.value}_bsv`);
      const mutated = code.slice(0, n.start) + replacement + code.slice(n.end);
      if (parses(file, mutated)) {
        return {
          op,
          start: n.start,
          end: n.end,
          before: code.slice(n.start, n.end).slice(0, 160),
          after: replacement.slice(0, 160),
        };
      }
    }
  }
  return {
    op: "throw",
    start: code.length,
    end: code.length,
    before: "",
    after: '\nthrow new Error("bsv-mutation");\n',
  };
}

const TEST_CALLEES = /^(it|test)(\.(effect|live|scoped|scopedLive|concurrent|each\(.*\)))?$/s;

// A failing statement at the top of the first test body.
function testMutation(file, code) {
  const { program } = parser.parseSync(NodePath.basename(file), code);
  let site = null;
  walk(program, (n) => {
    if (site || n.type !== "CallExpression") return;
    const callee = code.slice(n.callee.start, n.callee.end);
    if (!TEST_CALLEES.test(callee)) return;
    const fn = n.arguments.find(
      (a) =>
        (a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression") &&
        a.body.type === "BlockStatement",
    );
    if (fn) site = fn.body.start + 1;
  });
  if (site === null) throw new Error(`no test body in ${file}`);
  return {
    op: "test-throw",
    start: site,
    end: site,
    before: "",
    after: ' throw new Error("bsv-mutation");',
  };
}

function mutationFor(file, kind, random) {
  const abs = NodePath.join(REPO, file);
  if (file.endsWith(".wasm")) {
    const size = NodeFS.statSync(abs).size;
    return { op: "byte-flip", offset: Math.floor(size / 2) };
  }
  const code = NodeFS.readFileSync(abs, "utf8");
  if (/\.tsx?$/.test(file))
    return kind === "test" ? testMutation(file, code) : sourceMutation(file, code, random);
  if (file.endsWith("VERSION"))
    return {
      op: "version",
      start: 0,
      end: code.trimEnd().length,
      before: code.trimEnd(),
      after: `${code.trimEnd()}.1`,
    };
  // Header: change the first numeric enum value.
  const m = /=\s*(\d+)/.exec(code);
  const start = m.index + m[0].indexOf(m[1]);
  return {
    op: "number",
    start,
    end: start + m[1].length,
    before: m[1],
    after: String(Number(m[1]) + 1000),
  };
}

function apply(m) {
  const abs = NodePath.join(REPO, m.file);
  const original = NodeFS.readFileSync(abs);
  if (m.mutation.op === "byte-flip") {
    const copy = Buffer.from(original);
    copy[m.mutation.offset] ^= 0xff;
    NodeFS.writeFileSync(abs, copy);
  } else {
    const code = original.toString("utf8");
    if (code.slice(m.mutation.start, m.mutation.end).slice(0, 160) !== m.mutation.before) {
      throw new Error(`${m.id}: ${m.file} no longer matches the plan`);
    }
    NodeFS.writeFileSync(
      abs,
      code.slice(0, m.mutation.start) + m.mutation.after + code.slice(m.mutation.end),
    );
  }
  return () => NodeFS.writeFileSync(abs, original);
}

function runOne(m) {
  const record = {
    id: m.id,
    file: m.file,
    stratum: m.stratum,
    kind: m.kind,
    mutation: m.mutation,
    node: process.version,
    seedGeneration: Number(process.env.SEED_GENERATION ?? 1),
    projects: {},
  };
  // The CI command (unit + browser) for browser-only components and browser test edits.
  const fullWeb = m.stratum === "browser-only" || PROJECTS.web.browserGlob.test(m.file);
  const projects = m.projects.map((p) => (p === "web" && !fullWeb ? "web-unit" : p));
  const revert = apply(m);
  const onSignal = (signal) => {
    revert();
    console.error(`${m.id}: reverted ${m.file} on ${signal}`);
    process.exit(1);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    // The transform cache is keyed by file content; no mutation touches package.json.
    for (const proj of projects) {
      restoreDir(seedDir(proj), recordDir(proj));
      const sel = summarize(selectRun(proj, `${m.id}-${proj}-select`));
      restoreDir(seedDir(proj), recordDir(proj));
      const all = summarize(allRun(proj, `${m.id}-${proj}-all`));
      let truthFailed = all.failed;
      let browser = null;
      if (PROJECTS[proj].browserGlob) {
        const browserRan = sel.ran.filter((f) => PROJECTS.web.browserGlob.test(f));
        browser = {
          ran: browserRan.length,
          failed: sel.failed.filter((f) => PROJECTS.web.browserGlob.test(f)),
        };
        truthFailed = [...new Set([...all.failed, ...browser.failed])].toSorted();
      }
      const selected = new Set(sel.ran);
      record.projects[proj] = {
        select: sel,
        all: {
          status: all.status,
          seconds: all.seconds,
          ran: all.ran.length,
          failed: all.failed,
          blacksmith: all.blacksmith,
        },
        browser,
        truthFailed,
        falseNegatives: truthFailed.filter((f) => !selected.has(f)),
      };
      console.log(
        m.id,
        proj,
        "selected",
        sel.ran.length,
        "truthFailed",
        truthFailed.length,
        "FN",
        record.projects[proj].falseNegatives,
      );
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    revert();
    for (const proj of projects) restoreDir(seedDir(proj), recordDir(proj));
  }
  return record;
}

function run() {
  assertClean();
  const plan = readJson(PLAN, null).mutations;
  const out = readJson(OUT, {});
  out.mutations ??= {};
  const only = process.env.ONLY?.split(",");
  for (const m of plan) {
    if (only ? !only.includes(m.id) : out.mutations[m.id]) continue;
    out.mutations[m.id] = runOne(m);
    writeJson(OUT, out);
    assertClean();
  }
}

// Off-mode run of specific test files, so neither the record nor selection is involved.
function offRun(proj, files, label) {
  const p = PROJECTS[proj];
  const rel = files.map((f) => NodePath.relative(p.dir, f));
  const projectArgs = p.select.filter((a) => a !== "--passWithNoTests");
  return summarize(
    vitestRun({
      dir: p.dir,
      args: [...projectArgs, "--fsModuleCachePath", FS_CACHE, ...rel],
      mode: "off",
      label,
    }),
  );
}

function verify() {
  assertClean();
  const plan = Object.fromEntries(readJson(PLAN, null).mutations.map((m) => [m.id, m]));
  const out = readJson(OUT, {});
  // Every failure on a clean tree, batched per project: failures there are not the mutation's.
  const failing = {};
  for (const r of Object.values(out.mutations)) {
    for (const [proj, p] of Object.entries(r.projects))
      for (const f of p.truthFailed) (failing[proj] ??= new Set()).add(f);
  }
  out.cleanTree = {};
  for (const [proj, files] of Object.entries(failing)) {
    const res = offRun(proj, [...files], `verify-clean-${proj}`);
    out.cleanTree[proj] = {
      checked: files.size,
      failedOnClean: res.failed,
      missing: [...files].filter((f) => !res.ran.includes(f)),
    };
    console.log("clean", proj, files.size, "failed on clean:", res.failed);
  }
  // Each unselected failure again on its mutated tree, alone.
  for (const r of Object.values(out.mutations)) {
    for (const [proj, p] of Object.entries(r.projects)) {
      if (p.falseNegatives.length === 0) continue;
      const revert = apply(plan[r.id]);
      try {
        const res = offRun(proj, p.falseNegatives, `verify-${r.id}-${proj}`);
        p.falseNegativeRecheck = { failedAgain: res.failed };
      } finally {
        revert();
      }
      console.log(
        "recheck",
        r.id,
        proj,
        p.falseNegatives,
        "->",
        p.falseNegativeRecheck.failedAgain,
      );
    }
  }
  writeJson(OUT, out);
}

// Second pass: source files whose semantic mutation no test failed get a throw at module end,
// which fails every test that evaluates the module, the widest probe of its dependents.
function planThrow() {
  const planFile = readJson(PLAN, null);
  const out = readJson(OUT, {});
  for (const m of planFile.mutations.filter((x) => x.kind === "source" && !x.id.endsWith("t"))) {
    const r = out.mutations?.[m.id];
    if (!r || Object.values(r.projects).some((p) => p.truthFailed.length > 0)) continue;
    if (planFile.mutations.some((x) => x.id === `${m.id}t`)) continue;
    const length = NodeFS.readFileSync(NodePath.join(REPO, m.file), "utf8").length;
    planFile.mutations.push({
      ...m,
      id: `${m.id}t`,
      stratum: `${m.stratum}+throw`,
      mutation: {
        op: "throw",
        start: length,
        end: length,
        before: "",
        after: '\nthrow new Error("bsv-mutation");\n',
      },
    });
  }
  writeJson(PLAN, planFile);
  console.log(
    planFile.mutations
      .filter((x) => x.id.endsWith("t"))
      .map((x) => x.id)
      .join(" "),
  );
}

const command = process.argv[2];
const commands = { seed, pick, run, verify, "plan-throw": planThrow };
if (!commands[command]) {
  console.error(`usage: part-a-mutations.mjs ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
commands[command]();
