---
name: orchestrate
description: |
  Multi-agent orchestration skill. Use when the user needs complex, multi-step work that benefits from specialized agent coordination.

  Trigger when the user says: "orchestrate", "orchestruj", "coordinate agents", "koordinuj agenty", "multi-agent", "rozděl práci", "rozděl na fáze", "full pipeline", "plán + implementace + review".

  Also trigger proactively when:
  - Task touches 3+ files across different concerns (frontend + backend + DB)
  - Task requires both planning and implementation phases
  - Work explicitly needs parallel execution across specialties

  Do NOT trigger for:
  - Single file edits, simple bug fixes, quick questions
  - Pure code review (use deep-review instead)
  - Pure planning without implementation (use deep-plan instead)
  - Documentation or research tasks
version: 2.0.0
---

# Multi-Agent Orchestration Skill

This skill provides the orchestration framework for coordinating multiple specialized agents on complex tasks.

## Staged Pipeline (plan → spec → execute → verify → fix)

The full orchestration follows a staged pipeline with quality gates between each stage:

```
[1. Assessment]
     ↓ gate: classify intent (quick/standard/complex/research/review)
[2. Reconnaissance]
     ↓ gate: do we understand the codebase sufficiently?
[3. Planning] (complex only)
     ↓ gate: user approves plan
[4. Specification]
     ↓ gate: spec exists with clear tasks, file ownership, acceptance criteria
[5. Execution]
     ↓ gate: all tasks complete, no crashes
[6. Validation]
     ↓ gate: sentinel PASS or PASS WITH NOTES (no P0/P1)
[7. Fix Loop] (if needed, max 2 cycles)
     ↓ gate: sentinel re-validates fixes
[8. Completion]
     → extract wisdom, report to user
```

**Every gate is a checkpoint.** If a gate fails, address the issue before proceeding. Never skip gates.

## Intent Classification

Before orchestrating, classify:

| Intent | Pipeline | Agents |
|--------|----------|--------|
| `quick` | Direct, no pipeline | none |
| `standard` | scout → craftsman → sentinel | 3 agents |
| `complex` | Full pipeline above | 5-7 agents |
| `research` | scout + scholar | 2 agents |
| `review` | sentinel | 1 agent |

## 3-Layer Architecture

### Layer 1: Planning
**Agents:** scout (reconnaissance) + scholar (research) + architect (design)

The planning layer ensures we understand the codebase and have a solid plan before writing any code.

**Flow:**
1. Scout explores the relevant codebase — may be spawned with `run_in_background: true` while the conductor classifies intent and prepares the execution plan in parallel; collect results when notified
2. Scholar researches any external APIs/libraries needed — likewise may run with `run_in_background: true` alongside scout; results collected on notification
3. Architect synthesizes findings into an execution plan

### Layer 2: Orchestration
**Agents:** conductor (overall) + executor (implementation coordination)

The orchestration layer manages execution — breaking the plan into parallel work streams with file ownership, tracking progress, and handling blockers.

**Flow:**
1. Conductor validates the plan and classifies intent
2. Executor breaks plan phases into atomic tasks with file claiming
3. Executor dispatches craftsmen with OWNS/MUST NOT MODIFY lists
4. Progress tracked via TaskCreate/TaskUpdate

### Layer 3: Execution
**Agents:** craftsman (implementation) + sentinel (review)

**Flow:**
1. Craftsman agents implement assigned tasks (respecting file ownership)
2. Each craftsman: explore → implement → self-verify → report
3. Sentinel reviews all changes (80%+ confidence filtering)
4. P0/P1 issues → craftsman fixes (max 2 cycles)

## Specification-Driven Development

**Before any craftsman is spawned, a specification MUST exist.** The spec includes:
- Clear task description with acceptance criteria
- File ownership (OWNS / MUST NOT MODIFY per craftsman)
- Conventions to follow (from scout + wisdom)
- Dependencies between tasks

"Vague specs multiply errors across the entire fleet. Precise specs multiply into precise implementations."

## File Claiming Protocol

Each parallel craftsman gets explicit ownership:
```
Craftsman A: OWNS [file1, file2] / MUST NOT MODIFY [file3, file4]
Craftsman B: OWNS [file3, file4] / MUST NOT MODIFY [file1, file2]
```

If two tasks need the same file → they run sequentially, never in parallel.

## Parallelization Strategy

