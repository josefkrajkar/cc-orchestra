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

# Graph memory injection (Fáze 3 of PLAN-graph-memory.md) — additive,
# fail-open. scripts/memory-inject.sh owns the node/bundle/version guard
# chain and prints nothing on any problem. Run cd'd into $CWD (subshell)
# so its $PWD-derived project_id is computed from the SAME cwd the boulder
# instance key below uses, not this hook script's own invocation dir.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMORY_INJECT_SCRIPT="$SCRIPT_DIR/memory-inject.sh"
MEMORY_BLOCK=""
if [ -f "$MEMORY_INJECT_SCRIPT" ]; then
  MEMORY_BLOCK=$(cd "$CWD" && bash "$MEMORY_INJECT_SCRIPT" 2>/dev/null || true)
fi

# --- Daily graph.db backup (v2.2.0) — side effect only, additive -------
# scripts/memory-backup.sh owns its own fail-open guard chain (node
# missing/too old, bundle missing) and, per the --backup CLI contract,
# never writes to stdout. stdout is discarded here too as belt-and-
# suspenders: this MUST NEVER contribute to the hook's emitted JSON.
MEMORY_BACKUP_SCRIPT="$SCRIPT_DIR/memory-backup.sh"
if [ -f "$MEMORY_BACKUP_SCRIPT" ]; then
  bash "$MEMORY_BACKUP_SCRIPT" >/dev/null 2>&1 || true
fi
# ------------------------------------------------------------------------

MEMORY_HEADER_BLOCK=""
if [ -n "$MEMORY_BLOCK" ]; then
  MEMORY_HEADER_BLOCK="## Graph memory
${MEMORY_BLOCK}"
fi

# Check for existing orchestration state (boulder system for session persistence)
# R7: only announce the boulder when its instance field matches this instance
# (derived from cwd) OR when instance is absent (legacy boulders always announce).
if [ -f "$BOULDER_FILE" ] && jq empty "$BOULDER_FILE" 2>/dev/null; then
  BOULDER_INSTANCE=$(jq -r '.instance // empty' "$BOULDER_FILE" 2>/dev/null || echo "")
  # Derive a stable instance key from cwd (sha256 of the path, first 16 chars)
  CWD_KEY=$(echo "$CWD" | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")

  # Skip if boulder belongs to a different instance
  if [ -n "$BOULDER_INSTANCE" ] && [ -n "$CWD_KEY" ] && [ "$BOULDER_INSTANCE" != "$CWD_KEY" ]; then
    if [ -n "$MEMORY_HEADER_BLOCK" ]; then
      jq -n --arg msg "$MEMORY_HEADER_BLOCK" '{continue: true, suppressOutput: false, systemMessage: $msg}'
    else
      cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
    fi
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

  if [ -n "$MEMORY_HEADER_BLOCK" ]; then
    FULL_MSG="${MSG}

${MEMORY_HEADER_BLOCK}"
    jq -n --arg msg "$FULL_MSG" '{continue: true, suppressOutput: false, systemMessage: $msg}'
  else
    jq -n --arg msg "$MSG" '{continue: true, suppressOutput: false, systemMessage: $msg}'
  fi
  exit 0
fi

# No existing state — silent (unless graph memory has something to add)
if [ -n "$MEMORY_HEADER_BLOCK" ]; then
  jq -n --arg msg "$MEMORY_HEADER_BLOCK" '{continue: true, suppressOutput: false, systemMessage: $msg}'
else
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
fi
