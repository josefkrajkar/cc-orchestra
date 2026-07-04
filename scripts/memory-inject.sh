#!/bin/bash
# Orchestra Plugin — Graph Memory Injection (Fáze 3 of PLAN-graph-memory.md)
#
# Prints a token-dense graph-memory block (project facts + top-K global
# facts + this project's private facts) to stdout for SessionStart context
# injection. Standalone and fail-open by design: on ANY problem (node
# missing, node too old, bundle missing, CLI hiccup) this exits 0 with
# EMPTY stdout and, at most, diagnostics on stderr — a broken/absent memory
# layer must never break the SessionStart hook that calls this script.
#
# Usage: memory-inject.sh [budget_bytes]   (default budget: 9500 bytes)
#
# project_id is derived from $PWD using the SAME algorithm as the boulder
# instance key in scripts/session-start.sh (sha256 of the cwd path, first
# 16 hex chars) so graph-memory project scoping and boulder instance
# scoping share identity. Callers that received cwd out-of-band (e.g. the
# SessionStart hook, which gets cwd via hook JSON rather than trusting the
# invoking shell's own pwd) should `cd` into that directory — in a
# subshell — before invoking this script.

set -euo pipefail

BUDGET="${1:-9500}"
case "$BUDGET" in
  ''|*[!0-9]*) BUDGET=9500 ;;
esac

# Resolve plugin root from this script's own location — never rely on
# CLAUDE_PLUGIN_ROOT (or any other env var) being set.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ENTRY="$PLUGIN_ROOT/mcp-server/dist/server.mjs"

# Fail-open: no node on PATH.
if ! command -v node &>/dev/null; then
  exit 0
fi

# Fail-open: bundle not built/deployed (e.g. Fáze 0-2 not run yet).
if [ ! -f "$SERVER_ENTRY" ]; then
  exit 0
fi

# Fail-open: node too old for node:sqlite (needs >= 22.5; a major-version
# check is a cheap, good-enough proxy here — the CLI itself also detects
# node:sqlite unavailability internally and fails open).
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo "")
case "$NODE_MAJOR" in
  ''|*[!0-9]*) exit 0 ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  exit 0
fi

# project_id: sha256($PWD), first 16 hex chars — identical algorithm to the
# boulder instance key computed in session-start.sh (ř. ~35).
PROJECT_ID=$(pwd | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")
if [ -z "$PROJECT_ID" ]; then
  exit 0
fi

# The --inject CLI is synchronous, local-DB-only (no network) and designed
# to be fast (sub-100ms per PLAN-graph-memory.md Fáze 3). macOS ships no
# `timeout(1)` by default, so we deliberately do NOT wrap this call in a
# background-kill harness — that would trade a real (small) risk for a lot
# of fragility, for a call that is fast by design and already fails open
# internally (dist/server.mjs --inject never exits nonzero, never hangs on
# I/O it doesn't control). Never propagate a nonzero exit from this line.
OUTPUT=$(node "$SERVER_ENTRY" --inject --project-id "$PROJECT_ID" --budget "$BUDGET" 2>/dev/null || true)

if [ -z "$OUTPUT" ]; then
  exit 0
fi

# Defensive byte-budget re-enforcement on our side too, in case the CLI
# ever misbehaves (the CLI already trims at whole-fact boundaries, so this
# should be a no-op in practice).
printf '%s' "$OUTPUT" | head -c "$BUDGET"
exit 0
