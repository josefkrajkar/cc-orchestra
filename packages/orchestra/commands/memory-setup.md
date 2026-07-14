---
name: memory-setup
description: Onboard the orchestra-memory graph memory system — diagnose prerequisites, offer migration, and print exact instructions to disable built-in auto-memory
argument-hint:
allowed-tools: [Read, Bash]
---

# Memory Setup — Graph Memory Onboarding

One-time onboarding flow for Orchestra's cross-project `orchestra-memory` graph (MCP server over SQLite). Run this once per machine/checkout to confirm the memory layer works, optionally migrate legacy memories into it, and get the exact steps to stop double-writing into Claude Code's built-in auto-memory.

This command never edits `~/.claude/settings.json` itself — that file is user-owned, and disabling built-in auto-memory is an explicit action only the user can take (see Step 3).

## Step 1: Diagnose prerequisites

### 1a. Node.js version

```bash
if ! command -v node &>/dev/null; then
  echo "node: NOT FOUND on PATH"
else
  node --version
fi
```

Report the exact version string. `orchestra-memory` requires **Node ≥ 22.16** (needs the `node:sqlite` builtin flag-free and with FTS5, both true only since 22.16). If node is missing or below 22.16, tell the user clearly that graph memory tools will be unavailable this session (the MCP server and all hooks fail open — nothing else in Orchestra breaks), and stop here — there's nothing else useful to diagnose without a working Node.

### 1b. MCP server bundle

Probe for the built bundle the same way `commands/memory-migrate.md` does — don't assume `${CLAUDE_PLUGIN_ROOT}` is set:

```bash
SERVER=""
for candidate in \
  "$(dirname "${CLAUDE_PLUGIN_ROOT:-$PWD}")/orchestra-memory/mcp-server/dist/server.mjs" \
  "$PWD/packages/orchestra-memory/mcp-server/dist/server.mjs" \
  "$HOME"/.claude/plugins/*/orchestra*/mcp-server/dist/server.mjs \
  "$HOME"/.claude/plugins/marketplaces/*/orchestra*/mcp-server/dist/server.mjs; do
  if [ -f "$candidate" ]; then SERVER="$candidate"; break; fi
done
if [ -z "$SERVER" ]; then
  SERVER=$(find "$HOME/.claude" -maxdepth 8 -path '*orchestra*/mcp-server/dist/server.mjs' 2>/dev/null | head -1)
fi
if [ -z "$SERVER" ]; then
  echo "dist/server.mjs: NOT FOUND"
else
  echo "Using: $SERVER"
fi
```

If it's missing, this is a **dev checkout that hasn't been built yet** — offer to run the build for the user rather than silently doing it:

> "`mcp-server/dist/server.mjs` isn't built yet. Run `cd mcp-server && npm install && npm run build`? (yes/no)"

Only run `npm install && npm run build` inside `mcp-server/` after an explicit yes. This only produces build output under `mcp-server/dist/` (`server.mjs` + `schema.sql`) — it doesn't touch anything outside the plugin checkout — but still ask first rather than assuming. If the user declines, or the build fails, report that graph memory is unavailable this session and stop here (fail-open: the rest of Orchestra is unaffected).

### 1c. Tool reachability

Locate the `orchestra-memory` tools via ToolSearch — they aren't pre-attached to this command (same pattern as `commands/wisdom.md`): query something like `select:memory_stats,memory_save,memory_search,wisdom_get,wisdom_add` or keyword `memory`. If ToolSearch finds nothing even though the bundle exists and Node is new enough, that usually means `.mcp.json` isn't wired up for this session (e.g. plugin not installed/enabled) — report that clearly rather than guessing.

### 1d. Baseline `memory_stats` snapshot

Call `memory_stats` (project_id = sha256 of `$PWD`, first 16 hex chars — same derivation as everywhere else in Orchestra, see the Gotcha below) and show the counts to the user as a baseline before anything else changes.

**Gotcha — project_id derivation:** the canonical algorithm is `echo "$PWD" | shasum -a 256 | cut -c1-16`. Note the trailing newline `echo` appends — it's part of the hashed input, not an oversight. If you ever need to compute this in bash for a tool call argument, use exactly this pipeline (or `pwd | shasum -a 256 | cut -c1-16`, which is equivalent since `pwd`'s output also ends in a newline).

## Step 2: Offer migration

Ask the user: **"Migrate legacy memories (`.claude/orchestra-wisdom.json` + markdown auto-memory files) into the graph now?"**

If yes, follow the exact procedure documented in `commands/memory-migrate.md` (Steps 1–4) rather than re-implementing it here — locate the CLI, run the dry-run inventory report, show it verbatim, and only commit (mechanical wisdom import + your own markdown distillation via `memory_save`) after the user explicitly confirms. Don't skip the dry-run step even if the user already said yes to migrating in general — the dry-run report is what a "commit" confirmation is actually confirming against.

If no, mention that `/memory-migrate` can be run standalone at any later point and move on.

## Step 3: Instructions to disable built-in auto-memory

**Do not edit `~/.claude/settings.json` yourself, under any circumstances.** Print the exact snippet and ask the user to add it themselves:

```json
{
  "autoMemoryEnabled": false
}
```

Tell the user explicitly:
- Merge this key into their existing `~/.claude/settings.json` (don't overwrite the file — add/update just this one key alongside whatever else is already there).
- Until they do this, **both memory systems stay active simultaneously**: Claude Code's built-in auto-memory (`~/.claude/projects/<encoded>/memory/*.md`) keeps writing alongside the new `orchestra-memory` graph. This isn't harmful, but it means facts can end up duplicated across both systems, and only the graph gets cross-project sharing, scoping, and temporal validity.
- This command will not proceed to make this change for them — it requires their own edit and their own confirmation that they've made it (or a deliberate decision to keep both running for now).

## Step 4: Verify end state

1. Call `memory_stats` again and show the (possibly updated, if migration ran) counts.
2. Run a smoke roundtrip to prove the write/read path works end-to-end:
   - `memory_save` a trivial, clearly-synthetic fact, e.g. `{facts: [{entity: {name: "memory-setup smoke test", kind: "fact"}, text: "memory-setup smoke test executed successfully."}], scope: "project", project_id: <sha256-16 of $PWD>, source: "memory-setup:smoke-test"}`.
   - `memory_search` for `"memory-setup smoke test"` and confirm the fact comes back.
   - Clean up immediately after: call `memory_invalidate` with `{entity: "memory-setup smoke test", hard: true}` — this is a synthetic test entry with no lasting value, so a hard delete (rather than the default soft delete) is appropriate here to avoid leaving smoke-test noise in the graph.
3. Report a summary to the user:
   - Node version found (or "not found / too old").
   - Whether the MCP bundle was already built, freshly built, or still missing.
   - Whether `orchestra-memory` tools were reachable via ToolSearch.
   - Migration outcome (skipped / dry-run only / committed with counts).
   - The exact `autoMemoryEnabled: false` instruction, restated, with an explicit reminder that the user must add it themselves.
   - Smoke roundtrip result (pass/fail).

## Rules

- Never edit `~/.claude/settings.json` — only print the exact snippet and ask the user to apply it.
- Never run `npm install && npm run build` without explicit confirmation first.
- Never skip the dry-run step of migration, even if the user pre-confirms `--commit`-style intent.
- Fail open: if Node is missing/too old, or the bundle can't be built, report this plainly and stop — don't fabricate a working state.
- Don't invent CLI flags or tool parameters beyond what's documented in `mcp-server/README.md`, `commands/memory-migrate.md`, and the tool descriptions surfaced via ToolSearch.
