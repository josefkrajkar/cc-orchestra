# Orchestra — Agent Reference

## Monorepo Layout

This repo is a two-package monorepo, each package a standalone Claude Code plugin:

- **`packages/orchestra/`** — the orchestration plugin (agents, commands, skills, conventions, this doc's agent architecture). Registers 9 hook events in its own `.claude-plugin/plugin.json`: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PostCompact`, `Notification`, `SubagentStart`, `SubagentStop`, `TaskCompleted` (all under `packages/orchestra/scripts/`).
- **`packages/orchestra-memory/`** — the optional companion plugin providing cross-project graph memory (MCP server over SQLite, `node:sqlite`). Registers its own `SessionStart` (memory injection via `packages/orchestra-memory/scripts/memory-inject.sh` + daily backup via `packages/orchestra-memory/scripts/memory-backup.sh`) and `PostCompact` (re-injection after compaction, `packages/orchestra-memory/scripts/post-compact.sh`) hooks.

**Soft-companion decoupling:** the two plugins have no hard dependency on each other. Each has its own `plugin.json`, its own hooks, and works fully standalone if the other is not installed. `orchestra` falls back to the legacy `.claude/orchestra-wisdom.json` file for wisdom accumulation when `orchestra-memory` isn't present; `orchestra-memory`'s tools/hooks fail open (no-op, never crash) if its prerequisites (Node ≥ 22.5, built bundle) aren't met. The only thing that couples them by convention (not by code) is the shared `project_id` derivation — see the newline gotcha below — which lets graph memory scoping and orchestra's boulder instance scoping agree on "what project is this" without either plugin importing the other.

## Agent Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                             PLANNING LAYER                             │
│           scout (haiku) + scholar (haiku) + architect (opus)           │
├────────────────────────────────────────────────────────────────────────┤
│                          ORCHESTRATION LAYER                           │
│               conductor (inherit/opus) + executor (opus)               │
├────────────────────────────────────────────────────────────────────────┤
│                            EXECUTION LAYER                             │
│  craftsman (sonnet) + sentinel (sonnet) + verifier (sonnet, optional)  │
└────────────────────────────────────────────────────────────────────────┘
```

## Model Tiering

| Agent | Model | Rationale |
|-------|-------|-----------|
| scout, scholar | haiku | Routing, triage, exploration — fast, cheap, sufficient |
| craftsman | sonnet | Implementation, code writing — good balance of quality/speed |
| architect, executor | opus | Planning, architecture, coordination — complex reasoning needed |
| conductor | inherit (or opus) | May run as `inherit` to benefit from the calling session model; falls back to opus |
| sentinel | sonnet | Structured checklist review follows a fixed protocol — full opus reasoning is unnecessary and expensive |
| verifier | sonnet | Optional E2E smoke/browser verification — bounded, reportable protocol; discovers browser MCP tools at runtime, sonnet sufficient |

**Note on model assignment:** Agent frontmatter `model:` may be silently ignored by some Claude Code versions. Orchestrators must **also pass `model` explicitly in every Agent tool call** (e.g. `model: "sonnet"`) — the tool-level parameter is the reliable path.

## STYLE

- Agents communicate via structured reports (markdown with sections)
- Each agent produces a specific output format (see agent files)
- Wisdom is accumulated in JSON, not prose
- File ownership is always explicit in parallel execution

## GOTCHAS

- Scout and sentinel are read-only — they NEVER modify files
- Craftsmen must respect OWNS/MUST NOT MODIFY lists when working in parallel
- Max 5-8 parallel craftsmen (prompt-driven); use Workflow script for >8 tasks — see `packages/orchestra/commands/parallel.md` Scale decision section
- Boulder state can become stale — always validate file hashes on restore; restore on mismatch requires explicit user confirmation before recreating tasks
- Wisdom file persists independently of boulder state; entries are v2 objects (`{text, ts, confidence, source}`); readers must tolerate legacy plain strings
- **Agent tool `model:` frontmatter may be ignored** — always pass `model` explicitly in the Agent tool call as well
- Conductor may run as `inherit` to benefit from the session model context
- Retry pattern: first retry → SendMessage to the same craftsman agentId with failure details; only on second failure → fresh spawn with accumulated context (max 2 total)
- Worktree isolation: executor uses `isolation: "worktree"` for parallel mutating craftsmen in git repos; file-lock protocol is fallback for non-git dirs only
- **`project_id` newline gotcha:** the canonical derivation is `echo "$PWD" | shasum -a 256 | cut -c1-16` — the trailing newline `echo` appends is part of the hashed input, not incidental. `packages/orchestra-memory/mcp-server/src/migrate.ts`'s `computeProjectId()` hashes `` `${projectRoot}\n` `` on the TS side specifically to match this. Any reimplementation of this derivation (bash or TS) that drops the trailing newline computes a *different* `project_id` and silently fragments a project's facts across two identities.
- **`schema.sql` is copied next to the bundle at build time, not embedded in it:** esbuild only bundles JS — `packages/orchestra-memory/mcp-server/src/db/connection.ts` loads `schema.sql` via `readFileSync` relative to `import.meta.url`, which after bundling resolves to `dist/schema.sql`, not `src/db/schema.sql`. `packages/orchestra-memory/mcp-server/esbuild.config.mjs` runs an explicit `copyFileSync('src/db/schema.sql', 'dist/schema.sql')` after the build step for exactly this reason — if you ever see "schema.sql not found" at runtime, check this copy step ran, not the bundle itself.
- **`--backup` rotation is coupled to the copy step, not the daily no-op:** a changed `--keep` value only takes effect on the *next fresh copy* (a new day's backup). If you bump `--keep` after today's `graph-<date>.db` already exists, nothing re-rotates until tomorrow. Fine for the fixed-cadence SessionStart hook (`packages/orchestra-memory/scripts/memory-backup.sh` → `node dist/server.mjs --backup --keep 7`), which by construction runs **at most once a day** in practice even though it's invoked on every SessionStart (the hot path is a pure `existsSync` no-op after the first run of the day).
- **`pretooluse-guard.sh`'s jq-missing warning is now louder (accepted trade-off, v2.2.0):** the jq-first ordering fix (checking `command -v jq` before any jq-dependent extraction) means that without jq, the "jq not installed" warning now fires on **every** PreToolUse event — previously, under `set -euo pipefail`, an unguarded `jq` call earlier in the script would crash the hook silently before the warning was ever reached, so the warning effectively never fired. The new behavior is correct (visible-warning-over-silent-failure is the R9 policy) but noisier if jq is genuinely absent. Lives at `packages/orchestra/scripts/pretooluse-guard.sh`.

## ARCH_DECISIONS

- 3-layer architecture (planning/orchestration/execution) for separation of concerns
- Intent classification before orchestration to prevent overkill
- Worktree isolation (`isolation: "worktree"`) for parallel file-mutating craftsmen in git repos; OWNS/MUST-NOT-MODIFY remain semantic discipline regardless of isolation mode
- Confidence-based review filtering (80%+) to reduce noise
- Staged pipeline with quality gates between each stage
- Wisdom accumulation for cross-session learning (v2 schema: `{text, ts, confidence, source}`)
- Framework conventions: user-level skill takes precedence; plugin `packages/orchestra/conventions/*.md` are the offline fallback digest
- Audit trail via SubagentStart/SubagentStop hooks writing JSONL to `.claude/orchestra-log.jsonl`
- TaskCompleted sentinel gate: opt-in only via `"gate": "sentinel"` in boulder — fail-open by default
- **Graph memory storage — `node:sqlite` over `better-sqlite3`/Kuzu/Neo4j:** `node:sqlite` (stable since Node 22.5) needs zero native or npm dependencies, keeping the deployed bundle rsync-safe (no platform-specific binaries, no `node_modules` in the artifact). `better-sqlite3` was rejected as the default despite being faster because it's a native module (per-platform prebuilt binaries break the marketplace rsync deploy). Kuzu/Neo4j were rejected as separate-server overkill for a plugin that must stay a single bundled file. Trade-off accepted: Orchestra now has a hard Node ≥ 22.5 requirement for this one subsystem, mitigated by fail-open everywhere (hooks, MCP tool registration, CLI modes) so its absence never breaks the rest of the plugin.
- **Scope model (`global`/`project`/`private`) is a first-class column, not a convention:** every node/observation/edge carries `scope` + `project_id` and every read path (search, traverse, inject) applies a scope guard server-side. `private` exists specifically because `project` scope alone doesn't model client-confidentiality — a `project`-scoped fact is still visible to every subagent working in that project, but a `private` fact for a client engagement must never leak into `global` (which surfaces everywhere) even by accident. When in doubt between `project` and `private` for client work, `packages/orchestra/skills/memory-discipline/SKILL.md` mandates choosing `private`.
- **Temporal validity (Graphiti-style) over destructive updates:** facts are never overwritten in place — a new observation either supersedes an old one (`superseded_by` + `invalidated_at`) or is invalidated outright (`invalidated_at`, soft delete by default; hard delete requires explicit `hard: true`). This keeps `memory_inspect`'s history trustworthy and makes migration/rollback non-destructive by construction.
- **Wisdom absorption with legacy fallback, not a hard cutover:** `wisdom_get`/`wisdom_add` are thin wrappers over `memory_search`/`memory_save` so `packages/orchestra/commands/wisdom.md` and the executor/conductor wisdom protocols gained cross-project graph storage without a breaking migration. Every wisdom-reading call site tries the MCP tool first and falls back to reading `.claude/orchestra-wisdom.json` directly if the tool can't be found via ToolSearch or the MCP server isn't running — this is deliberate dual-mode operation during the transition, not dead code to clean up.
- **`project_id` derivation reuses the boulder instance key algorithm:** `sha256($PROJECT_ROOT + "\n")` truncated to 16 hex chars, so graph memory project scoping and boulder instance scoping share identity by construction instead of drifting into two separate "what project is this" concepts. See the newline gotcha above.
- **Verifier is a separate 8th agent, not a sentinel-mode:** sentinel is contractually read-only (`Read`/`Glob`/`Grep`), while E2E verification needs `Bash` plus browser automation. Browser MCP (Playwright) tools are discovered via ToolSearch at runtime and are NEVER pre-attached in frontmatter — verifier's frontmatter `tools` is capped at `Read`/`Glob`/`Grep`/`Bash`. Stage 6.5 is optional/opt-in: the default pipeline never dispatches it, so default `/orchestrate` cost is unchanged. Fail-open SKIP is a first-class outcome (skip ≠ failure).

## FRAMEWORK_CONVENTIONS

Framework-specific rules have a **two-tier precedence model:**

1. **User skill (primary):** If `~/.claude/skills/react-conventions/` exists, read its `SKILL.md` and `reference/review-checklist.md` — these take precedence over the plugin digest.
2. **Plugin digest (offline fallback):** `packages/orchestra/conventions/react.md` and `packages/orchestra/conventions/react-review-checklist.md` — thin pointers containing only the P0/CRITICAL anti-pattern digest.

| Convention | Trigger | Primary source | Fallback |
|------------|---------|----------------|---------|
| React 19+ / Next.js 15+ / TS | `.tsx`, `.jsx`, React hooks, App Router | `~/.claude/skills/react-conventions/SKILL.md` + `reference/review-checklist.md` | [`packages/orchestra/conventions/react.md`](packages/orchestra/conventions/react.md) + [`packages/orchestra/conventions/react-review-checklist.md`](packages/orchestra/conventions/react-review-checklist.md) |

**Agent contracts:**
- **Craftsman** checks for `~/.claude/skills/react-conventions/` first; falls back to plugin `packages/orchestra/conventions/react.md`; self-checks against P0 anti-patterns before reporting
- **Sentinel** checks for the user-skill review checklist first; falls back to plugin digest; maps findings to P0-P3 with explicit rule citation
- **Architect** decides framework-specific boundaries (Server vs Client, data layer, state ownership) at plan time; references user-skill if present

**Adding a new convention:**
1. Create `packages/orchestra/conventions/<framework>.md` (rules) and optionally `packages/orchestra/conventions/<framework>-review-checklist.md`
2. Register the trigger in the Framework Conventions table of:
   - `packages/orchestra/agents/craftsman.md` (editing behavior)
   - `packages/orchestra/agents/sentinel.md` (review behavior + severity mapping)
   - `packages/orchestra/agents/architect.md` (planning behavior)
3. Extend skills if applicable:
   - `packages/orchestra/skills/deep-review/SKILL.md` — add a framework-specific depth level + checklist entry under "Framework Conventions"
   - `packages/orchestra/skills/deep-plan/SKILL.md` — add a framework-aware planning subsection
4. Update the `/parallel` command (`packages/orchestra/commands/parallel.md`) scout triggers if the framework needs routing through parallel execution
5. Update this `FRAMEWORK_CONVENTIONS` section and the "Framework conventions" section of `packages/orchestra/README.md`

## TEST_STRATEGY

- Sentinel review is the primary quality gate
- Tests run after each execution phase
- Fix-review loop limited to 2 cycles to prevent infinite loops
- Integration verification after parallel craftsman work

## 2026-06-12 upgrade

Summary of all changes from the R1–R10 upgrade batch:

**R1 — Workflow hybrid (`/parallel`, `/ralph`, orchestrate skill):** Scale decision added — ≤8 independent tasks use prompt-driven craftsman dispatch; >8 tasks or repeatable batch (audits, migrations, codemods) generate a Workflow script (`pipeline()`, schema-validated outputs, worktree isolation, saved to `.claude/workflows/`). Ralph gets semantic completion: early exit when verify emits `<promise>DONE</promise>` AND tests pass; MAX_ITERATIONS=8 remains the hard backstop.

**R2 — Worktree isolation:** Executor and `/parallel` use `isolation: "worktree"` for parallel mutating craftsmen in git repos. Merges handled by executor after completion (report conflicts, never force). File-lock protocol is now the fallback for non-git dirs only. jq-missing is a visible warning, never a silent no-op.

**R3 — Audit trail + quality-gate hooks:** Two new hook events added to the orchestra plugin's `.claude-plugin/plugin.json` (total: 9 hook events registered by `orchestra`; this predates the split into `packages/orchestra` + `packages/orchestra-memory` — see "Monorepo Layout" above for the current per-package hook breakdown). `SubagentStart`/`SubagentStop` → `packages/orchestra/scripts/subagent-log.sh` appends JSONL to `.claude/orchestra-log.jsonl`. `TaskCompleted` → `packages/orchestra/scripts/taskcompleted-gate.sh` exits 2 (blocks completion) only when boulder has `"gate": "sentinel"` — fail-open by default.

**R4 — SendMessage retry:** First retry is SendMessage to the same craftsman agentId with failure details. Fresh spawn only on second failure. Max 2 retries total unchanged.

**R5 — Model tiering update:** Sentinel downgraded from opus to sonnet (structured checklist review doesn't need full reasoning). Conductor may now run as `inherit`. All spawn instructions require passing `model` explicitly in the Agent tool call (frontmatter may be ignored).

**R6 — Background recon:** Scout + scholar reconnaissance may be spawned with `run_in_background: true` while conductor prepares; results collected on notification.

**R7 — Wisdom schema v2:** Entries are objects `{text, ts, confidence, source}`. Readers tolerate legacy plain strings. `/wisdom show` groups by confidence and flags entries >90 days old. Boulder saves include `instance` field (cwd-derived); `session-start.sh` only announces boulders matching the current cwd instance.

**R8 — Ralph semantic completion:** See R1. `<promise>DONE</promise>` tag is the early-exit signal; fragility documented.

**R9 — Fragility fixes:** jq-missing produces visible warnings in all scripts. Boulder restore on hash mismatch requires explicit user confirmation before recreating tasks. `deep-plan` skill references architect's plan template section instead of duplicating it.

**R10 — Conventions sync:** `packages/orchestra/conventions/react.md` and `packages/orchestra/conventions/react-review-checklist.md` are now thin pointers (~20 lines each) containing only the P0 digest. User-level skill `~/.claude/skills/react-conventions/` takes precedence; plugin files are offline fallback. All three agents (craftsman, sentinel, architect) updated to check user skill first.

## 2026-07-04 upgrade

Added the optional end-to-end **verifier** agent — the plugin's 8th agent (sonnet, orange, Execution layer alongside craftsman + sentinel) — as pipeline stage 6.5. It is opt-in only, triggered via `--verify` or conductor's web-facing judgment; the default pipeline never dispatches it, so default `/orchestrate` cost and behavior are unchanged. Verifier findings rated P0/P1 feed into the existing max-2-cycle fix loop unchanged; anything below that, or an environment where verification can't run, resolves to a fail-open SKIP (skip ≠ failure). Browser automation (Playwright) tools are discovered via ToolSearch at runtime and are never pre-attached in frontmatter — verifier's declared `tools` stay capped at `Read`/`Glob`/`Grep`/`Bash`, matching the sentinel-is-read-only-but-verifier-needs-Bash rationale in ARCH_DECISIONS.

Added the `verify` skill (bilingual EN/CS triggers, routes to the verifier agent) and the clean-room `systematic-debugging` skill (4-phase root-cause protocol — trace the root cause, analyze related systems, form one hypothesis, test that one fix) now wired into craftsman's Error Recovery section and `/ralph` Step 3. Existing hard limits are unchanged by this addition: `STUCK_LIMIT=2`, `MAX_ITERATIONS=8`, and the max-2-attempt retry ceiling all still apply. `systematic-debugging` is attributed to obra/superpowers (MIT license).

`plugin.json` bumped `2.3.0` → `2.4.0` to reflect the new agent and skills.
