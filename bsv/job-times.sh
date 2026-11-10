#!/usr/bin/env bash
# Usage: bsv/job-times.sh <run-id>  -> job wall time and "Test" step time per job
gh api "repos/uuid-rocks/t3code/actions/runs/$1/jobs?per_page=50" --jq '
  def secs(a;b): ((b|fromdateiso8601) - (a|fromdateiso8601));
  .jobs[] | [ .name, .conclusion,
    (if .started_at and .completed_at then secs(.started_at;.completed_at) else null end),
    ([.steps[] | select(.name=="Test") | if .started_at and .completed_at then secs(.started_at;.completed_at) else null end] | first)
  ] | @tsv' | sort | awk -F'\t' 'BEGIN{print "job\tresult\tjob_s\ttest_step_s"}{print}'
gh api "repos/uuid-rocks/t3code/actions/runs/$1" --jq '"run wall: \(((.updated_at|fromdateiso8601)-(.run_started_at|fromdateiso8601)))s  \(.html_url)"'
