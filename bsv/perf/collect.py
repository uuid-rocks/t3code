#!/usr/bin/env python3
"""Usage: bsv/perf/collect.py <run-id> <label>

Writes bsv/perf/raw/<label>.json: run wall time, per-job durations and vCPU,
Test step seconds, BSV_SELECTION / BSV_FILES / BSV_JOB lines, plugin cache
lines with timing, and (arm B) the test:cached task-cache reports.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime

REPO = "uuid-rocks/t3code"
HERE = os.path.dirname(os.path.abspath(__file__))


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def kv(text):
    return dict(re.findall(r'(\w+)=("[^"]*"|\S+)', text))


def main(run_id, label):
    run = json.loads(gh("api", f"repos/{REPO}/actions/runs/{run_id}"))
    jobs = json.loads(gh("api", f"repos/{REPO}/actions/runs/{run_id}/jobs?per_page=50"))["jobs"]
    log = gh("run", "view", run_id, "-R", REPO, "--log")

    out_jobs = {}
    for job in jobs:
        if not job.get("started_at") or not job.get("completed_at"):
            continue
        vcpu = next(
            (int(m.group(1)) for l in job["labels"] if (m := re.search(r"(\d+)vcpu", l))), None
        )
        steps = {
            s["name"]: ts(s["completed_at"]) - ts(s["started_at"])
            for s in job["steps"]
            if s.get("started_at") and s.get("completed_at") and s["conclusion"] != "skipped"
        }
        out_jobs[job["name"]] = {
            "conclusion": job["conclusion"],
            "seconds": ts(job["completed_at"]) - ts(job["started_at"]),
            "vcpu": vcpu,
            "test_step_seconds": steps.get("Test"),
            "steps": steps,
            "lines": [],
        }

    line_re = re.compile(r"^(?P<job>[^\t]+)\t(?P<step>[^\t]*)\t﻿?(?P<ts>\S+Z) (?P<msg>.*)$")
    previous = {}
    keep = re.compile(r"BSV_(SELECTION|FILES|JOB) |\[blacksmith\]|^Cached tests:|^vp run: |cache hit")
    for raw in log.splitlines():
        m = line_re.match(raw)
        if not m:
            continue
        job, msg = m["job"], m["msg"]
        t = ts(m["ts"])
        if job in out_jobs and m["step"] == "Test" and keep.search(msg):
            if msg.startswith("BSV_FILES "):
                fields = kv(msg)
                files = msg.split(" files=", 1)[1] if " files=" in msg else ""
                out_jobs[job]["lines"].append(
                    {"t": t, "kind": "files", "root": fields.get("root"), "files": [f for f in files.split(",") if f]}
                )
            else:
                out_jobs[job]["lines"].append(
                    {"t": t, "prev_t": previous.get(job), "msg": msg[:400]}
                )
        if m["step"] == "Test":
            previous[job] = t

    for name, job in out_jobs.items():
        job["selections"] = [
            kv(l["msg"]) for l in job["lines"] if "msg" in l and l["msg"].startswith("BSV_SELECTION ")
        ]
        job["bsv_job"] = next(
            (kv(l["msg"]) for l in job["lines"] if "msg" in l and l["msg"].startswith("BSV_JOB ")), None
        )
        job["restored"] = [
            {"key": l["msg"].split()[-1], "seconds_after_previous_line": l["t"] - (l["prev_t"] or l["t"])}
            for l in job["lines"]
            if "msg" in l and "restored dependency cache" in l["msg"]
        ]
        job["saved"] = []
        last_selection = None
        for l in job["lines"]:
            if "msg" not in l:
                continue
            if l["msg"].startswith("BSV_SELECTION "):
                last_selection = l["t"]
            if "saved dependency cache" in l["msg"]:
                size = re.search(r"\((\d+) bytes\)", l["msg"])
                job["saved"].append(
                    {
                        "bytes": int(size.group(1)) if size else None,
                        "seconds_after_selection_line": l["t"] - last_selection if last_selection else None,
                    }
                )
        job["changed"] = [
            l["msg"] for l in job["lines"] if "msg" in l and re.search(r"files changed since|running every test|no dependency", l["msg"])
        ]

    # Arm B: scripts/test-cached.ts reports per shard.
    task_cache = {}
    names = json.loads(gh("api", f"repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100"))["artifacts"]
    shard_reports = [a["name"] for a in names if a["name"].startswith("test-cache-")]
    if shard_reports:
        with tempfile.TemporaryDirectory() as tmp:
            for name in shard_reports:
                gh("run", "download", run_id, "-R", REPO, "-n", name, "-D", f"{tmp}/{name}")
                for file in os.listdir(f"{tmp}/{name}"):
                    report = json.load(open(f"{tmp}/{name}/{file}"))
                    tasks = report["summary"]["tasks"]
                    hits = [t for t in tasks if t["result"].get("CacheHit")]
                    task_cache[name] = {
                        "files": len(report["files"]),
                        "tasks": len(tasks),
                        "hits": len(hits),
                        "saved_ms": sum(t["result"]["CacheHit"].get("saved_duration_ms", 0) for t in hits),
                        "cache_run_ms": report["cacheRunMs"],
                        "verification": report["verification"],
                        "ran_files": sorted(
                            os.path.join(t.get("cwd", ""), f)
                            for t in tasks
                            if not t["result"].get("CacheHit")
                            for f in re.findall(r"'([^']+)'", t.get("command", ""))
                        ),
                    }

    result = {
        "label": label,
        "run_id": int(run_id),
        "url": run["html_url"],
        "event": run["event"],
        "head_branch": run["head_branch"],
        "head_sha": run["head_sha"],
        "conclusion": run["conclusion"],
        "wall_seconds": ts(run["updated_at"]) - ts(run["run_started_at"]),
        "jobs": out_jobs,
        "task_cache": task_cache,
    }
    os.makedirs(f"{HERE}/raw", exist_ok=True)
    with open(f"{HERE}/raw/{label}.json", "w") as f:
        json.dump(result, f, indent=1, sort_keys=True)
    print(f"{label}: run {run_id} {run['conclusion']} wall {result['wall_seconds']:.0f}s")


if __name__ == "__main__":
    main(*sys.argv[1:3])
