import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly project: string | null;
  readonly description: string;
  readonly expectStanding: boolean;
  readonly head: string | null;
  /** Units at head. */
  readonly units: number;
  /** Ground truth: units whose outcome changed (E0). */
  readonly changed: ReadonlyArray<string>;
  readonly caseFlaky: ReadonlyArray<string>;
  readonly bisected: ReadonlyArray<string>;
  readonly selected: number;
  readonly selectedAll: boolean;
  /** Selected units that do not exist at head. */
  readonly unknownSelected: ReadonlyArray<string>;
  /** Changed but not selected. */
  readonly misses: ReadonlyArray<string>;
  /** Selected but not justified by any evidence. */
  readonly extras: ReadonlyArray<{ readonly unit: string; readonly selectorReason: string | null }>;
  /** Extras that are not Standing. */
  over: ReadonlyArray<{ readonly unit: string; readonly selectorReason: string | null }>;
  /** Selected units with their first evidence. */
  readonly justified: Readonly<Record<string, string>>;
  /** Selected units the oracle cannot observe, kept out of extras. */
  readonly unverified: Readonly<Record<string, string>>;
  /** Units with evidence that were not selected (outcome unchanged), for review. */
  readonly softRecall: ReadonlyArray<{ readonly unit: string; readonly evidence: string }>;
  readonly headRunUnits: number;
  readonly selectSeconds: number;
  readonly truthSeconds: number;
  readonly selectedTestSeconds: number;
  readonly allTestSeconds: number;
  readonly caseSeconds: number;
  readonly error: string | null;
}

export interface Report {
  readonly seed: number;
  readonly selector: string;
  readonly base: string;
  readonly baseKey: string;
  readonly packages: ReadonlyArray<string>;
  readonly universeRestricted: boolean;
  readonly limit: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly recordSeconds: number | null;
  readonly baseUnits: number;
  readonly flaky: ReadonlyArray<string>;
  readonly baseFailing: ReadonlyArray<string>;
  readonly standing: Readonly<Record<string, string>>;
  readonly cases: ReadonlyArray<CaseResult>;
}

const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

function evidenceKind(reason: string): string {
  return reason.slice(0, 2);
}

function summarize(
  cases: ReadonlyArray<CaseResult>,
  by: (result: CaseResult) => string,
): Array<string> {
  const groups = new Map<string, Array<CaseResult>>();
  for (const result of cases) groups.set(by(result), [...(groups.get(by(result)) ?? []), result]);
  const lines = [
    "| Group | Cases | Errors | Changed | Selected | Misses | Extras | Over |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, group] of [...groups].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const sum = (pick: (result: CaseResult) => number): number =>
      group.reduce((total, result) => total + pick(result), 0);
    lines.push(
      `| ${cell(name)} | ${group.length} | ${group.filter((result) => result.error !== null).length} | ${sum((result) => result.changed.length)} | ${sum((result) => result.selected)} | ${sum((result) => result.misses.length)} | ${sum((result) => result.extras.length)} | ${sum((result) => result.over.length)} |`,
    );
  }
  return lines;
}

