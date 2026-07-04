#!/bin/bash
# Orchestra Plugin — SubagentStart/SubagentStop Hook
# Appends a JSONL audit line to .claude/orchestra-log.jsonl (cwd-relative).
# Never fails the hook: jq absence is handled gracefully (one stderr warning),
# all writes use || true semantics.

# Intentionally NOT using set -e or set -euo pipefail — this script must never
# cause the hook to fail, so we handle every error manually.

INPUT=$(cat)

# Check jq availability — must happen before any jq-dependent extraction below
if ! command -v jq &>/dev/null; then
  echo "Orchestra: Warning — jq not installed; subagent-log.sh cannot write audit log." >&2
  exit 0
fi

# Derive CWD from payload
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""

if [ -z "$CWD" ]; then
  exit 0
fi

LOG_FILE="$CWD/.claude/orchestra-log.jsonl"

# Ensure directory exists (best-effort)
mkdir -p "$CWD/.claude" 2>/dev/null || true

# Extract fields from the hook payload
# Hook events carry: event (SubagentStart|SubagentStop), agent_type, session_id
EVENT=$(echo "$INPUT"     | jq -r '.hook_event_name // .event // "unknown"' 2>/dev/null) || EVENT="unknown"
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .agentType // empty'     2>/dev/null) || AGENT_TYPE=""
SESSION=$(echo "$INPUT"   | jq -r '.session_id // .sessionId // empty'      2>/dev/null) || SESSION=""
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null) || TS=""

# Build JSONL line and append; || true so a write failure never aborts the hook
jq -cn \
  --arg ts         "$TS" \
  --arg event      "$EVENT" \
  --arg agent_type "$AGENT_TYPE" \
  --arg session    "$SESSION" \
  '{ts: $ts, event: $event, agent_type: $agent_type, session: $session}' \
  >> "$LOG_FILE" 2>/dev/null || true

exit 0
