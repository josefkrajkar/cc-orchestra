#!/bin/bash
# Orchestra Plugin — TaskCompleted Hook (quality gate)
# Blocks task completion (exit 2) when .claude/orchestra-boulder.json exists
# AND explicitly opts in with "gate": "sentinel".
# Conservative: fail-open hook — must never accidentally fail-closed.
# All non-blocking exits are explicit exit 0; only the deliberate sentinel gate
# exits 2. If boulder is absent, field is missing, or jq is unavailable →
# exit 0 (allow completion). Never uses set -e or set -euo pipefail so that
# unexpected errors fall through to the final exit 0, not an implicit failure.

set -u

INPUT=$(cat)

# jq unavailable → fail-open with a single stderr warning.
# Must happen before any jq-dependent extraction below.
if ! command -v jq &>/dev/null; then
  echo "Orchestra: Warning — jq not installed; taskcompleted-gate.sh cannot check sentinel gate (fail-open)." >&2
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")

if [ -z "$CWD" ]; then
  exit 0
fi

BOULDER_FILE="$CWD/.claude/orchestra-boulder.json"

# No boulder → nothing to gate
if [ ! -f "$BOULDER_FILE" ]; then
  exit 0
fi

# Boulder unreadable / malformed → fail-open
if ! jq empty "$BOULDER_FILE" 2>/dev/null; then
  exit 0
fi

# Check for explicit sentinel gate opt-in
GATE=$(jq -r '.gate // empty' "$BOULDER_FILE" 2>/dev/null || echo "")

if [ "$GATE" = "sentinel" ]; then
  echo "Orchestra: sentinel review required before completion" >&2
  exit 2
fi

exit 0
