---
name: skill-extract
description: |
  Persistent skill extraction skill. After completing a significant workflow, extracts reusable patterns, conventions, and architectural decisions into project-level skill files. Activates automatically at the end of orchestrated workflows.

  Trigger when: workflow is complete and produced useful patterns, user says "extract skills", "save patterns", "save conventions", "persist learnings".

  Do NOT trigger for: trivial tasks, mid-workflow, when user explicitly declines.
version: 1.0.0
---

# Persistent Skill Extraction

After completing a significant orchestrated workflow, extract reusable patterns into persistent project-level files.

## What to Extract

### From Existing Wisdom
**Primary:** call `wisdom_get` (`project_id` normally omitted — the server binds to its own project identity at startup) and identify:
- **Conventions** that are project-specific (not generic best practices)
- **Gotchas** that would trip up anyone working on this codebase
- **Decisions** with lasting architectural impact

**Legacy fallback** (when `wisdom_get` isn't found via ToolSearch or the MCP server isn't running): read `.claude/orchestra-wisdom.json` directly and identify the same three categories from its entries.

### From the Completed Work
Analyze what was built/changed and identify:
- **Patterns** that should be repeated in similar future tasks
- **Anti-patterns** that should be avoided
- **Testing strategies** that worked well
- **Cross-project reusable patterns** — genuinely portable knowledge (technique, convention, preference) worth surfacing outside this project too, not just this-codebase wisdom

## Where to Store

### Project CLAUDE.md
If conventions are broadly applicable, suggest adding them to the project's CLAUDE.md file. Don't add automatically — suggest to the user.

### Orchestra Wisdom (persistent)
**Primary — orchestra-memory MCP tools:** these aren't pre-attached — locate them first via ToolSearch (query like `select:wisdom_add,memory_save,memory_link` or keyword `memory`/`wisdom`).
- For the 4 wisdom categories (convention/gotcha/decision/failed_approach): persist with `wisdom_add` (`{text, category, confidence?, scope?}`; `scope` defaults to `'project'` — pass `scope: 'global'` only for genuinely cross-project reusable knowledge, or `scope: 'private'` for client-sensitive facts).
- For richer, cross-project reusable patterns that don't fit the 4 wisdom categories (entities + relations, e.g. "this project uses X because Y"): use `memory_save` (and `memory_link` for relationships between entities) directly, scoped `global` when genuinely portable across projects or `project` when specific to this codebase.
- Follow the write-discipline rules in `skills/memory-discipline/SKILL.md` (quality filter, distillation contract, scope selection, anti-spam rule) before every write — that skill governs HOW and WHERE to write; this skill only decides WHAT is worth extracting at the end of a workflow.

**Legacy fallback** (mandatory when the tools are unavailable): update `.claude/orchestra-wisdom.json` with new entries as before. This persists across sessions and is re-injected after context compaction.

### Project Skills Directory
For complex, reusable workflows, create a new skill in `.claude/skills/`:
```
.claude/skills/
└── project-pattern-name/
    └── SKILL.md
```

## Extraction Protocol

1. Read existing wisdom (`wisdom_get`, or the legacy JSON file as fallback) and recent git diff
2. Identify patterns worth preserving
3. Classify: convention / gotcha / decision / failed-approach / cross-project pattern / reusable-workflow
4. Persist the classified facts:
   - **Primary:** for the 4 wisdom categories, call `wisdom_add` with `{text, category, confidence?, scope?}` — one call per atomic fact. `scope` defaults to `'project'`; use `scope: 'global'` only for genuinely cross-project reusable knowledge, or `scope: 'private'` for client-sensitive facts. Set `confidence` based on how well-established the pattern is from the completed work. For a cross-project reusable pattern beyond the 4 categories, use `memory_save`/`memory_link` instead, per `skills/memory-discipline/SKILL.md`'s scope rules.
   - **Legacy fallback** (tool unavailable): update the wisdom file — **always write entries as objects** (wisdom schema v2):
     ```json
     {
       "text": "the extracted pattern",
       "ts": "<current ISO-8601 timestamp>",
       "confidence": "high|medium|low",
       "source": "<session-id or 'user'>"
     }
     ```
     Set `confidence` based on how well-established the pattern is from the completed work. When reading the existing wisdom file, tolerate legacy plain-string entries — do not rewrite them, only append new objects.
5. For reusable workflows: propose a new skill to the user
6. If user approves: create the skill file

## Quality Filter

Only extract patterns that are:
- **Non-obvious** — not derivable from reading the code
- **Reusable** — applicable to future similar work
- **Stable** — unlikely to change soon
- **Project-specific** — not generic programming advice

## Critical Rules

1. **Don't over-extract** — only genuinely useful patterns
2. **Don't duplicate** — check existing wisdom before adding
3. **Ask before creating skills** — always get user approval
4. **Keep entries concise** — one line per wisdom entry
