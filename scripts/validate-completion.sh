#!/bin/bash
# Orchestra Plugin — Stop Hook
# Validates that orchestrated work is complete before allowing session to end

set -euo pipefail

INPUT=$(cat)

# Check jq availability — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — jq not found, cannot validate orchestration state."}
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

# Ensure .claude directory exists
mkdir -p "$CWD/.claude"

BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"

# If no orchestration state, nothing to validate
if [ ! -f "$BOULDER_FILE" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Validate boulder JSON is valid
if ! jq empty "$BOULDER_FILE" 2>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — boulder.json is corrupted. Use /boulder clear to reset."}
ENDJSON
  exit 0
fi

# Check for incomplete tasks
PHASE=$(jq -r '.phase // "complete"' "$BOULDER_FILE")
PENDING=$(jq '[.tasks // [] | .[] | select(.status == "pending" or .status == "in_progress")] | length' "$BOULDER_FILE")

if [ "$PENDING" -gt 0 ]; then
  jq -n --arg pending "$PENDING" --arg phase "$PHASE" \
    "{\"continue\": true, \"suppressOutput\": false, \"systemMessage\": (\"Orchestra: There are \" + \$pending + \" incomplete tasks in phase '\" + \$phase + \"'. Consider running /boulder save before stopping, or complete the remaining work.\")}"
  exit 0
fi

# All tasks done — clean up boulder
rm -f "$BOULDER_FILE"

cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
