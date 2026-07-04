---
name: memory-migrate
description: Dry-run inventory of legacy memories, then (on confirmation) migrate orchestra-wisdom.json and markdown auto-memory files into the orchestra-memory graph
argument-hint: [--commit]
allowed-tools: [Read, Bash]
---

# Memory Migration

Migrates Orchestra's two legacy memory sources into the cross-project `orchestra-memory` graph:

1. **`.claude/orchestra-wisdom.json`** — already-atomic entries; imported **mechanically** by the CLI (no distillation needed, no LLM judgment involved).
2. **Legacy markdown auto-memory files** (`~/.claude/projects/*/memory/*.md`, excluding `MEMORY.md`) — these are prose, not atomic facts, so **you (the model)** distill them per `skills/memory-discipline/SKILL.md` and write them via `memory_save` yourself. The CLI only inventories these files; it never reads their content into the graph.

Default is always a **dry run** — nothing is written until you explicitly commit (see Step 3).

## Input
`$ARGUMENTS` — pass `--commit` to skip the confirmation prompt and commit immediately after showing the dry-run report. With no arguments, show the dry-run report and ask the user to confirm before writing anything.

## Step 1: Locate the CLI and check prerequisites

Locate `mcp-server/dist/server.mjs` at runtime — `${CLAUDE_PLUGIN_ROOT}` is not reliably set inside command Bash invocations, so probe a few plausible locations instead of assuming one:

```bash
SERVER=""
for candidate in \
  "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/mcp-server/dist/server.mjs" \
  "$PWD/mcp-server/dist/server.mjs" \
  "$PWD/orchestra-plugin/mcp-server/dist/server.mjs" \
  "$HOME"/.claude/plugins/*/orchestra*/mcp-server/dist/server.mjs \
  "$HOME"/.claude/plugins/marketplaces/*/orchestra*/mcp-server/dist/server.mjs; do
  if [ -f "$candidate" ]; then SERVER="$candidate"; break; fi
done
if [ -z "$SERVER" ]; then
  SERVER=$(find "$HOME/.claude" -maxdepth 8 -path '*orchestra*/mcp-server/dist/server.mjs' 2>/dev/null | head -1)
fi
if [ -z "$SERVER" ] || ! command -v node &>/dev/null; then
  echo "orchestra-memory CLI not found (or Node missing) — cannot run migration CLI."
  exit 1
fi
echo "Using: $SERVER"
```

If this fails to find the server bundle, or Node is missing, **stop and tell the user** — do not guess a path or report success. Suggest they check the plugin is installed and built (`cd mcp-server && npm run build` in a dev checkout).

## Step 2: Dry-run inventory (always run this first)

```bash
node "$SERVER" --migrate --project-root "$PWD"
```

Show the report to the user **verbatim** (do not reformat, summarize, or drop entries) — it lists:
- the wisdom file's path and per-category entry counts (v2 objects vs. legacy plain strings),
- every legacy markdown memory file found, with its `name`/`description`/`type` frontmatter, file size, and a suggested scope (`type: user|feedback|reference` → `global`; `type: project` → `project`; missing/unrecognized `type` → `unknown`, decide from content in Step 3).

Nothing is written by this step. If neither a wisdom file nor any markdown files are found, tell the user there is nothing to migrate and stop here.

## Step 3: Commit (only after explicit confirmation, or `--commit` in `$ARGUMENTS`)

If `$ARGUMENTS` does not contain `--commit`, present the dry-run report and ask the user to confirm ("Proceed with migration? (yes/no)"). Only continue past this point on an explicit affirmative, or if `--commit` was passed.

### 3a. Mechanical wisdom import (CLI)

```bash
node "$SERVER" --migrate --commit --project-root "$PWD"
```

This is entirely mechanical — no distillation needed, since `.claude/orchestra-wisdom.json` entries are already atomic:
- Backs up the graph DB first (`graph.db.bak-<timestamp>`), skipped only if no DB exists yet.
- Imports each wisdom entry via the same validation/dedupe path as `memory_save`, mapping `conventions→convention`, `gotchas→gotcha`, `decisions→decision`, `failed_approaches→failed_approach`; legacy plain-string entries get `confidence: medium`; source is tagged `migration:wisdom`; scope is `project` (project_id = sha256-16 of `$PWD`, same derivation used elsewhere in Orchestra).
- Never touches `orchestra-wisdom.json` itself.
- Safe to re-run — duplicates are skipped, not re-inserted.

