#!/usr/bin/env python3
"""Usage: bsv/perf/analyze.py bsv/perf/oracle > bsv/perf/results.md

Reads bsv/perf/raw/*.json (collect.py) and <oracle-dir>/<id>.txt, the output of
`BSV_MODE=off vp test list --filesOnly --changed origin/bsv/perf-base` on each
replay branch: Vitest's own static-import answer to "which tests import the
changed files".
"""
import csv
import glob
import json
import os
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ORACLE = sys.argv[1]
REFERENCE = [
    ("seed-a", "base tip, BSV_MODE=all: every test with recording, seeds arm A"),
    ("seed-b", "base tip, upstream-like, cold task cache: seeds arm B"),
    ("norec-n", "base tip, no plugin, no test:cached, every job (recording-cost control)"),
    ("rerun-r07-a", "second attempt of r07-a (same selection; runner variance)"),
]


def load(label):
    path = f"{HERE}/raw/{label}.json"
    return json.load(open(path)) if os.path.exists(path) else None


def group(name):
    if name == "Test":
        return "test"
    if name == "Test Web":
        return "web"
    if name.startswith("Test Server"):
        return "server"
    return None


def vcpu_minutes(run):
    return sum(max(0, j["seconds"]) * (j["vcpu"] or 0) for j in run["jobs"].values()) / 60


def ran_files(run):
    files = set()
    for name, job in run["jobs"].items():
        if run["task_cache"] and group(name) == "server":
            continue
        for line in job["lines"]:
            if line.get("kind") == "files":
                files.update(line["files"])
    for report in run["task_cache"].values():
        files.update(report["ran_files"])
    return files


def selected(run, g):
    if g == "server" and run["task_cache"]:
        return sum(len(r["ran_files"]) for r in run["task_cache"].values())
    return sum(
        int(s["selected"])
        for name, job in run["jobs"].items()
        if group(name) == g
        for s in job["selections"]
    )


def job_cell(run, g):
    jobs = [j for n, j in run["jobs"].items() if group(n) == g]
    if not jobs or all(j["seconds"] <= 0 for j in jobs):
        return "skipped"
    if g != "server":
        j = jobs[0]
        return f"{j['seconds']:.0f} ({j['test_step_seconds']:.0f})" if j["test_step_seconds"] is not None else f"{j['seconds']:.0f} (gated)"
    steps = [j["test_step_seconds"] for j in jobs if j["test_step_seconds"] is not None]
    secs = [j["seconds"] for j in jobs]
    if not steps:
        return f"{min(secs):.0f}-{max(secs):.0f} (gated)"
    return f"{min(secs):.0f}-{max(secs):.0f} ({min(steps):.0f}-{max(steps):.0f})"


OWN_CONFIG_ROOTS = {"apps/web", "apps/mobile", "apps/desktop", "packages/client-runtime"}


def read_oracle(path):
    # apps/web's CI script runs only --project unit --project browser.
    return {
        m.group(2)
        for line in open(path)
        if (m := re.match(r"^\[(.*)\] (\S+)$", line.strip())) and "(renders)" not in m.group(1)
    }


def oracle(id_, seed):
    """Statically affected tests, limited to files CI runs through Vitest."""
    path = f"{ORACLE}/{id_}.txt"
    if not os.path.exists(path):
        return None
    branch = f"bsv/perf-{id_}"
    added = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=A", "origin/bsv/perf-base", branch],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    universe = seed["all"] | set(added)
    # <id>-noconfig.txt: the change minus the root vite.config.ts, which only the
    # configs that load it (apps/server and the --config ../../vite.config.ts packages) depend on.
    noconfig = f"{ORACLE}/{id_}-noconfig.txt"
    if os.path.exists(noconfig):
        return (read_oracle(noconfig) | seed["root_config"]) & universe
    return read_oracle(path) & universe


def seed_files():
    run = load("seed-a")
    every, root_config = set(), set()
    for job in run["jobs"].values():
        for line in job["lines"]:
            if line.get("kind") == "files":
                every.update(line["files"])
                if line["root"] not in OWN_CONFIG_ROOTS:
                    root_config.update(line["files"])
    return {"all": every, "root_config": root_config}


