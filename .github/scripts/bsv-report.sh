#!/usr/bin/env bash
# Usage: bsv-report.sh <label> <step seconds>
# Sums the BSV_SELECTION lines vitest-selection.ts appended to
# $RUNNER_TEMP/bsv-selection.log during this step and prints one greppable line.
label=$1
seconds=$2
log="${RUNNER_TEMP:-/tmp}/bsv-selection.log"
touch "$log"
read -r runs selected total < <(awk '
  { runs++; for (i = 1; i <= NF; i++) { split($i, kv, "="); if (kv[1] == "selected") s += kv[2]; if (kv[1] == "total") t += kv[2] } }
  END { print runs + 0, s + 0, t + 0 }' "$log")
line="BSV_JOB label=\"$label\" mode=${BSV_MODE:-off} server_test_cached=${BSV_SERVER_TEST_CACHED:-false} vitest_runs=$runs selected=$selected total=$total step_seconds=$seconds"
echo "$line"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '`%s`\n\n' "$line" >> "$GITHUB_STEP_SUMMARY"
fi