export function renderMarkdown(report: Report): string {
  const cases = report.cases;
  const done = cases.filter((result) => result.error === null);
  const misses = done.reduce((total, result) => total + result.misses.length, 0);
  const extras = done.reduce((total, result) => total + result.extras.length, 0);
  const over = done.reduce((total, result) => total + result.over.length, 0);
  const standingGateFailures = done.filter(
    (result) => result.expectStanding && result.over.length > 0,
  );
  const lines: Array<string> = [
    `# test-select bench: seed ${report.seed}`,
    "",
    `Selector \`${report.selector}\` on base \`${report.base.slice(0, 12)}\`, ${report.packages.length} packages${report.universeRestricted ? " (restricted universe)" : ""}${report.limit === null ? "" : `, generated cases limited to ${report.limit}`}.`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    `| Cases (errors) | ${cases.length} (${cases.length - done.length}) |`,
    `| Misses (recall gate: 0) | ${misses} |`,
    `| Cases with a miss | ${done.filter((result) => result.misses.length > 0).length} |`,
    `| Extras (selected, no evidence) | ${extras} |`,
    `| Over (extras not in Standing) | ${over} |`,
    `| Expected-Standing cases with Over | ${standingGateFailures.length} |`,
    `| Standing units | ${Object.keys(report.standing).length} |`,
    `| Base units / flaky / failing at base | ${report.baseUnits} / ${report.flaky.length} / ${report.baseFailing.length} |`,
    `| Selector record seconds | ${report.recordSeconds === null ? "cached" : report.recordSeconds.toFixed(1)} |`,
    `| Selector select seconds, median | ${median(done.map((result) => result.selectSeconds)).toFixed(2)} |`,
    "",
    "## Cases",
    "",
    "| Case | Category | Description | Changed | Selected | Misses | Extras | Over | Selected test-s / all | Error |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const result of cases) {
    lines.push(
      `| ${cell(result.id)} | ${cell(result.category)} | ${cell(result.description).slice(0, 120)}${result.expectStanding ? " (expected Standing)" : ""} | ${result.changed.length} | ${result.selectedAll ? `all (${result.selected})` : result.selected} | ${result.misses.length} | ${result.extras.length} | ${result.over.length} | ${result.selectedTestSeconds.toFixed(0)} / ${result.allTestSeconds.toFixed(0)} | ${result.error === null ? "" : cell(result.error.split("\n")[0] ?? "").slice(0, 100)} |`,
    );
  }
  lines.push("", "## By category", "", ...summarize(done, (result) => result.category));
  lines.push(
    "",
    "## By project",
    "",
    ...summarize(done, (result) => result.project ?? "(repo-wide)"),
  );
  const missed = done.filter((result) => result.misses.length > 0);
  if (missed.length > 0) {
    lines.push("", "## Misses", "");
    for (const result of missed) {
      lines.push(
        `- \`${result.id}\` (${result.description}): ${result.misses
          .slice(0, 20)
          .map((unit) => `\`${unit}\``)
          .join(
            ", ",
          )}${result.misses.length > 20 ? `, and ${result.misses.length - 20} more` : ""}`,
      );
    }
  }
  const evidence = new Map<string, number>();
  for (const result of done) {
    for (const reason of Object.values(result.justified))
      evidence.set(evidenceKind(reason), (evidence.get(evidenceKind(reason)) ?? 0) + 1);
  }
  lines.push("", "## Evidence for selected units", "", "| Evidence | Units |", "| --- | ---: |");
  for (const [kind, count] of [...evidence].toSorted()) lines.push(`| ${kind} | ${count} |`);
  const unverified = done.reduce(
    (total, result) => total + Object.keys(result.unverified).length,
    0,
  );
  lines.push(`| unverified (no observation) | ${unverified} |`);
  lines.push(
    "",
    "## Soft recall",
    "",
    "Units with evidence (E1–E4 from the base runs) that the selector did not select and whose outcome did not change. Each needs review.",
    "",
  );
  lines.push("| Case | Units | Sample |", "| --- | ---: | --- |");
  for (const result of done.filter((entry) => entry.softRecall.length > 0)) {
    const sample = result.softRecall[0];
    lines.push(
      `| ${cell(result.id)} | ${result.softRecall.length} | ${sample === undefined ? "" : cell(`${sample.unit}: ${sample.evidence}`).slice(0, 160)} |`,
    );
  }
  if (report.flaky.length > 0 || report.baseFailing.length > 0) {
    lines.push("", "## Excluded units", "");
    for (const key of report.flaky) lines.push(`- flaky at base: \`${key}\``);
    for (const key of report.baseFailing) lines.push(`- failing at base: \`${key}\``);
  }
  return `${lines.join("\n")}\n`;
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function writeReport(
  dir: string,
  name: string,
  report: Report,
): { readonly json: string; readonly markdown: string } {
  NodeFS.mkdirSync(dir, { recursive: true });
  const json = NodePath.join(dir, `${name}.json`);
  const markdown = NodePath.join(dir, `${name}.md`);
  NodeFS.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  NodeFS.writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
