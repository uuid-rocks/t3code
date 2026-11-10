#!/usr/bin/env python3
"""Usage: bsv/perf/show.py <label>... -> one-screen summary of collected runs."""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
for label in sys.argv[1:]:
    r = json.load(open(f"{here}/raw/{label}.json"))
    print(f"{label} run {r['run_id']} {r['conclusion']} wall {r['wall_seconds']:.0f}s")
    for name, j in sorted(r["jobs"].items()):
        sel = [(s.get("root"), s.get("selected"), s.get("total")) for s in j["selections"]]
        tot = (sum(int(s[1]) for s in sel), sum(int(s[2]) for s in sel)) if sel else None
        print(f"  {name:14} job {j['seconds']:4.0f}s test {j['test_step_seconds']} sel {tot} restored {[x['key'][-40:][:9] for x in j['restored']][:3]} changed {j['changed'][:1]}")
    for k, v in sorted(r["task_cache"].items()):
        print(f"  {k}: files {v['files']} hits {v['hits']}/{v['tasks']} ran {v['ran_files'][:4]}")
