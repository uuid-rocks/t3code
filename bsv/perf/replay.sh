#!/usr/bin/env bash
# Usage: bsv/perf/replay.sh <id> <arm a|b|c|build>
# Builds bsv/perf-<id> on bsv/perf-base from one upstream commit (applied, or
# reverted for commits already in the base) and opens a draft PR for one arm.
# The upstream commits come from a read-only fetch:
#   git fetch https://github.com/pingdotgg/t3code.git +main:refs/bsv-upstream/main
set -euo pipefail
id=$1 arm=$2
repo=uuid-rocks/t3code
here=$(cd "$(dirname "$0")" && pwd)
IFS=$'\t' read -r _ sha direction area < <(awk -F'\t' -v id="$id" '$1==id' "$here/commits.tsv")
base=$(git rev-parse origin/bsv/perf-base)
work=bsv/perf-$id
if ! git rev-parse -q --verify "refs/heads/$work" >/dev/null; then
  tree=$(mktemp -d)
  git worktree add -q --detach "$tree" "$base"
  if [[ $direction == forward ]]; then
    git -C "$tree" diff "$sha^" "$sha" | git -C "$tree" apply --index
  else
    git -C "$tree" diff "$sha" "$sha^" | git -C "$tree" apply --index
  fi
  subject=$(git log -1 --format=%s "$sha")
  git -C "$tree" -c core.hooksPath=/dev/null commit -q -m "perf replay $id ($direction $sha): $subject"
  git branch -f "$work" "$(git -C "$tree" rev-parse HEAD)"
  git worktree remove --force "$tree"
fi
[[ $arm == build ]] && exit 0
head="$work-$arm"
git push -q -f origin "$work:refs/heads/$head"
gh pr create -R "$repo" --base bsv/perf-base --head "$head" --draft \
  --title "perf replay $id-$arm: $direction $sha ($area)" \
  --body "bsv/perf measurement, do not merge. Arm $arm (see bsv/perf/README.md)."
