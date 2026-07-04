#!/bin/bash
# orchestra-memory — PostCompact Hook
# Re-injects graph memory after context compaction (smaller budget than
# SessionStart). Fail-open. Resolves the MCP server under this plugin's root.
set -euo pipefail
INPUT=$(cat)
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
POSTCOMPACT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" &>/dev/null && pwd)"
MEMORY_PLUGIN_ROOT="$(dirname "$POSTCOMPACT_SCRIPT_DIR")"
MEMORY_SERVER="$MEMORY_PLUGIN_ROOT/mcp-server/dist/server.mjs"
if command -v node &>/dev/null && [ -f "$MEMORY_SERVER" ]; then
  MEMORY_PROJECT_ID=$(echo "$CWD" | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")
  if [ -n "$MEMORY_PROJECT_ID" ]; then
    GRAPHMEM_RAW=$(node "$MEMORY_SERVER" --inject --project-id "$MEMORY_PROJECT_ID" --budget 4000 2>/dev/null || echo "")
    if [ -n "$GRAPHMEM_RAW" ]; then
      jq -n --arg msg "## Graph memory (post-compact): ${GRAPHMEM_RAW}" '{continue: true, suppressOutput: false, systemMessage: $msg}'
      exit 0
    fi
  fi
fi
cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
