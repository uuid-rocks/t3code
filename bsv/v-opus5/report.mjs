// Renders results/part-a.json, part-a-plan.json, part-b.json and notes.json into results/report.md.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const R = NodePath.join(import.meta.dirname, "results");
const read = (f, d = null) =>
  NodeFS.existsSync(NodePath.join(R, f))
    ? JSON.parse(NodeFS.readFileSync(NodePath.join(R, f), "utf8"))
    : d;
const a = read("part-a.json", {});
const plan = read("part-a-plan.json", { mutations: [] });
const b = read("part-b.json", {});
const notes = read("notes.json", {});
const lines = [];
const out = (s = "") => lines.push(s);
const short = (f) => f.replace(/^apps\/web\/src\//, "web/").replace(/^packages\//, "");

out("# @useblacksmith/vitest 0.4.0: mutation campaign (opus5)");
out();
out(
  `Commit under test: \`${a.seed?.commit ?? plan.commit}\`. Node ${a.seed?.node ?? "?"}. Part A seed ${plan.seed}, part B seed ${b.seed ?? "?"}.`,
);
out(
  "Scripts: `bsv/v-opus5/part-a-mutations.mjs`, `bsv/v-opus5/part-b-shards.mjs`. Raw data: `part-a.json`, `part-a-plan.json`, `part-b.json`.",
);
out();

out("## Part A: single-file mutations");
out();
out("### Seed and no-op control");
out();
out("| project | seed run (s) | seed files | control selected/total | control (s) | control log |");
out("|---|---|---|---|---|---|");
for (const [proj, s] of Object.entries(a.seed?.projects ?? {})) {
  const c = s.control;
  const sel = c.selection.map((x) => `${x.selected}/${x.total}`).join(", ");
  out(
    `| ${proj} | ${s.seed.seconds.toFixed(0)} | ${s.seed.ran} | ${sel} | ${c.seconds.toFixed(0)} | ${(c.blacksmith.at(-1) ?? "").replace(/\|/g, "\\|")} |`,
  );
}
out();

const muts = plan.mutations
  .map((m) => ({ plan: m, res: a.mutations?.[m.id] }))
  .filter((x) => x.res);
const flakyOnClean = new Set(Object.values(a.cleanTree ?? {}).flatMap((c) => c.failedOnClean));
const perProject = {};
const totals = {
  mutations: muts.length,
  truth: 0,
  truthSelected: 0,
  fn: 0,
  fnConfirmed: 0,
  selected: 0,
  overSelected: 0,
  flakyExcluded: 0,
  killed: 0,
};
const fnRows = [];
const rows = [];
for (const { plan: m, res } of muts) {
  let sel = 0;
  let truth = 0;
  let fn = 0;
  for (const [proj, p] of Object.entries(res.projects)) {
    const truthFailed = p.truthFailed.filter((f) => !flakyOnClean.has(f));
    totals.flakyExcluded += p.truthFailed.length - truthFailed.length;
    const selected = new Set(p.select.ran);
    const s = p.select.selection[0] ?? { selected: p.select.ran.length, total: NaN };
    const pp = (perProject[proj] ??= {
      runs: 0,
      ratio: 0,
      selected: 0,
      total: 0,
      browserRan: 0,
      unitSelected: 0,
      unitTotal: 0,
      seconds: 0,
    });
    pp.runs++;
    pp.ratio += s.selected / s.total;
    pp.selected += s.selected;
    pp.total += s.total;
    pp.seconds += p.select.seconds;
    if (p.browser) pp.browserRan += p.browser.ran;
    sel += selected.size;
    truth += truthFailed.length;
    totals.truth += truthFailed.length;
    totals.selected += selected.size;
    totals.overSelected += [...selected].filter((f) => !truthFailed.includes(f)).length;
    const fns = truthFailed.filter((f) => !selected.has(f));
    totals.truthSelected += truthFailed.length - fns.length;
    fn += fns.length;
    totals.fn += fns.length;
    for (const f of fns) {
      const again = p.falseNegativeRecheck?.failedAgain?.includes(f);
      if (again) totals.fnConfirmed++;
      fnRows.push({
        id: m.id,
        proj,
        file: f,
        again,
        mutated: m.file,
        log: p.select.blacksmith.at(-1),
      });
    }
  }
  if (truth > 0) totals.killed++;
  rows.push(
    `| ${m.id} | ${m.stratum} | \`${short(m.file)}\` | ${m.mutation.op} | ${Object.keys(res.projects).join(", ")} | ${sel} | ${truth} | ${fn} |`,
  );
}

out("### Totals");
out();
out(
  `- Mutations run: ${totals.mutations} (${muts.filter((x) => x.plan.kind === "source").length} source, ${muts.filter((x) => x.plan.kind === "test").length} test-file, ${muts.filter((x) => x.plan.kind === "data").length} fixture/data). Mutations with at least one ground-truth failure: ${totals.killed}.`,
);
out(
  `- Ground-truth failing test files (summed over mutation x project): ${totals.truth}${totals.flakyExcluded ? ` (after excluding ${totals.flakyExcluded} that also failed on a clean tree)` : ""}.`,
);
out(
  `- Of those, selected by select mode: ${totals.truthSelected}. False negatives: ${totals.fn} (${totals.fnConfirmed} reproduced in an isolated rerun on the mutated tree).`,
);
out(
  `- Test files run by select mode (summed): ${totals.selected}; over-selected (ran, did not fail): ${totals.overSelected}.`,
);
out();
out("### Selection per project (select runs only)");
out();
out(
  "| project | select runs | mean selected/total | summed selected / summed total | browser files run (summed) | mean select-run seconds |",
);
out("|---|---|---|---|---|---|");
for (const [proj, p] of Object.entries(perProject)) {
  out(
    `| ${proj} | ${p.runs} | ${((100 * p.ratio) / p.runs).toFixed(1)}% | ${p.selected} / ${p.total} | ${p.browserRan || "-"} | ${(p.seconds / p.runs).toFixed(0)} |`,
  );
}
out();
if (notes.browserCost) out(`${notes.browserCost}\n`);

out("### False negatives");
out();
if (fnRows.length === 0) out("None.");
else {
  out(
    "| mutation | project | failing test not selected | reproduced alone | blacksmith log | root cause |",
  );
  out("|---|---|---|---|---|---|");
  for (const r of fnRows)
    out(
      `| ${r.id} (\`${short(r.mutated)}\`) | ${r.proj} | \`${short(r.file)}\` | ${r.again ? "yes" : "no"} | ${(r.log ?? "").replace(/\|/g, "\\|")} | ${notes.fn?.[`${r.id}:${r.file}`] ?? ""} |`,
    );
}
out();
if (Object.keys(a.cleanTree ?? {}).length) {
  out("### Clean-tree recheck of every ground-truth failure");
  out();
  for (const [proj, c] of Object.entries(a.cleanTree))
    out(
      `- ${proj}: ${c.checked} files rechecked, failed on clean tree: ${c.failedOnClean.length ? c.failedOnClean.map((f) => `\`${short(f)}\``).join(", ") : "none"}`,
    );
  out();
}
out("### Every mutation");
out();
out("| id | stratum | file | operator | projects run | selected | truth failing | FN |");
out("|---|---|---|---|---|---|---|---|");
for (const r of rows) out(r);
out();
if (notes.partA) out(`${notes.partA}\n`);

out("## Part B: apps/server shards (8)");
out();
if (b.sim) {
  const s = b.sim;
  out(`Node ${b.node ?? "?"}. ${s.files} server test files.`);
  if (s.seedRunsMatch)
    out(
      `Seed runs: ${s.seedRunsMatch.files} files ran across 8 shards; ${s.seedRunsMatch.weighted} sit in the shard WeightedShardSequencer assigns, ${s.seedRunsMatch.hash} in the shard HashShardSequencer would assign.`,
    );
  out();
  const phase = (name, runs) => {
    if (!runs) return;
    out(`**${name}**`);
    out();
    out("| shard | selected/total | seconds | log |");
    out("|---|---|---|---|");
    let sum = 0;
    for (const [i, r] of Object.entries(runs)) {
      const sel = r.selection[0];
      sum += sel?.selected ?? 0;
      out(
        `| ${i} | ${sel ? `${sel.selected}/${sel.total}` : "?"} | ${r.seconds.toFixed(0)} | ${(r.blacksmith.at(-1) ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
    out(`| sum | ${sum} | | |`);
    out();
  };
  if (b.seedRuns) phase("Seed (no record)", b.seedRuns);
  phase("No-op control", b.control);
  if (b.newFile) {
    phase(`New test file \`${b.newFile.file}\``, b.newFile.runs);
    out(
      `Simulated moves for this file: ${s.newFile.weightedMoves} existing files change shard (HashShardSequencer: 0).`,
    );
    out();
  }
  if (b.weight) {
    phase(
      `Weight change \`${b.weight.change.key}\` ${b.weight.change.before} -> ${b.weight.change.after}`,
      b.weight.runs,
    );
    out(`Simulated moves for this change: ${s.weight?.weightedMoves}.`);
    out();
  }
  const d = (x) =>
    `min ${x.min}, median ${x.p50}, p90 ${x.p90}, max ${x.max}, mean ${x.mean.toFixed(0)} (n=${x.n})`;
  out(
    `Simulation over every weighted file scaled by 1.5: files moved ${d(s.everyWeightTimes1_5)}.`,
  );
  out(
    `Simulation of one new unweighted file per directory (names aaa/zzz): files moved ${d(s.newUnweightedFilePerDir)}.`,
  );
  out();
}
if (notes.partB) out(`${notes.partB}\n`);

NodeFS.writeFileSync(NodePath.join(R, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
