#!/bin/bash
# Orchestra Plugin — PreToolUse Hook (Edit/Write)
# Validates file ownership claims during orchestrated parallel execution
# Prevents two agents from modifying the same file simultaneously
#
# File-lock protocol is the FALLBACK for non-git dirs; in git repos the
# executor uses worktree isolation (`isolation: "worktree"` on the Agent call).

set -euo pipefail

INPUT=$(cat)

# Check jq availability — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — jq not installed. File-lock guard cannot validate ownership claims; concurrent edits may conflict."}
ENDJSON
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null || echo "")

if [ -z "$CWD" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

LOCK_DIR="$CWD/.claude/orchestra-locks"
BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"

# Only guard during active orchestration
if [ ! -f "$BOULDER_FILE" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Extract file path
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Check for file locks (if lock directory exists)
if [ -d "$LOCK_DIR" ]; then
  # Create a safe filename from the path
  LOCK_KEY=$(echo "$FILE_PATH" | sed 's/[^a-zA-Z0-9]/_/g')
  LOCK_FILE="$LOCK_DIR/$LOCK_KEY"

  if [ -f "$LOCK_FILE" ]; then
    LOCK_OWNER=$(cat "$LOCK_FILE" 2>/dev/null || echo "unknown")
    # stat flags differ between BSD (macOS) and GNU (Linux) stat
    if stat -f %m . >/dev/null 2>&1; then
      LOCK_MTIME=$(stat -f %m "$LOCK_FILE" 2>/dev/null || echo "0")
    else
      LOCK_MTIME=$(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo "0")
    fi
    LOCK_AGE=$(( $(date +%s) - LOCK_MTIME ))

    # Stale lock check: locks older than 30 minutes are considered stale
    if [ "$LOCK_AGE" -lt 1800 ]; then
      jq -n --arg fp "$FILE_PATH" --arg owner "$LOCK_OWNER" \
        "{\"continue\": true, \"suppressOutput\": false, \"systemMessage\": (\"Orchestra: Warning — file '\" + \$fp + \"' is currently claimed by agent '\" + \$owner + \"'. Concurrent edits may cause conflicts.\")}"
      exit 0
    else
      # Stale lock — remove it
      rm -f "$LOCK_FILE"
    fi
  fi
fi

cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
