#!/usr/bin/env bash
# Starts (or resumes) one headless Claude Code agent for a work package inside its own worktree,
# so this repo's .claude hooks (the Stop hook's definition of done) run on it. Adapted from
# Apiary's scripts/agents/run-agent.sh.
#
#   scripts/agents/run-agent.sh <run-dir> <WP> <sonnet|opus> [start|resume] [message-file]
#
#   <run-dir>  absolute folder holding common.md, <WP>.md (the brief); <WP>.log is written there
#   <WP>       package id; its worktree is .worktrees/<wp lowercased>
#   sonnet     claude-sonnet-5-5 at low effort; opus: claude-opus-5-5 at low effort
#   resume     continue the logged session (after a usage limit) with [message-file] or a default
#
# Copy this script into the run dir before using it, and never edit a copy that is executing:
# bash reads a script as it runs.
set -u
RUN_DIR="$1"; WP="$2"; KIND="$3"; MODE="${4:-start}"
MSGFILE=""
[ -n "${5:-}" ] && MSGFILE="$(cd "$(dirname "$5")" && pwd)/$(basename "$5")"
ROOT="${SLATE_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
WT="$ROOT/.worktrees/$(echo "$WP" | tr '[:upper:]' '[:lower:]')"

case "$KIND" in
  sonnet) MODEL=(--model claude-sonnet-5-5 --effort low) ;;
  opus)   MODEL=(--model claude-opus-5-5 --effort low) ;;
  *) echo "model must be sonnet or opus" >&2; exit 2 ;;
esac

# Headless: edits are auto-accepted and Bash is an explicit allowlist. Publishing, hook-skipping
# and stashing are denied outright. `npm install` is allowed only bare (installs what package.json
# says; the plan names every dependency), because each worktree has its own node_modules.
ALLOW=("Bash(npm run:*)" "Bash(npm test:*)" "Bash(npm install)" "Bash(npm ls:*)" "Bash(npx:*)" "Bash(git:*)" "Bash(node:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(grep:*)" "Bash(rg:*)" "Bash(find:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(sed -n:*)" "Bash(mkdir:*)" "Bash(pgrep:*)" "Bash(pkill:*)" "Bash(ps:*)" "Bash(diff:*)" "Bash(sort:*)")
DENY=("Bash(git push:*)" "Bash(git tag:*)" "Bash(git stash:*)" "Bash(git commit --no-verify:*)" "Bash(git commit -n:*)" "Bash(npm version:*)" "Bash(npm publish:*)" "Bash(gh:*)")
COMMON=("${MODEL[@]}" --permission-mode acceptEdits --add-dir "$RUN_DIR" --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}" --output-format stream-json --verbose)

cd "$WT" || { echo "no worktree $WT" >&2; exit 2; }
export SLATE_BASE_REF="${SLATE_BASE_REF:-main}"

if [ "$MODE" = resume ]; then
  SID=$(head -1 "$RUN_DIR/$WP.log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session_id)}catch{}})')
  MSG="You were stopped (usage limit or crash). Run git status and git log first, then continue your task exactly where you left off, then finish with the report."
  [ -n "$MSGFILE" ] && MSG="$(cat "$MSGFILE")"
  claude -p "$MSG" --resume "$SID" "${COMMON[@]}" >> "$RUN_DIR/$WP.log" 2>&1
else
  # A brief written through a shell heredoc can come out empty (a stray backtick): refuse it.
  if [ ! -s "$RUN_DIR/$WP.md" ] || [ "$(wc -c < "$RUN_DIR/$WP.md")" -lt 400 ]; then
    echo "refusing to start $WP: $RUN_DIR/$WP.md is missing or too short to be a brief" >&2
    exit 2
  fi
  : > "$RUN_DIR/$WP.log"
  claude -p "$(cat "$RUN_DIR/common.md")

$(cat "$RUN_DIR/$WP.md")" "${COMMON[@]}" >> "$RUN_DIR/$WP.log" 2>&1
fi
echo "exit $? for $WP"
tail -c 3000 "$RUN_DIR/$WP.log" | grep -o '"terminal_reason":"[^"]*' | tail -1 || true
tail -c 3000 "$RUN_DIR/$WP.log" | grep -o '"result":"[^"]*' | tail -1 | cut -c1-400
GD=$(git rev-parse --absolute-git-dir)
[ -f "$GD/slate-not-done" ] && { echo "!! NOT DONE marker:"; head -20 "$GD/slate-not-done"; }
exit 0
