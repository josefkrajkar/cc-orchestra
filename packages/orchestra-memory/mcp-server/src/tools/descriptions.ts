// Shared prose fragments for MCP tool descriptions. Every tool's exported
// `description` string must stay fully self-contained (MCP clients render
// one tool's description in isolation and can't resolve a reference to
// another tool's text) — these constants exist purely to avoid retyping the
// same paragraph in every tools/*.ts file. They get inlined via template
// literal interpolation at module-load time, so the final description string
// each tool exports is still complete on its own.

/** The project_id trust boundary + scope taxonomy, repeated (identically)
 * across every tool that takes project_id/scope_filter/scope. */
export const SCOPE_NOTE =
  "project_id defaults to your own project; a different project's id is rejected. Scopes: " +
  'global (everywhere), project (this repo), private (this repo only, never leaks out).';

/** The write-discipline summary for tools that accept freeform fact/wisdom
 * text. The full contract (with examples) lives in the memory-discipline
 * skill — this is just enough for the model to self-correct at call time. */
export const DISTILL_NOTE =
  'Facts must be atomic, self-contained sentences (no pronouns — name the subject) and ≤500 ' +
  'chars; full write-discipline contract: memory-discipline skill.';

/** The token-dense output line shape shared by memory_search/memory_traverse
 * (and referenced, for id reuse, by memory_save/memory_invalidate). */
export const LINE_FORMAT_NOTE =
  'Lines render as "#<id> [scope|category|confidence] entity: text"; relations as ' +
  '"src -predicate-> dst".';
