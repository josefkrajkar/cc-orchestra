#!/bin/bash
# Orchestra Plugin — Graph Memory Daily Backup (v2.2.0)
#
# Rotates a daily snapshot of ~/.claude/orchestra-memory/graph.db into
# ~/.claude/orchestra-memory/backups/graph-<YYYY-MM-DD>.db so a corrupted
# or bad-migration DB can be rolled back. Standalone and fail-open by
# design: on ANY problem (node missing, node too old, bundle missing, CLI
# hiccup) this exits 0 silently — a broken/absent backup layer must never
# break the SessionStart hook that calls this script.
#
# Usage: memory-backup.sh
#
# The underlying `--backup` CLI mode writes nothing to stdout by contract
# (diagnostics go to stderr only) — this script therefore produces no
# output either.

set -euo pipefail

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

# The --backup CLI is synchronous, local-DB-only (no network), fails open
# internally (never exits nonzero) and is a pure existsSync() no-op on the
# overwhelmingly common case (today's backup already exists) — so, like
# memory-inject.sh, we deliberately do NOT wrap this in a timeout harness.
# Never propagate a nonzero exit from this line.
node "$SERVER_ENTRY" --backup --keep 7 || true
exit 0
