#!/bin/bash
# orchestra-memory — PostCompact Hook
# Re-injects graph memory after context compaction (smaller budget than
# SessionStart). Fail-open. Resolves the MCP server under this plugin's root.
#
# Remote mode (docs/design/remote-memory-plan.md Task 4.2 — verified, no
# script-level change needed): the `--inject` invocation below is the exact
# same CLI mode memory-inject.sh calls, made remote-aware entirely inside
# src/inject.ts's runInject() (Task 4.1). URL set + server reachable -> remote
# fetch; URL set + unreachable/erroring -> local DB fallback; local DB also
# absent -> empty output. Always exits 0. ORCHESTRA_MEMORY_URL /
# ORCHESTRA_MEMORY_TOKEN / ORCHESTRA_MEMORY_TIMEOUT_MS need no explicit
# forwarding here: `node` is invoked below as a plain subprocess (no `env -i`
# / env-clearing anywhere in this script), so anything exported in the
# calling shell/session reaches the CLI via normal Unix env inheritance.
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
  # === SHARED project_id CONTRACT — DO NOT CHANGE ===
  # project_id = first 16 hex chars of sha256(path + "\n"). The trailing
  # newline is load-bearing (echo/pwd both append it; TS computeProjectId
  # appends "\n" explicitly). This MUST stay byte-identical across:
  #   - orchestra-memory: memory-inject.sh, post-compact.sh
  #   - orchestra: session-start.sh (boulder instance key == graph project_id)
  #   - mcp-server/src/migrate.ts: computeProjectId()
  # Guarded by mcp-server/test/project-id-contract.test.ts. Never drop the newline.
  # ===================================================
  MEMORY_PROJECT_ID=$(echo "$CWD" | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")
  if [ -n "$MEMORY_PROJECT_ID" ]; then
    # Lazy injection index mode (D10: OFF by default, opt-in env var until
    # validated) — see mcp-server/src/inject.ts's buildInjectIndex. Any
    # value other than exactly "index" fails open to the validated full dump.
    POSTCOMPACT_INJECT_MODE="${ORCHESTRA_MEMORY_INJECT_MODE:-full}"
    POSTCOMPACT_BUDGET=4000
    if [ "$POSTCOMPACT_INJECT_MODE" = "index" ]; then
      POSTCOMPACT_INJECT_MODE=index
      POSTCOMPACT_BUDGET=2000
    else
      POSTCOMPACT_INJECT_MODE=full
    fi
    GRAPHMEM_RAW=$(node "$MEMORY_SERVER" --inject --project-id "$MEMORY_PROJECT_ID" --budget "$POSTCOMPACT_BUDGET" --inject-mode "$POSTCOMPACT_INJECT_MODE" 2>/dev/null || echo "")
    if [ -n "$GRAPHMEM_RAW" ]; then
      jq -n --arg msg "## Graph memory (post-compact): ${GRAPHMEM_RAW}" '{continue: true, suppressOutput: false, systemMessage: $msg}'
      exit 0
    fi
  fi
fi
cat <<'ENDJSON'
{"continue": true, "suppressOutput": true}
ENDJSON