**Always parallel:**
- Scout + Scholar (reconnaissance and research)
- Independent craftsman tasks with no shared files
- Multiple scout explorations

**Always sequential:**
- Planning → Execution
- Implementation → Review
- Database/schema → Application code
- Tasks sharing files

## Scale decision

Choose the execution strategy based on task count and work shape:

| Situation | Strategy |
|-----------|----------|
| ≤ 8 independent tasks | **Prompt-driven craftsman dispatch** (standard pipeline above) |
| > 8 tasks, OR repeatable batch (audits, migrations, codemods) | **Workflow script** — see below |

### Prompt-driven dispatch (≤ 8 tasks)
Use the standard 3-layer pipeline. Executor dispatches craftsmen via the Agent tool with explicit OWNS/MUST-NOT-MODIFY lists and (in a git repo) `isolation: "worktree"`.

### Workflow script (> 8 tasks or repeatable batch)
Generate a Workflow script and save it to `.claude/workflows/<task-name>.js`:

- Build a `pipeline()` over the full work-list
- Each mutating agent step uses `isolation: "worktree"` so agents work in isolated git worktrees
- Define schema-validated outputs between steps — validation failures halt the pipeline before propagating bad state
- The script is re-runnable without re-prompting, suitable for CI / headless execution

**Trade-offs:**
- Higher upfront token cost (script generation + schema definitions) vs. lower per-run cost on repetition
- Prompt-driven dispatch is more reviewable during interactive sessions; Workflow scripts are better for large-scale or repeated fan-out
- Workflow execution is deterministic and auditable; prompt-driven is more adaptive when requirements shift mid-run

**No silent caps:** The runtime caps concurrency at ~16 concurrent agents and ~1000 total agents per session. If a Workflow would exceed these limits, the orchestrator **must** surface which items were dropped or deferred — never silently omit work items from the report.

## Wisdom Accumulation

**Primary path — orchestra-memory MCP tools:** these tools aren't pre-attached to agents — locate them first via ToolSearch (query like `select:memory_save,wisdom_add` or keyword `memory`). Read existing wisdom at phase start with `wisdom_get` (`project_id` normally omitted — the server binds to its own project identity at startup). After each phase, persist new learnings with `wisdom_add` — one call per atomic fact, `{text, category, confidence?, scope?}`, tagged with its category (`convention` / `gotcha` / `decision` / `failed_approach`). `scope` defaults to `'project'`; pass `scope: 'global'` only for genuinely cross-project reusable knowledge, or `scope: 'private'` for client-sensitive facts. For richer facts beyond the 4 wisdom categories, use `memory_save` directly. Follow the write-discipline rules in `skills/memory-discipline/SKILL.md` (quality filter, distillation contract, scope selection, anti-spam) before every write.

**Legacy fallback** (mandatory — use when orchestra-memory tools are unavailable, i.e. not found via ToolSearch or the MCP server isn't running): persist to `.claude/orchestra-wisdom.json` instead:
```json
{
  "conventions": ["patterns discovered"],
  "gotchas": ["traps found"],
  "decisions": ["choices made with rationale"],
  "failed_approaches": ["what was tried and why it failed"]
}
```

Wisdom survives context compaction (re-injected by PostCompact hook) and session boundaries — in the graph on the primary path, in the file on the legacy fallback.

## Error Recovery & Circuit Breaker

| Failure | Action | Limit |
|---------|--------|-------|
| Craftsman fails | 1st retry → SendMessage to the same craftsman agentId with failure details; 2nd → fresh spawn with accumulated context | Max 2 retries total |
| Planning gap | Architect replans section | Max 2 replans |
| Sentinel rejects | Craftsman fixes P0/P1 | Max 2 fix cycles |
| Repeated failure | Escalate to user | After hitting any limit |
| Stuck agent | Abort and reassign | No progress after reasonable effort |

**Hard limits:** Max 5-8 parallel craftsmen. Max 2 retries per task.

## Quality Gates

1. **Post-Planning Gate:** Plan reviewed, user approves (complex tasks)
2. **Post-Spec Gate:** Specification exists with file ownership and acceptance criteria
3. **Post-Phase Gate:** All tasks in phase complete, tests pass
4. **Post-Implementation Gate:** Sentinel review passes (no P0/P1 at 80%+ confidence)
5. **Final Gate:** All tests pass, wisdom extracted, user informed
