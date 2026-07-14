#!/bin/bash
# orchestra-memory — Session Start Hook
# Injects a token-dense graph-memory block into the session and rotates the
# daily graph.db backup. Fail-open: any problem yields a silent, benign hook
# result. Resolves the MCP server bundle under THIS plugin's own root.
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEMORY_INJECT_SCRIPT="$SCRIPT_DIR/memory-inject.sh"
MEMORY_BLOCK=""
if [ -f "$MEMORY_INJECT_SCRIPT" ]; then
  MEMORY_BLOCK=$(cd "$CWD" && bash "$MEMORY_INJECT_SCRIPT" 2>/dev/null) || MEMORY_BLOCK=""
fi
MEMORY_BACKUP_SCRIPT="$SCRIPT_DIR/memory-backup.sh"
if [ -f "$MEMORY_BACKUP_SCRIPT" ]; then
  bash "$MEMORY_BACKUP_SCRIPT" >/dev/null 2>&1 || true
fi
if [ -n "$MEMORY_BLOCK" ]; then
  MSG="## Graph memory
${MEMORY_BLOCK}"
  jq -n --arg msg "$MSG" '{continue: true, suppressOutput: false, systemMessage: $msg}'
else
  cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
fi