Show the resulting summary line (saved/duplicate/rejected counts, backup path or "skipped") to the user.

### 3b. Markdown memory distillation (you do this, not the CLI)

For **each** markdown file listed in the Step 2 report:

1. **Read** the file (frontmatter + body).
2. **Distill** its content into atomic, self-contained facts, following `skills/memory-discipline/SKILL.md`'s "HOW to save" contract:
   - One fact per proposition; no pronouns or references back to the file's own context.
   - Canonical entity names — reuse existing names where the fact clearly refers to something already in the graph (e.g. "Josef Krajkar" if that's the established canonical form).
   - Relations expressed as `subject | predicate | object` triples go through `memory_link` / `memory_save`'s `relations` field, not prose.
   - Convert any relative dates in the file to absolute ISO-8601 dates.
   - Apply the quality filter (non-obvious, reusable, stable, not derivable from repo/git) — it is correct to migrate **zero** facts from a file if nothing in it clears the bar; don't force low-value content into the graph just because the file exists.
3. **Determine scope** — start from the file's frontmatter-based suggestion in the Step 2 report (`type: user/feedback/reference` → `global`, `type: project` → `project`), but **override to `private`** if the content is client-identifying or confidential regardless of what the heuristic said — `memory-discipline`'s scope rules (see its "SCOPE selection rules" section) take precedence over the mechanical frontmatter heuristic whenever they conflict. When `type` was missing/unrecognized (`unknown` in the report), decide scope from content using the same rules.
4. **Locate `memory_save`** via ToolSearch if it isn't already attached to this session (same pattern as `commands/wisdom.md` / `agents/executor.md`: query `select:memory_save` or keyword `memory`).
5. **Call `memory_save`** for the distilled facts with `source: "migration:md"`, the scope from step 3, and `project_id` = sha256-16 of `$PWD` when scope is `project` or `private` (omit for `global`).
6. **Never modify, move, or delete the original `.md` file.** It remains read-only source material — Claude Code's built-in auto-memory continues to own it until the user separately disables `autoMemoryEnabled` (see `/memory-setup`, a related but distinct command).

Re-running this step for the same file is expected to be safe as long as your distilled phrasing is stable: `memory_save`'s dedupe is exact-normalized-text, not semantic, so rephrasing the same fact differently across runs can create a near-duplicate rather than being caught as a repeat — keep your distillation wording consistent across repeated migrations of the same source file.

## Step 4: Verify and report

1. Call `memory_stats` and show the scope/category counts to the user.
2. Call `memory_inspect` with a filter that covers what was just imported (e.g. `entity: "project wisdom"` for the wisdom import, or a sample entity from a migrated markdown file) and show a few sample entries so the user can trust what was actually written.
3. Tell the user explicitly:
   - The original `orchestra-wisdom.json` and all markdown memory files are **untouched** — this command only ever reads them.
   - Re-running `/memory-migrate --commit` is safe for the wisdom import (mechanically deduped) and safe-in-practice for markdown files as long as distillation wording stays consistent.
   - Built-in auto-memory (`autoMemoryEnabled`) is **not** disabled by this command — that is a separate, explicit step the user must take themselves (see `/memory-setup`).

## Rules
- **Never delete, overwrite, or move** `orchestra-wisdom.json` or any markdown memory file — read-only sources, always.
- **Dry run first, every time** — do not skip Step 2 even if the user passed `--commit`; the report is what the user is confirming against.
- If the CLI can't be located or Node is unavailable, report this clearly and stop — do not fall back to reimplementing the wisdom import by hand.
- If `--commit` fails (the CLI exits non-zero), show the error to the user verbatim and stop before attempting any markdown distillation — a failed mechanical import means the DB may not be in the state you think it's in.
- Prefer migrating nothing over migrating garbage — the quality filter in `skills/memory-discipline/SKILL.md` applies here exactly as it does to any other `memory_save` call.
