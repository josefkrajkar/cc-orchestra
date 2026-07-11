---
name: orchestrate
description: Start a multi-agent orchestrated workflow for a complex task
argument-hint: <task description>
---

# Multi-Agent Orchestration Workflow

You are starting a **multi-agent orchestrated workflow**. This is the full staged pipeline inspired by oh-my-openagent's 3-layer architecture.

## Input
The user has provided a task: `$ARGUMENTS`

## Staged Pipeline: plan → spec → execute → verify → fix

### 1. Assessment & Intent Classification (you do this)
Classify the task intent:
- **quick**: Single file, obvious change → handle directly, skip pipeline
- **standard**: Multi-file but straightforward → scout → craftsman → sentinel
- **complex**: Cross-cutting, high risk → full pipeline below
- **research**: Understanding only → scout + scholar
- **review**: Code review only → sentinel

If `quick` or `research` or `review`: handle directly with appropriate agent(s), skip the rest.

### 2. Reconnaissance (standard + complex)
- Spawn **scout** to explore the relevant codebase areas
- If external libraries/APIs involved, spawn **scholar** in parallel
- Wait for findings before proceeding

### 3. Planning (complex only)
- Spawn **architect** with scout/scholar findings
- Architect produces a structured execution plan with:
  - Phased tasks with file ownership (OWNS/MUST NOT MODIFY per task)
  - Parallelization strategy
  - Risk assessment
  - Acceptance criteria per task
- **Quality Gate**: Present plan to user for approval before proceeding

### 4. Specification (standard + complex)
Before dispatching any craftsman, ensure a specification exists:
- Task description with acceptance criteria
- File ownership per craftsman (who modifies what)
- Conventions to follow (from scout findings + wisdom)
- Dependencies between tasks

### 5. Execution
- Spawn **executor** with the specification (pass `model: "sonnet"` explicitly in the Agent call — coordination is mechanical once the plan exists; frontmatter `model:` may be ignored in some Claude Code versions)
- Executor coordinates **craftsman** agents for parallel implementation
- Each craftsman gets OWNS + MUST NOT MODIFY lists
- **Max 5-8 parallel craftsmen**, sized so each wave completes within the ~5-minute prompt-cache TTL
- Track progress via TaskCreate/TaskUpdate
- Executor accumulates wisdom and passes learnings forward by report path, not by quoting report bodies

### 6. Validation
- Spawn **sentinel** to review all changes
- Sentinel reports with 80%+ confidence filtering
- **Quality Gate**: Must pass with no P0/P1 issues

### 6.5 Verification (optional)
This stage is OPTIONAL and is NOT part of the default pipeline. The default pipeline excludes stage 6.5 — it is dispatched only on explicit opt-in or a conductor web-facing judgment, so the default `/orchestrate` run is cost-neutral (verifier is never spawned).

It runs only when:
- (a) explicit opt-in — e.g. a `--verify` flag or the user asks to verify/smoke-test, or
- (b) the conductor judges the change web-facing

When elected, spawn the **verifier** agent (pass `model: "sonnet"` explicitly in the Agent tool call — frontmatter `model:` may be ignored in some Claude Code versions).

Verifier discovers Playwright browser MCP tools via ToolSearch at runtime; if nothing is runnable and no browser tools exist, it emits a SKIP — a SKIP is not a failure and does not block completion.

Verifier P0/P1 findings re-enter the EXISTING Fix Loop (stage 7) — the max-2-fix-cycle limit is unchanged.

### 7. Fix Loop (if sentinel found issues)
- Spawn craftsman for P0/P1 fixes
- Re-run sentinel
- **Max 2 fix-review cycles**
- After 2 cycles: report remaining issues to user

### 8. Completion
- Extract wisdom — primary path: locate orchestra-memory MCP tools via ToolSearch (query like `select:memory_save,wisdom_add` or keyword `memory`), read existing wisdom with `wisdom_get`, then persist new learnings via `wisdom_add` (`{text, category, confidence?, scope?}`, one call per atomic fact; `scope` defaults to `'project'`, use `'global'` only for genuinely cross-project reusable knowledge, or `memory_save` directly for richer facts — see `skills/memory-discipline/SKILL.md` for write discipline). **Legacy fallback** (mandatory when those tools are unavailable, i.e. not found via ToolSearch or the MCP server isn't running): extract wisdom to `.claude/orchestra-wisdom.json` instead
- Summarize what was done
- List all files changed
- Note any remaining concerns or follow-up items

## Rules
- Always classify intent first — don't over-orchestrate simple tasks
- Skip phases that aren't needed (standard skips planning)
- Parallelize: scout + scholar, independent craftsmen
- Never skip validation for non-trivial changes
- Respect hard limits: max 5-8 parallel agents, max 2 retries
- Keep the user informed between phases
- Persist wisdom for future sessions
- The default pipeline never dispatches verifier — stage 6.5 is opt-in only and cost-neutral by default
