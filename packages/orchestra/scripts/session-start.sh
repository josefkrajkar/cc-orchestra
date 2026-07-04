#!/bin/bash
# Orchestra Plugin — Session Start Hook
# Loads orchestration state and injects context into the session

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Check jq availability — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — jq not installed. Hook scripts require jq for state management."}
ENDJSON
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")

if [ -z "$CWD" ]; then
  exit 0
fi

# Ensure .claude directory exists
mkdir -p "$CWD/.claude"

BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"
WISDOM_FILE="$CWD/.claude/orchestra-wisdom.json"

# Check for existing orchestration state (boulder system for session persistence)
# R7: only announce the boulder when its instance field matches this instance
# (derived from cwd) OR when instance is absent (legacy boulders always announce).
if [ -f "$BOULDER_FILE" ] && jq empty "$BOULDER_FILE" 2>/dev/null; then
  BOULDER_INSTANCE=$(jq -r '.instance // empty' "$BOULDER_FILE" 2>/dev/null || echo "")
  # Derive a stable instance key from cwd (sha256 of the path, first 16 chars)
  CWD_KEY=$(echo "$CWD" | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")

  # Skip if boulder belongs to a different instance
  if [ -n "$BOULDER_INSTANCE" ] && [ -n "$CWD_KEY" ] && [ "$BOULDER_INSTANCE" != "$CWD_KEY" ]; then
    cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
    exit 0
  fi

  PHASE=$(jq -r '.phase // "unknown"' "$BOULDER_FILE")
  TASK_COUNT=$(jq '[.tasks // [] | .[]] | length' "$BOULDER_FILE")
  COMPLETED=$(jq '[.tasks // [] | .[] | select(.status == "completed")] | length' "$BOULDER_FILE")

  # Build system message
  MSG="Orchestra: Found existing orchestration state. Phase: ${PHASE}, Tasks: ${COMPLETED}/${TASK_COUNT} completed."

  # Include wisdom summary if available
  # Count accepts both plain strings (legacy) and objects {text,ts,confidence,source} (v2)
  if [ -f "$WISDOM_FILE" ] && jq empty "$WISDOM_FILE" 2>/dev/null; then
    WISDOM_COUNT=$(jq '[(.conventions // []), (.gotchas // []), (.decisions // [])] | flatten | map(if type=="object" then .text else . end) | length' "$WISDOM_FILE")
    if [ "$WISDOM_COUNT" -gt 0 ]; then
      MSG="${MSG} Accumulated wisdom: ${WISDOM_COUNT} entries."
    fi
  fi

  MSG="${MSG} Use /status to see full details or continue where you left off."

  jq -n --arg msg "$MSG" '{continue: true, suppressOutput: false, systemMessage: $msg}'
  exit 0
fi

# No existing state — silent
cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
