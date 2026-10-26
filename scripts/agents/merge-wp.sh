#!/bin/sh
# Merge a work-package branch into the current branch only when the merged result passes typecheck,
# lint, guards and the tests, and a branch touching security-sensitive paths has an approving review
# (.agent-reports/reviews/<branch>.md ending in "VERDICT: APPROVE" for the branch head). Never pushes.
# Usage: scripts/agents/merge-wp.sh <branch>
exec node "$(dirname "$0")/merge-wp.mjs" "$@"
