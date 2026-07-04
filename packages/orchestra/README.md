# Orchestra — Multi-Agent Orchestration Plugin for Claude Code

A native Claude Code plugin that replicates the multi-agent workflow from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It provides a 3-layer architecture with 8 specialized agents, a staged pipeline with quality gates, file claiming, wisdom accumulation, and session persistence.

**Works fully standalone.** Cross-project graph memory is provided by the separate, optional companion plugin [`orchestra-memory`](../orchestra-memory/README.md). When it isn't installed, Orchestra falls back transparently to a legacy per-project `.claude/orchestra-wisdom.json` file — nothing breaks, nothing needs configuring.

## Install

Claude Code plugins install through the marketplace system.

```bash
# 1. Register the marketplace (once)
claude plugin marketplace add <marketplace-source> --scope user

# 2. Install the plugin
claude plugin install orchestra@<marketplace-name>

# 3. Verify
claude plugin list
```

Use `--scope project` to install into a single project instead of user-wide. See the [root README](../../README.md#install) for the full marketplace source syntax and the three supported install permutations (orchestra alone, orchestra-memory alone, or both together).

Once installed, the plugin runs in the background — there is nothing to configure. If you also install `orchestra-memory`, Orchestra automatically discovers its tools via ToolSearch and starts using graph memory instead of the legacy JSON file; if you later uninstall it, Orchestra falls back to the JSON file again without any action on your part.

## What it looks like in practice

### A complex feature (full pipeline)

```
> /orchestrate Implement a discount-coupon system — database schema,
  REST API, validation logic, and a frontend form
```

What happens:

1. **Conductor** assesses complexity and classifies the intent as `complex`.
2. **Scout** and **scholar** run in parallel — scout explores the codebase (models, API patterns, frontend components), scholar pulls documentation for the relevant libraries.
3. **Architect** takes those findings and proposes a phased plan:
   - Phase 1: DB migration + model
   - Phase 2: API endpoints + validation
   - Phase 3: Frontend form
   - Each phase lists which files it owns.
4. **The plan is shown to you for approval** — you can edit, approve, or discard it.
5. **Executor** takes the approved plan and dispatches **craftsmen** in parallel:
   - Craftsman A: DB schema (OWNS `src/db/*`, MUST NOT MODIFY `src/api/*`)
   - Craftsman B: API endpoints (OWNS `src/api/*`, MUST NOT MODIFY `src/db/*`)
   - Craftsman C: once A+B are done → frontend form
6. **Sentinel** reviews all changes — reports only issues at 80%+ confidence:
   ```
   ## Code Review Report
   ### Summary: PASS WITH NOTES

   ### Important (P1)
   - [ ] src/api/coupons.ts:42 — missing rate limiting (confidence: 85%)

   ### Positive Notes
   - Good input validation at the system boundary
   - Consistent error handling
   ```
7. If there are P0/P1 issues: craftsman fixes them, sentinel re-reviews (max 2 cycles).
8. Final report: what changed, which files, learnings saved to wisdom.

### Planning only (no implementation)

```
> /plan Migrate from Express to the Hono framework
```

1. **Scout** explores the current Express code — routes, middleware, error handling.
2. **Scholar** pulls Hono documentation via Context7.
3. **Architect** produces a migration plan with phases, risks, and a rollback strategy.
4. A structured plan comes back; no code changes yet.

When you're ready to act on it:
```
> Implement this plan
```
Conductor/executor takes over execution.

### Parallel work

```
> /parallel Add rate limiting to the API | Implement a health-check endpoint | Add request logging middleware
```

1. **Scout** quickly identifies the files touched per task.
2. File ownership is assigned — no overlap.
3. Three **craftsmen** run concurrently, each with an explicit list of what it may and may not edit; in a git repo each gets its own worktree (`isolation: "worktree"`).
4. A consolidated report follows once all three finish.

**Scale decision:** ≤8 tasks → prompt-driven craftsman dispatch (above). >8 tasks, or a repeatable batch (audits, migrations, codemods) → a Workflow script is generated instead (`pipeline()`, schema-validated outputs, saved to `.claude/workflows/`). Nothing is silently skipped — anything that doesn't get done is reported.

### Code review

```
> /review
```

Automatically takes the `git diff`, runs **sentinel**, and returns a structured report:

```
## Code Review Report
### Summary: NEEDS CHANGES

### Critical (P0)
- [ ] src/auth.ts:42 — SQL injection in a user query (confidence: 98%)
  - Why: User input is interpolated directly into SQL
  - Suggestion: Use a parameterized query

### Important (P1)
- [ ] src/api/routes.ts:118 — Missing rate limiting on /login (confidence: 87%)

### Positive Notes
- Good separation of concerns in the service layer
```

Just say "fix the P0 issues" and craftsman fixes them. Sentinel re-checks afterward.

### Batch operations (Ralph Loop)

```
> /ralph Fix all ESLint warnings
```

An iterative cycle: take a warning → fix it → verify → next. Max 8 iterations, automatically skips anything that can't be fixed.

The cycle can also end early (semantic completion) if a verify step returns `<promise>DONE</promise>` AND tests/lint pass — remaining iterations are skipped at that point. `MAX_ITERATIONS=8` always remains as a safety net.

### Session persistence (long-running project)

Working on a large refactor and need to step away:

```
> /boulder save
```

Saves state — phase, tasks, file hashes, wisdom — to `.claude/orchestra-boulder.json`. The boulder also carries an `instance` field derived from the working directory, so session-start only announces boulders belonging to the current project (no cross-talk between two concurrent Claude Code instances).

Next time you open Claude Code, you'll automatically see:

```
Orchestra: Found existing orchestration state. Phase: execution, Tasks: 5/12 completed.
Accumulated wisdom: 8 entries. Use /status to see full details or continue where you left off.
```

```
> /boulder restore
```

Validates that the files haven't changed (compares git hashes), restores the tasks, and suggests next steps. If something has changed, restore **lists the mismatched files and requires explicit confirmation** before overwriting tasks — never a blind restore.

### Wisdom — learning from the work

```
> /wisdom show
```

```
## Accumulated Wisdom

### High Confidence (2 entries)
- Always use path aliases — never relative ../../ imports — source: session-abc, 2026-05-01
- zod schemas next to the route handler — source: user, 2026-06-01

### Medium Confidence (2 entries)
- prisma needs regeneration after every schema change — source: session-xyz, 2026-04-10
- NextAuth session callback must return full user object — source: session-xyz, 2026-01-05 ⚠️ older than 90 days — consider reviewing

### Low Confidence (1 entry)
- Hono over Express — 3x faster cold start, same API surface — source: session-abc, 2025-12-01 ⚠️ older than 90 days — consider reviewing

### Unclassified / Legacy (1 entry)
- barrel exports in every module index.ts
```

Wisdom schema v2 — every entry is an object `{text, ts, confidence, source}`. Older plain-string entries are shown under "Unclassified / Legacy". Entries older than 90 days are flagged ⚠️ for review. These learnings are passed automatically to craftsman agents and survive a context-window compaction.

**Primary path vs. legacy fallback.** If the [`orchestra-memory`](../orchestra-memory/README.md) companion plugin is installed, `/wisdom`, `/status`, executor, and conductor discover its `wisdom_get`/`wisdom_add` MCP tools via ToolSearch and use them first — this is what upgrades wisdom from a single project's JSON file into a cross-project graph with temporal validity and `global`/`project`/`private` scoping. If those tools can't be found (plugin not installed, Node < 22.5, or the bundle isn't built), every command and agent that touches wisdom falls back to reading/writing `.claude/orchestra-wisdom.json` directly — the exact behavior this plugin had before graph memory existed. This fallback is automatic; you don't need to configure anything, and running `orchestra` without `orchestra-memory` is fully supported.

To set up or migrate into graph memory once `orchestra-memory` is installed, see its own README's `/memory-setup` and `/memory-migrate` commands.

### Natural language (no slash commands needed)

The plugin also activates automatically through skills — you don't have to use slash commands:

```
> I need to refactor the whole authentication module, split it into phases
  and coordinate the work across agents
```

Conductor activates on its own, recognizing a multi-agent orchestration need.

```
> Check all the changes we've made
```

Sentinel runs automatically via the deep-review skill.

## Which command for which job

| Situation | Command |
|---|---|
| Complex feature/refactor | `/orchestrate <description>` |
| Want a plan, not code | `/plan <description>` |
| Independent tasks in parallel | `/parallel t1 \| t2 \| t3` |
| Code review | `/review` |
| Repeated fixes (lint, tests) | `/ralph <description>` |
| Save state for next time | `/boulder save` |
| Restore from a previous session | `/boulder restore` |
| View learnings | `/wisdom show` |
| Check where things stand | `/status` |
| Set up graph memory (once) | `/memory-setup` (requires `orchestra-memory`) |
| Migrate old memories into the graph | `/memory-migrate` (requires `orchestra-memory`) |
| A simple task | Just say what you want (no orchestration needed) |

---

## How it works under the hood

### Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                             PLANNING LAYER                             │
│           scout (haiku) + scholar (haiku) + architect (opus)           │
├───────────────────────────────────────────────────────────────────────┤
│                          ORCHESTRATION LAYER                           │
│               conductor (inherit/opus) + executor (opus)               │
├───────────────────────────────────────────────────────────────────────┤
│                            EXECUTION LAYER                             │
│  craftsman (sonnet) + sentinel (sonnet) + verifier (sonnet, optional)  │
└───────────────────────────────────────────────────────────────────────┘
```

### The 8 agents

| Agent | Model | oh-my-openagent counterpart | Role |
|---|---|---|---|
| **conductor** | inherit/opus (blue) | Sisyphus | Orchestrator — intent classification, decomposition, delegation; may run as `inherit` |
| **architect** | opus (cyan) | Prometheus | Strategic planner — read-only, plans with explicit file ownership |
| **executor** | opus (green) | Atlas | Coordinator — file claiming, parallel dispatch, wisdom |
| **craftsman** | sonnet (green) | Hephaestus | Worker — OWNS/MUST NOT MODIFY, explore → implement → verify |
| **sentinel** | sonnet (red) | Momus | Reviewer — 80%+ confidence filtering, P0-P3, read-only; a structured checklist review doesn't need full opus |
| **verifier** | sonnet (orange) | — | Optional E2E verifier — stage 6.5, Playwright MCP via ToolSearch, fail-open SKIP, read-only + Bash; never in the default pipeline |
| **scout** | haiku (yellow) | Explore | Explorer — read-only, structured report |
| **scholar** | haiku (magenta) | Librarian | Researcher — Context7, web, read-only |

### Staged pipeline

```
[Assessment] → classify intent (quick/standard/complex/research/review)
      ↓
[Reconnaissance] → scout + scholar (parallel)
      ↓
[Planning] → architect produces plan with file ownership (complex only)
      ↓ quality gate: user approves plan
[Specification] → tasks + file claiming + acceptance criteria
      ↓ quality gate: spec complete
[Execution] → executor dispatches craftsmen (max 5-8 parallel)
      ↓ quality gate: all tasks done
[Validation] → sentinel review (80%+ confidence)
      ↓ quality gate: no P0/P1
[6.5 Verification] (optional — opt-in via --verify or conductor web-facing judgment; skipped by default)
      ↓ gate: verifier PASS/PASS WITH NOTES or SKIP (skip is not a failure)
[Fix Loop] → craftsman fixes → sentinel re-review (max 2 cycles)
      ↓
[Completion] → extract wisdom, report
```

### Intent classification

Conductor automatically classifies every task — you don't have to do this manually:

| Intent | Pipeline | When |
|---|---|---|
| `quick` | Direct fix, no agents | One file, clear change |
| `standard` | scout → craftsman → sentinel | Multi-file, straightforward |
| `complex` | Full staged pipeline | Cross-cutting, high risk |
| `research` | scout + scholar | Understanding only, no changes |
| `review` | sentinel | Code review only |

### File claiming

During parallel work, every craftsman gets explicit ownership:
```
Craftsman A: OWNS [src/api/*]         MUST NOT MODIFY [src/frontend/*]
Craftsman B: OWNS [src/frontend/*]    MUST NOT MODIFY [src/api/*]
```
A `PreToolUse` hook automatically warns on an attempt to edit a file outside a craftsman's ownership.

### Confidence-based review

Sentinel reports only issues at 80%+ confidence:
- 95-100%: definite bug/vulnerability → P0
- 80-94%: very likely → P1/P2
- 60-79%: possible → P3, observations only
- <60%: not reported

### Error recovery

| Failure | Action | Limit |
|---|---|---|
| Craftsman fails | 1st retry: SendMessage to the same craftsman agentId with details; 2nd retry: fresh spawn with accumulated context | Max 2 retries total |
| Plan insufficient | Architect re-plans the section | Max 2 replans |
| Sentinel rejects | Craftsman fixes P0/P1 | Max 2 fix cycles |
| Repeated failure | Escalate to the user | Once the limit is reached |

### Hooks

| Event | Script | Role |
|---|---|---|
| **SessionStart** | `session-start.sh` | Loads boulder state + wisdom from the previous session; announces only boulders matching the current instance (cwd) |
| **PreToolUse (Edit/Write)** | `pretooluse-guard.sh` | File-ownership guard — warns on editing a file outside ownership; missing `jq` = a visible warning |
| **PostToolUse (Edit/Write)** | `track-progress.sh` | Tracks changed files in boulder state |
| **PostCompact** | `post-compact.sh` | Re-injects orchestration context after a context-window compaction; tolerates both v2 wisdom objects and legacy strings |
| **Stop** | `validate-completion.sh` | Warns if there are unfinished tasks |
| **Notification** | `notify.sh` | Orchestration notifications |
| **SubagentStart** | `subagent-log.sh` | Writes a JSONL entry (ts, event, agent_type, session) to `.claude/orchestra-log.jsonl` |
| **SubagentStop** | `subagent-log.sh` | Writes a JSONL entry when a sub-agent finishes |
| **TaskCompleted** | `taskcompleted-gate.sh` | Opt-in sentinel gate: blocks completion (exit 2) only when the boulder has `"gate": "sentinel"`; otherwise exit 0 |

This plugin ships **no `.mcp.json`** and holds no reference to the `orchestra-memory` MCP server or its `mcp-server/` directory — the two plugins are decoupled entirely through separate, per-plugin hooks. See the [root README](../../README.md#soft-companion-relationship) for how that decoupling works.

### Graph memory (optional companion)

Everything above works with just this plugin installed. If [`orchestra-memory`](../orchestra-memory/README.md) is also installed, Orchestra's agents and commands discover its tools (`memory_save`, `memory_search`, `memory_link`, `memory_traverse`, `memory_inspect`, `memory_invalidate`, `memory_stats`, `wisdom_get`, `wisdom_add`) via ToolSearch at runtime — they are not pre-attached, so nothing errors if they're missing. `executor`, `conductor`, and `commands/wisdom.md` call the primary MCP path first and fall back to `.claude/orchestra-wisdom.json` on any failure to locate or call a tool. `scout`, `craftsman`, `scholar`, `sentinel`, and `architect` have a lighter "Memory access" section for read-only lookups.

`skills/memory-discipline/SKILL.md` defines the write-discipline (when to save, how to distill, which scope, anti-spam limits) that any agent should follow before calling `memory_save`/`wisdom_add` — this applies whether or not `orchestra-memory` happens to be installed in a given session, since the skill degrades to a no-op if the tools aren't found.

For the server's own architecture — SQLite storage, scoping rules, temporal validity, the MCP tool surface, `/memory-setup`/`/memory-migrate`, and the daily `graph.db` backup — see the [`orchestra-memory` README](../orchestra-memory/README.md).

### Skills (automatic activation)

Triggers are bilingual (EN/CS) — each skill's frontmatter lists English phrases alongside their Czech equivalents (e.g. "orchestrate"/"orchestruj", "review"/"zkontroluj") so activation works the same regardless of which language the user is speaking. The table below shows a representative sample; see each `SKILL.md` frontmatter for the full list.

| Skill | Trigger |
|---|---|
| **orchestrate** | "orchestrate"/"orchestruj", "multi-agent", "split up the work"/"rozděl práci", 3+ files cross-cutting |
| **deep-plan** | "design"/"navrhni architekturu", "plan this"/"naplánuj", "design this", "migration strategy"/"migrační plán" |
| **deep-review** | "review"/"zkontroluj", "check this"/"prověř", "audit", "security review" |
| **verify** | "verify"/"ověř", "smoke test", "e2e"/"otestuj E2E", "run it and check"/"zkus jestli to funguje" |
| **systematic-debugging** | "root cause"/"najdi příčinu", "debug systematically"/"debuguj systematicky", "why does this keep failing"/"proč to pořád padá" |
| **skill-extract** | Post-workflow pattern extraction |

### Framework conventions

Framework rules follow a **two-tier precedence model:**

1. **User skill (primary):** if `~/.claude/skills/react-conventions/` exists, agents load its `SKILL.md` and `reference/review-checklist.md` — these take precedence over the plugin digest.
2. **Plugin digest (offline fallback):** `conventions/react.md` and `conventions/react-review-checklist.md` are thin pointers (~20 lines) containing only the P0/CRITICAL anti-pattern digest.

| Convention | Trigger | Primary source | Fallback |
|---|---|---|---|
| **React 19+ / Next.js 15+ / TypeScript** | `.tsx`, `.jsx`, hooks, App Router | `~/.claude/skills/react-conventions/SKILL.md` + `reference/review-checklist.md` | `conventions/react.md` + `conventions/react-review-checklist.md` |

**Behavior:**
- **Craftsman** checks the user skill first; if it doesn't exist, loads the plugin fallback. Self-checks P0 anti-patterns before reporting.
- **Sentinel** loads the user-skill checklist first; fallback = plugin digest. Every P0 violation = Critical, P1-P3 mapped per the checklist.
- **Architect** explicitly decides in the plan: Server vs Client components, the data layer (RSC / TanStack Query / Server Action), and state ownership (URL / server / context / local).

To add a framework of your own: create `conventions/<framework>.md` + a checklist, register the trigger in `agents/craftsman.md`, `agents/sentinel.md`, `agents/architect.md`. See `AGENTS.md → FRAMEWORK_CONVENTIONS` (in the repo root).

## Plugin structure

```
orchestra/
├── .claude-plugin/
│   └── plugin.json              # Manifest — 9 hook events, no .mcp.json
├── agents/
│   ├── conductor.md             # Orchestrator with intent classification
│   ├── architect.md             # Planner with file ownership
│   ├── executor.md              # Coordinator with file claiming + wisdom
│   ├── craftsman.md             # Worker with OWNS/MUST NOT MODIFY
│   ├── sentinel.md              # Reviewer with confidence filtering (sonnet)
│   ├── verifier.md              # E2E verifier — optional stage 6.5 (sonnet)
│   ├── scout.md                 # Explorer (read-only)
│   └── scholar.md                # Researcher (read-only, Context7 fallback)
├── commands/
│   ├── orchestrate.md           # /orchestrate — staged pipeline
│   ├── plan.md                  # /plan
│   ├── review.md                # /review
│   ├── parallel.md              # /parallel — scale decision + file ownership
│   ├── ralph.md                 # /ralph — iterative batch + semantic completion
│   ├── boulder.md                # /boulder — instance field + restore confirmation
│   ├── wisdom.md                 # /wisdom — primary MCP path (wisdom_get/wisdom_add) + legacy fallback
│   ├── status.md                 # /status
│   ├── memory-setup.md           # /memory-setup — onboarding (requires orchestra-memory)
│   └── memory-migrate.md         # /memory-migrate — dry-run → confirm → import (requires orchestra-memory)
├── skills/
│   ├── orchestrate/SKILL.md      # Staged pipeline + scale decision
│   ├── deep-plan/SKILL.md        # Planning with file ownership
│   ├── deep-review/SKILL.md      # Review with confidence filtering
│   ├── verify/SKILL.md           # Playwright MCP E2E verification (stage 6.5)
│   ├── systematic-debugging/SKILL.md # Root-cause debugging methodology
│   ├── skill-extract/SKILL.md    # Post-workflow pattern extraction
│   └── memory-discipline/SKILL.md # Write-discipline for orchestra-memory (WHEN/HOW/SCOPE/anti-spam)
├── conventions/                  # Framework-specific rules — thin pointers
│   ├── react.md                  # P0 digest; points to ~/.claude/skills/react-conventions/
│   └── react-review-checklist.md # P0/CRITICAL digest; points to the user skill
├── scripts/
│   ├── session-start.sh          # SessionStart — boulder (instance-scoped) + wisdom load
│   ├── pretooluse-guard.sh       # PreToolUse — file-ownership guard
│   ├── track-progress.sh         # PostToolUse — progress tracking
│   ├── post-compact.sh           # PostCompact — context re-injection (wisdom summary)
│   ├── validate-completion.sh    # Stop — completion validation
│   ├── notify.sh                 # Notification handler
│   ├── subagent-log.sh           # SubagentStart/Stop → .claude/orchestra-log.jsonl
│   └── taskcompleted-gate.sh     # TaskCompleted → opt-in sentinel gate
└── README.md
```

Note: `memory-setup` and `memory-migrate` are listed here because they ship with this plugin's `commands/`, but both are no-ops (with a clear message) unless the `orchestra-memory` companion plugin is also installed — see that plugin's README for what they actually do.

## Inspiration and sources

Adopts core concepts from:
- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) — 3-layer architecture, wisdom accumulation, the boulder system
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — native multi-agent coordination
- [Specification-Driven Development](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/) — preventing the 41.8% failure rate of vague specs
- [Agent Farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) — file-system coordination
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) — staged pipeline pattern
- [obra/superpowers](https://github.com/obra/superpowers) — systematic-debugging methodology (clean-room adaptation, MIT © 2025 Jesse Vincent)
- [playwright-skill](https://github.com/lackeyjb/playwright-skill) — browser-driven E2E verification pattern

## License

MIT — see [LICENSE](../../LICENSE) in the repo root.
