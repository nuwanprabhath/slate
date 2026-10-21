#!/usr/bin/env bash
# Restarts agents that a usage limit stopped. Run by the lead's staggered background sleepers
# (`sleep N; scripts/agents/resume-limited.sh <run-dir>`), so agents resume even when the lead's
# own wake-up lands inside the limit window.
#
#   <run-dir>/active   one line per running package: "<WP> <sonnet|opus>"
#
# A package is restarted when no run-agent process for it is alive and the tail of its log shows
# a usage-limit or API error. Its session resumes with its context intact.
set -u
RUN_DIR="$1"
[ -f "$RUN_DIR/active" ] || exit 0
while read -r WP KIND; do
  [ -z "${WP:-}" ] && continue
  if pgrep -f "run-agent.sh $RUN_DIR $WP " >/dev/null; then echo "$WP running"; continue; fi
  LOG="$RUN_DIR/$WP.log"
  [ -f "$LOG" ] || continue
  if tail -c 4000 "$LOG" | grep -qiE 'usage_limit|api_error|hit your limit|rate_limit|overloaded'; then
    echo "$WP stopped by a limit: resuming"
    nohup bash "$RUN_DIR/run-agent.sh" "$RUN_DIR" "$WP" "$KIND" resume >> "$RUN_DIR/$WP.runner.log" 2>&1 &
  else
    echo "$WP finished (not a limit)"
  fi
done < "$RUN_DIR/active"
