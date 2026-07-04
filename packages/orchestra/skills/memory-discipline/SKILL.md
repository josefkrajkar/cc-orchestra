---
name: memory-discipline
description: |
  Write-discipline skill for the orchestra-memory graph (memory_save, memory_link, memory_invalidate, memory_search, memory_inspect, memory_stats). Governs WHEN a fact is worth persisting, HOW to distill it correctly, which SCOPE (global/project/private) it belongs to, and how to keep the graph clean instead of spammy.

  Trigger when: about to call memory_save or memory_link; the user gives a correction or stated preference ("do it this way", "dělej to takhle", "next time do X", "příště udělej X", "no, use Y instead"); a durable project decision is made; a gotcha is discovered the hard way; an approach is tried and fails (and the reason is worth remembering); end of an orchestrated workflow alongside skill-extract, when a reusable cross-project pattern emerged; deciding which scope a fact belongs in; auditing memory before writing to avoid near-duplicate entities.

  Also trigger when: a previously saved fact turns out to be wrong or superseded (→ memory_invalidate, or memory_save with supersedes_observation_id when replacing it), or before a large batch of saves (to apply the anti-spam rule).

  Do NOT trigger for: session-only scratch details (temp file paths, current diff state, in-flight task status — that's boulder/wisdom territory, not durable memory); facts trivially derivable from reading the repo, git history, or CLAUDE.md; generic programming knowledge unrelated to this project or the user's stated preferences; client-identifying facts that would leak into `global` scope.
version: 1.0.0
---

# Memory Write Discipline

This skill governs writes into the `orchestra-memory` MCP graph (cross-project, cross-session, SQLite-backed). It exists because a bad write is worse than no write: garbage-in pollutes every future session's injected context, across every project. Read this before calling `memory_save` or `memory_link`.

## WHEN to save

Only persist facts that are:

- **User corrections and stated preferences** — "do it this way", "always use X", "no, don't do that" — durable behavioral instructions, not one-off task requests.
- **Durable project decisions** — architectural choices with lasting impact ("used SQLite over Postgres because…"), not in-flight task state.
- **Gotchas discovered the hard way** — traps that cost real debugging time and would trip up a future session or a different agent.
- **Failed approaches, with why** — what was tried, why it didn't work, so it isn't retried. Without the "why" the fact isn't reusable — don't save the failure alone.
- **Cross-project reusable patterns/solutions** — genuinely portable knowledge (a technique, a convention, a preference) worth surfacing outside the current project too.

### Quality filter (adapted from skill-extract)

Apply all four checks before calling `memory_save`. Reject the write if any fails:

1. **Non-obvious** — not derivable from reading the code.
2. **Reusable** — applicable to future similar work, not a one-off detail.
3. **Stable** — unlikely to change soon (avoid saving things that will be stale next week).
4. **Not derivable from repo/git/CLAUDE.md** — if `git log`, the file tree, or the project's own CLAUDE.md would already tell a future session this fact, don't duplicate it into the graph.

Additionally, reject:
- **Session-only details** — current task progress, temp paths, "what we're doing right now." That's what boulder/wisdom JSON and TaskCreate/TaskUpdate are for, not the durable graph.

## HOW to save (distillation contract)

`memory_save` expects already-distilled input, not raw conversation transcript. Before calling it:

1. **Atomic, self-contained propositions** — one fact per item. No pronouns or references back to "the conversation" ("it", "that approach", "as discussed above"). A future session with zero context must be able to read the fact and understand it standalone.
2. **Canonical entity names** — before introducing a new entity name, call `memory_search` (or `memory_inspect`) to check whether an equivalent entity already exists under a different name (e.g. "Josef" vs "Josef Krajkar"). Reuse the existing canonical name or register an alias instead of creating a near-duplicate node.
3. **Relations as `memory_link` triples** — when a fact expresses a relationship between two entities ("X uses Y", "X prefers Y", "X decided Y"), express it as a `subject | predicate | object` triple via `memory_link`, not as prose buried inside an observation text.
4. **One fact per item** — don't bundle multiple unrelated facts into a single observation; split them so each can be independently searched, invalidated, and superseded.
5. **Convert relative dates to absolute** — "yesterday", "last week", "last month" must become an explicit ISO-8601 date before saving. A future session reading the fact months later has no reference point for "yesterday".

## SCOPE selection rules

Every save needs an explicit scope decision — don't rely on the default silently:

- **`global`** — user preferences and reusable cross-project knowledge that apply no matter which project is open (e.g. "user prefers tabs over spaces", "user is migrating from OpenCode to Claude Code"). NEVER put client-identifying facts here — global surfaces in every project, including unrelated clients' work.
- **`project`** — project-specific decisions, conventions, architecture choices, gotchas tied to this codebase.
- **`private`** — client-confidential or sensitive facts: client names, internal API details, credentials-adjacent information, anything that must never leak cross-project or to an unrelated subagent.

**When in doubt between `project` and `private` for client work, choose `private`.** The cost of under-sharing a fact within the same project is low (it's still visible there); the cost of a client-identifying fact leaking into `global` or another project is not recoverable by policy alone. This rule applies equally whether you call `memory_save` directly or go through `wisdom_add` — `wisdom_add` accepts `scope: 'private'` directly, so client-sensitive wisdom never needs to be forced into `project` scope for lack of a `private` option.

## Maintenance

- **Superseded or wrong facts** — call `memory_invalidate` on the stale observation (soft delete via `invalidated_at`) if it should simply disappear, or, when you're saving a corrected replacement anyway, use the supersession flow instead of leaving two contradictory facts both "valid": `memory_search` first, note the outdated fact's id from the `#<id>` prefix on its result line, then call `memory_save` for the replacement fact with `supersedes_observation_id` set to that id — the old fact's `invalidated_at` and `superseded_by` are set automatically.
- **Periodic awareness** — occasionally check `memory_stats` to notice runaway growth, stale entries, or an imbalance across scopes; it's the signal for whether write discipline is actually holding.
- **Auditing** — use `memory_inspect` when trust in the graph's contents is in question; it's the one human-readable escape hatch into otherwise opaque storage.

## Anti-spam rule

**Prefer 0–3 high-value saves per session over many low-value ones.** If nothing in the session passed the quality filter, save nothing — that's the correct outcome, not a missed opportunity. A graph with a few durable, well-distilled facts is more useful (and more trusted) than one with dozens of marginal ones that a future session has to wade through.