def main():
    commits = list(csv.DictReader(open(f"{HERE}/commits.tsv"), delimiter="\t"))
    seed = seed_files()
    out = []
    p = out.append
    p("| commit | area | arm | wall s | Test job (step) s | Web job (step) s | Server jobs (steps) s | ran Test / Web / Server | vCPU-min | oracle tests not run |")
    p("|---|---|---|---|---|---|---|---|---|---|")
    per_arm = {}
    details = []
    for c in commits:
        expected = oracle(c["id"], seed)
        for arm in "abc":
            run = load(f"{c['id']}-{arm}")
            if not run:
                continue
            ran = ran_files(run)
            missing = sorted(expected - ran) if expected is not None else None
            sel = " / ".join(f"{selected(run, g)}" for g in ("test", "web", "server"))
            v = vcpu_minutes(run)
            per_arm.setdefault(arm, []).append((run["wall_seconds"], v, c["id"]))
            p(
                f"| [{c['id']}]({run['url']}) `{c['sha']}` {c['direction']} | {c['area']} | {arm.upper()} | {run['wall_seconds']:.0f} | "
                f"{job_cell(run, 'test')} | {job_cell(run, 'web')} | {job_cell(run, 'server')} | {sel} | {v:.1f} | "
                f"{'n/a' if missing is None else (str(len(missing)) + ' of ' + str(len(expected)))} |"
            )
            invocations = [
                f"{s['root']}{'' if s['shard'] == '-' else ' ' + s['shard']} {s['selected']}/{s['total']}"
                for n, j in sorted(run["jobs"].items())
                if not (run["task_cache"] and group(n) == "server")
                for s in j["selections"]
                if s["selected"] != "0"
            ]
            for k, r in sorted(run["task_cache"].items()):
                invocations.append(f"test:cached {k}: {len(r['ran_files'])} ran, {r['hits']}/{r['tasks']} hits")
            plugin = sorted({l for j in run["jobs"].values() for l in j["changed"] if "running every test" in l or "no dependency" in l})
            details.append(
                f"- **{c['id']}-{arm}** ({run['conclusion']}): " + "; ".join(invocations)
                + (f". Plugin: {'; '.join(x[12:120] for x in plugin)}" if plugin else "")
                + (f". Not run but statically affected: {', '.join(missing[:8])}{' …' if len(missing) > 8 else ''}" if missing else "")
            )
    p("")
    p("Ran counts are test files (file x project for web/mobile). Full run: Test 983, Web 541, Server 484.")
    p("")
    p("| arm | runs | median wall s | median vCPU-min | total vCPU-min | total runner-min |")
    p("|---|---|---|---|---|---|")
    for arm, rows in sorted(per_arm.items()):
        runner = sum(
            sum(max(0, j["seconds"]) for j in load(f"{rid}-{arm}")["jobs"].values()) / 60 for _, _, rid in rows
        )
        p(
            f"| {arm.upper()} | {len(rows)} | {statistics.median(r[0] for r in rows):.0f} | "
            f"{statistics.median(r[1] for r in rows):.1f} | {sum(r[1] for r in rows):.1f} | {runner:.1f} |"
        )
    p("")
    paired = sorted({rid for _, _, rid in per_arm.get("c", [])})
    if paired:
        p(f"Commits with all three arms ({', '.join(paired)}):")
        p("")
        p("| arm | median wall s | total vCPU-min |")
        p("|---|---|---|")
        for arm in "abc":
            rows = [r for r in per_arm[arm] if r[2] in paired]
            p(f"| {arm.upper()} | {statistics.median(r[0] for r in rows):.0f} | {sum(r[1] for r in rows):.1f} |")
        p("")
    p("### Reference runs")
    p("")
    p("| run | what | wall s | Test job (step) s | Web job (step) s | Server jobs (steps) s | ran Test / Web / Server | vCPU-min |")
    p("|---|---|---|---|---|---|---|---|")
    for label, what in REFERENCE:
        run = load(label)
        if run:
            p(
                f"| [{label}]({run['url']}) | {what} | {run['wall_seconds']:.0f} | {job_cell(run, 'test')} | {job_cell(run, 'web')} | "
                f"{job_cell(run, 'server')} | {' / '.join(str(selected(run, g)) for g in ('test', 'web', 'server'))} | {vcpu_minutes(run):.1f} |"
            )
    p("")
    p("### Per-run invocations with selected > 0")
    p("")
    out.extend(details)
    p("")
    p("### Plugin overhead (arm A runs, server shards and Test Web)")
    p("")
    restore, compute, save, size, idle = [], [], [], [], []
    for path in sorted(glob.glob(f"{HERE}/raw/*-a.json")) + [f"{HERE}/raw/seed-a.json"]:
        run = json.load(open(path))
        for name, job in run["jobs"].items():
            if group(name) not in ("server", "web"):
                continue
            restore += [r["seconds_after_previous_line"] for r in job["restored"][:1]]
            save += [s["seconds_after_selection_line"] for s in job["saved"] if s["seconds_after_selection_line"] is not None]
            size += [s["bytes"] for s in job["saved"] if s["bytes"]]
            lines = [l for l in job["lines"] if "msg" in l]
            t_restored = next((l["t"] for l in lines if "restored dependency cache" in l["msg"]), None)
            t_changed = next((l["t"] for l in lines if "files changed since" in l["msg"]), None)
            if t_restored and t_changed:
                compute.append(t_changed - t_restored)
            if group(name) == "server" and job["selections"] and all(s["selected"] == "0" for s in job["selections"]):
                idle.append((job["seconds"], job["test_step_seconds"]))

    def stat(xs, unit="s"):
        return f"median {statistics.median(xs):.2f}{unit}, max {max(xs):.2f}{unit} (n={len(xs)})" if xs else "n/a"

    p(f"- Restore (previous log line to `restored dependency cache`): {stat(restore)}")
    p(f"- Tree hash + selection (`restored` to `files changed since`): {stat(compute)}")
    p(f"- Save (`BSV_SELECTION` line to `saved dependency cache`): {stat(save)}")
    p(f"- Saved bundle size: median {statistics.median(size)/1024:.0f} KiB, max {max(size)/1024:.0f} KiB" if size else "- Saved bundle size: n/a")
    if idle:
        p(f"- Server shards that selected 0 files: job {stat([j for j, _ in idle])}, Test step {stat([s for _, s in idle])}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
