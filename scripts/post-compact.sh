#!/bin/bash
# Orchestra Plugin — PostCompact Hook
# Re-injects critical orchestration context after context window compaction

set -euo pipefail

INPUT=$(cat)

# Check jq — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": false, "systemMessage": "Orchestra: Warning — jq not installed. Post-compact context restoration is disabled."}
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
WISDOM_FILE="$CWD/.claude/orchestra-wisdom.json"

# Only inject if orchestration is active
if [ ! -f "$BOULDER_FILE" ]; then
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
  exit 0
fi

# Build context injection message
MSG="Orchestra context restored after compaction."

# Current phase and progress
if jq empty "$BOULDER_FILE" 2>/dev/null; then
  PHASE=$(jq -r '.phase // "unknown"' "$BOULDER_FILE")
  TASK_COUNT=$(jq '[.tasks // [] | .[]] | length' "$BOULDER_FILE")
  COMPLETED=$(jq '[.tasks // [] | .[] | select(.status == "completed")] | length' "$BOULDER_FILE")
  PENDING_TASKS=$(jq -r '[.tasks // [] | .[] | select(.status == "pending" or .status == "in_progress")] | map(.subject // .description) | join(", ")' "$BOULDER_FILE")
  PLAN=$(jq -r '.plan_summary // empty' "$BOULDER_FILE")
  NEXT=$(jq -r '.next_steps // empty' "$BOULDER_FILE")

  MSG="${MSG} Phase: ${PHASE}. Progress: ${COMPLETED}/${TASK_COUNT} tasks."

  if [ -n "$PENDING_TASKS" ] && [ "$PENDING_TASKS" != "null" ]; then
    MSG="${MSG} Remaining: ${PENDING_TASKS}."
  fi

  if [ -n "$PLAN" ] && [ "$PLAN" != "null" ]; then
    MSG="${MSG} Plan: ${PLAN}."
  fi

  if [ -n "$NEXT" ] && [ "$NEXT" != "null" ]; then
    MSG="${MSG} Next: ${NEXT}."
  fi
fi

# Inject wisdom
if [ -f "$WISDOM_FILE" ] && jq empty "$WISDOM_FILE" 2>/dev/null; then
  # Accept both plain strings (legacy) and objects {text, ts, confidence, source} (v2)
  CONVENTIONS=$(jq -r '(.conventions // []) | map(if type=="object" then .text else . end) | join("; ")' "$WISDOM_FILE")
  GOTCHAS=$(jq -r '(.gotchas // []) | map(if type=="object" then .text else . end) | join("; ")' "$WISDOM_FILE")
  DECISIONS=$(jq -r '(.decisions // []) | map(if type=="object" then .text else . end) | join("; ")' "$WISDOM_FILE")

  if [ -n "$CONVENTIONS" ] && [ "$CONVENTIONS" != "" ]; then
    MSG="${MSG} Conventions: ${CONVENTIONS}."
  fi
  if [ -n "$GOTCHAS" ] && [ "$GOTCHAS" != "" ]; then
    MSG="${MSG} Gotchas: ${GOTCHAS}."
  fi
  if [ -n "$DECISIONS" ] && [ "$DECISIONS" != "" ]; then
    MSG="${MSG} Decisions: ${DECISIONS}."
  fi
fi

# Recent git state
if command -v git &>/dev/null && [ -d "$CWD/.git" ]; then
  BRANCH=$(cd "$CWD" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  CHANGED_COUNT=$(cd "$CWD" && git diff --name-only 2>/dev/null | wc -l | tr -d ' ')
  MSG="${MSG} Git: branch ${BRANCH}, ${CHANGED_COUNT} files changed."
fi

# --- BEGIN Fáze 4: graph memory re-injection (additive, dual-mode alongside legacy wisdom JSON above) ---
# Resolve the plugin root from this script's own location — do not depend on
# CLAUDE_PLUGIN_ROOT being set (this must also work when the script is run
# directly, e.g. in tests). Fail-open: missing node or missing dist bundle
# silently skips this block, leaving the legacy wisdom re-injection above
# untouched.
POSTCOMPACT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" &>/dev/null && pwd)"
MEMORY_PLUGIN_ROOT="$(dirname "$POSTCOMPACT_SCRIPT_DIR")"
MEMORY_SERVER="$MEMORY_PLUGIN_ROOT/mcp-server/dist/server.mjs"

if command -v node &>/dev/null && [ -f "$MEMORY_SERVER" ]; then
  # Same instance-key derivation as session-start.sh (ř. 35): sha256 of cwd, first 16 hex chars.
  MEMORY_PROJECT_ID=$(echo "$CWD" | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")
  if [ -n "$MEMORY_PROJECT_ID" ]; then
    # Post-compact context is precious — smaller budget than SessionStart's 9500B default.
    GRAPHMEM_RAW=$(node "$MEMORY_SERVER" --inject --project-id "$MEMORY_PROJECT_ID" --budget 4000 2>/dev/null || echo "")
    if [ -n "$GRAPHMEM_RAW" ]; then
      # No manual escaping needed here — the final payload below is built with
      # `jq -n --arg`, which handles quoting/newlines/backslashes safely.
      MSG="${MSG} ## Graph memory (post-compact): ${GRAPHMEM_RAW}"
    fi
  fi
fi
# --- END Fáze 4 ---

jq -n --arg msg "$MSG" '{continue: true, suppressOutput: false, systemMessage: $msg}'
