#!/bin/bash
# Orchestra Plugin — Graph Memory Injection (Phase 3 of the graph-memory design)
#
# Prints a token-dense graph-memory block (project facts + top-K global
# facts + this project's private facts) to stdout for SessionStart context
# injection. Standalone and fail-open by design: on ANY problem (node
# missing, node too old, bundle missing, CLI hiccup) this exits 0 with
# EMPTY stdout and, at most, diagnostics on stderr — a broken/absent memory
# layer must never break the SessionStart hook that calls this script.
#
# Usage: memory-inject.sh [budget_bytes]   (default budget: 9500 bytes, or
#   2000 bytes when ORCHESTRA_MEMORY_INJECT_MODE=index is set — see below)
#
# ORCHESTRA_MEMORY_INJECT_MODE=index opts into an experimental, smaller
# "Pinned facts + entity roster" summary instead of the full dump (D10: OFF
# by default until validated). Unset/any other value keeps the full dump.
#
# project_id is derived from $PWD using the SAME algorithm as the boulder
# instance key in scripts/session-start.sh (sha256 of the cwd path, first
# 16 hex chars) so graph-memory project scoping and boulder instance
# scoping share identity. Callers that received cwd out-of-band (e.g. the
# SessionStart hook, which gets cwd via hook JSON rather than trusting the
# invoking shell's own pwd) should `cd` into that directory — in a
# subshell — before invoking this script.

set -euo pipefail

# Lazy injection index mode (D10: OFF by default, ships as an opt-in env var
# until validated) — see mcp-server/src/inject.ts's buildInjectIndex. Any
# value other than exactly "index" fails open to the validated full dump.
INJECT_MODE="${ORCHESTRA_MEMORY_INJECT_MODE:-full}"
case "$INJECT_MODE" in
  index) INJECT_MODE=index ;;
  *) INJECT_MODE=full ;;
esac

DEFAULT_BUDGET=9500
if [ "$INJECT_MODE" = "index" ]; then
  DEFAULT_BUDGET=2000
fi

BUDGET="${1:-$DEFAULT_BUDGET}"
case "$BUDGET" in
  ''|*[!0-9]*) BUDGET="$DEFAULT_BUDGET" ;;
esac

# Resolve plugin root from this script's own location — never rely on
# CLAUDE_PLUGIN_ROOT (or any other env var) being set.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ENTRY="$PLUGIN_ROOT/mcp-server/dist/server.mjs"

# Fail-open: no node on PATH.
if ! command -v node &>/dev/null; then
  exit 0
fi

# Fail-open: bundle not built/deployed (e.g. Phase 0-2 not run yet).
if [ ! -f "$SERVER_ENTRY" ]; then
  exit 0
fi

# Fail-open: node too old for node:sqlite (needs >= 22.16; a major-version
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
# boulder instance key computed in session-start.sh (line ~35).
# === SHARED project_id CONTRACT — DO NOT CHANGE ===
# project_id = first 16 hex chars of sha256(path + "\n"). The trailing
# newline is load-bearing (echo/pwd both append it; TS computeProjectId
# appends "\n" explicitly). This MUST stay byte-identical across:
#   - orchestra-memory: memory-inject.sh, post-compact.sh
#   - orchestra: session-start.sh (boulder instance key == graph project_id)
#   - mcp-server/src/migrate.ts: computeProjectId()
# Guarded by mcp-server/test/project-id-contract.test.ts. Never drop the newline.
# ===================================================
PROJECT_ID=$(pwd | shasum -a 256 2>/dev/null | cut -c1-16 || echo "")
if [ -z "$PROJECT_ID" ]; then
  exit 0
fi

# The --inject CLI is synchronous, local-DB-only (no network) and designed
# to be fast (sub-100ms per docs/design/graph-memory-design.md Phase 3). macOS ships no
# `timeout(1)` by default, so we deliberately do NOT wrap this call in a
# background-kill harness — that would trade a real (small) risk for a lot
# of fragility, for a call that is fast by design and already fails open
# internally (dist/server.mjs --inject never exits nonzero, never hangs on
# I/O it doesn't control). Never propagate a nonzero exit from this line.
OUTPUT=$(node "$SERVER_ENTRY" --inject --project-id "$PROJECT_ID" --budget "$BUDGET" --inject-mode "$INJECT_MODE" 2>/dev/null || true)

if [ -z "$OUTPUT" ]; then
  exit 0
fi

# Defensive byte-budget re-enforcement on our side too, in case the CLI
# ever misbehaves (the CLI already trims at whole-fact boundaries, so this
# should be a no-op in practice).
printf '%s' "$OUTPUT" | head -c "$BUDGET"
exit 0
