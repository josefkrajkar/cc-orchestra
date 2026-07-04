#!/bin/bash
# Orchestra Plugin — PostToolUse Hook (Edit/Write)
# Tracks file changes and accumulates wisdom during orchestrated workflows

set -euo pipefail

INPUT=$(cat)

# Check jq availability — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — jq not installed. Progress tracking is disabled; boulder state will not be updated."}
ENDJSON
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null || echo "")

if [ -z "$CWD" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Ensure .claude directory exists
mkdir -p "$CWD/.claude"

BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"

# Only track if orchestration is active
if [ ! -f "$BOULDER_FILE" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Validate boulder JSON
if ! jq empty "$BOULDER_FILE" 2>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Extract file path from tool input
FILE_PATH=""
if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")
fi

# Track the changed file
if [ -n "$FILE_PATH" ]; then
  # Update boulder: add file to changed_files, update timestamp
  TEMP_FILE="${BOULDER_FILE}.tmp.$$"
  if jq --arg fp "$FILE_PATH" \
     '.changed_files = ((.changed_files // {}) + {($fp): "live"}) | .last_activity = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))' \
     "$BOULDER_FILE" > "$TEMP_FILE" 2>/dev/null; then
    mv "$TEMP_FILE" "$BOULDER_FILE"
  else
    rm -f "$TEMP_FILE"
  fi
fi

cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
