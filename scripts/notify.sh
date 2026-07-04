#!/bin/bash
# Orchestra Plugin — Notification Hook
# Handles notifications during orchestration (agent completion, approvals)
# Uses jq to extract the cwd field from the hook payload; guarded below.

set -euo pipefail

INPUT=$(cat)

# jq is required to extract cwd from the payload — guard before first use
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")

if [ -z "$CWD" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"

# Only process during active orchestration
if [ ! -f "$BOULDER_FILE" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Pass through — notification is informational
cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
