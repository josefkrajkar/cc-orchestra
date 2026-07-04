---
name: wisdom
description: View, add to, or clear the accumulated orchestration wisdom
argument-hint: [show|add <entry>|clear]
allowed-tools: [Read, Write, Bash]
---

# Wisdom Management

Manage accumulated orchestration wisdom (conventions/gotchas/decisions/failed_approaches).

**Primary path — orchestra-memory MCP tools.** Wisdom now lives in the `orchestra-memory` graph and is read/written through `wisdom_get` / `wisdom_add` / `memory_invalidate`. These tools aren't pre-attached to commands — locate them first via ToolSearch (query like `select:wisdom_get,wisdom_add,memory_invalidate` or keyword `memory`/`wisdom`).

**Legacy fallback (mandatory when tools are unavailable).** If the tools aren't found via ToolSearch, or the MCP server isn't running (e.g. Node missing or too old), fall back to reading/writing `.claude/orchestra-wisdom.json` directly — the fallback branch under each action below describes exactly the same behavior this command had before the graph memory migration.

**Decision rule:** always attempt the primary MCP path first for whichever action is running; only use the legacy fallback for that action if the relevant tool call fails or the tool can't be found via ToolSearch.

## Input
Action: `$ARGUMENTS` (defaults to "show" if empty)

## Actions

### show (default)
**Primary:** call `wisdom_get` — `project_id` is normally omitted: the MCP server binds to its own project identity at startup (sha256 of its cwd, same derivation as the boulder instance key) and defaults to it automatically. A supplied `project_id` that doesn't match the server's own is rejected with an error for project/private scopes; global scope is unaffected. Display the returned text **as-is** — `wisdom_get` already renders it grouped by category (Conventions / Gotchas / Decisions / Failed Approaches), with a confidence marker per entry and a ⚠️ flag on entries older than 90 days. Do not reformat, regroup, or re-derive staleness — the tool's rendering is authoritative.

**Legacy fallback** (tool unavailable): read and display `.claude/orchestra-wisdom.json` directly:

```markdown
## Accumulated Wisdom

### High Confidence (X entries)
- [entry text] — source: session-abc, 2026-05-01

### Medium Confidence (X entries)
- [entry text] — source: user, 2026-01-10

### Low Confidence (X entries)
- [entry text] — source: session-xyz, 2025-03-01 ⚠️ older than 90 days — consider reviewing

### Unclassified / Legacy (X entries)
- [plain string entry from older sessions]
```

When displaying entries in the fallback:
- Group by `confidence` field: `high` → `medium` → `low` → unclassified (legacy plain strings)
- For each entry, compute age from `ts` field; if age > 90 days append `⚠️ older than 90 days — consider reviewing`
- Legacy plain-string entries (no `ts` field) go into the "Unclassified / Legacy" group without an age flag
- Show `source` and `ts` inline after the text for traceability

Note: the legacy display groups by **confidence**; the primary path's `wisdom_get` groups by **category** instead (with confidence shown per line) — this is an intentional difference in the new format, not a bug to reconcile.

### add <entry>
Determine category from content — same rule for both paths:
- Naming/style/organization patterns → `conventions` (tool category: `convention`)
- Bugs/traps/non-obvious behaviors → `gotchas` (tool category: `gotcha`)
- Architectural/design choices → `decisions` (tool category: `decision`)
- Approaches that didn't work → `failed_approaches` (tool category: `failed_approach`)

**Primary:** call `wisdom_add` with `{text, category, confidence?, scope?}`. `project_id` is not needed — it's normally omitted, since the server is bound to its own project at startup. `scope` defaults to `'project'` (the current project) — leave it unset for ordinary project-scoped wisdom. Pass `scope: 'global'` only as an explicit opt-in for genuinely cross-project reusable knowledge (apply the quality bar in `skills/memory-discipline/SKILL.md` before doing so), or `scope: 'private'` for client-sensitive wisdom per that same skill's guidance. Set `confidence` to `"medium"` by default unless the context clearly warrants `"high"` or `"low"`. `wisdom_add` is a thin wrapper over `memory_save` and dedupes exact-normalized repeats of existing wisdom text itself — no need to check for duplicates beforehand. Distill `text` into a single, self-contained sentence (no pronouns referring back to the conversation) before calling it, per the write-discipline in `skills/memory-discipline/SKILL.md`.

**Legacy fallback** (tool unavailable): parse the entry, read the existing file, append the new entry as an **object** (avoid duplicates), write back.

New entry format:
```json
{
  "text": "the wisdom entry text",
  "ts": "2026-06-12T10:00:00Z",
  "confidence": "high",
  "source": "session-id or 'user'"
}
```

Set `confidence` to `"medium"` by default unless the context clearly warrants `"high"` or `"low"`. Set `source` to `"user"` when the entry is provided directly by the user; otherwise use the current session identifier if available, or `"session"` as a fallback.

### clear
**Primary:** call `memory_invalidate` with `entity: "project wisdom"` (the shared entity `wisdom_add` attaches facts to) and the current `project_id` to clear this project's wisdom, or the same `entity` with no `project_id` to clear the shared global wisdom entity. This is a **soft delete** by default — it sets `invalidated_at` on the matching observations so `wisdom_get` stops surfacing them, but their history remains visible via `memory_inspect`. Only pass `hard: true` (irreversible, permanently removes the rows) if the user has explicitly confirmed they want a hard delete — default to soft delete otherwise and say so.

**Legacy fallback** (tool unavailable): reset the wisdom file to empty categories:
```json
{
  "conventions": [],
  "gotchas": [],
  "decisions": [],
  "failed_approaches": []
}
```

## Wisdom File Schema (v2) — legacy fallback format

This schema applies only to the legacy `.claude/orchestra-wisdom.json` fallback path; the primary MCP path stores facts as graph observations and has no JSON schema to maintain.

Each category array holds **entry objects**:

```json
{
  "conventions": [
    {
      "text": "Always use path aliases — never relative ../../ imports",
      "ts": "2026-06-12T10:00:00Z",
      "confidence": "high",
      "source": "session-abc123"
    }
  ],
  "gotchas": [
    {
      "text": "prisma generate must run before tsc or type errors appear",
      "ts": "2026-05-01T08:30:00Z",
      "confidence": "medium",
      "source": "user"
    }
  ],
  "decisions": [],
  "failed_approaches": []
}
```

### Backward Compatibility — REQUIRED for the legacy fallback

**The legacy fallback must accept BOTH formats in every category array:**

- **Object (v2):** `{ "text": "...", "ts": "ISO-8601", "confidence": "high|medium|low", "source": "..." }`
- **Plain string (legacy):** `"some wisdom entry"` — treat as unclassified; no ts, no confidence

When reading, check `typeof entry === "string"` and handle gracefully. Never reject a file because it contains plain strings. When writing, always emit objects.

## Rules
- Wisdom persists across sessions — the primary path lives in the cross-session, cross-project `orchestra-memory` graph; the legacy JSON fallback also survives boulder save/restore
- Keep entries concise but informative
- Legacy fallback: avoid duplicates — check `text` field (or string value for legacy) before adding (the primary path's `wisdom_add` already dedupes for you)
- Wisdom is automatically re-injected after context compaction — via graph memory re-injection on the primary path, and the legacy wisdom JSON re-injection on the fallback path (see `scripts/post-compact.sh`)
- Legacy fallback: always write objects on add; never downgrade existing objects to plain strings
