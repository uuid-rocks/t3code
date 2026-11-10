#!/usr/bin/env bash
# Usage: bsv/perf/drive.sh <id> <arm>  -> opens the PR, waits for its CI run, collects it.
set -euo pipefail
id=$1 arm=$2
repo=uuid-rocks/t3code
here=$(cd "$(dirname "$0")" && pwd)
head="bsv/perf-$id-$arm"
"$here/replay.sh" "$id" "$arm"
run=""
for _ in $(seq 1 20); do
  run=$(gh run list -R "$repo" --branch "$head" --event pull_request -L 1 --json databaseId --jq '.[0].databaseId // empty')
  [[ -n $run ]] && break
  sleep 6
done
[[ -n $run ]] || { echo "no run for $head"; exit 1; }
echo "$head run $run"
for _ in $(seq 1 40); do
  status=$(gh run view "$run" -R "$repo" --json status --jq .status)
  [[ $status == completed ]] && break
  sleep 30
done
[[ $status == completed ]] || { echo "run $run still $status"; exit 1; }
python3 -I "$here/collect.py" "$run" "$id-$arm"
