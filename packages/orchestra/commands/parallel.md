---
name: parallel
description: Execute multiple tasks in parallel using craftsman agents with file ownership
argument-hint: <task1> | <task2> | <task3>
---

# Parallel Execution Mode

Execute multiple independent tasks simultaneously using craftsman agents with explicit file ownership.

## Input
Tasks separated by `|`: `$ARGUMENTS`

## Protocol

### Step 1: Parse Tasks
Split the input by `|` to get individual task descriptions.

### Step 2: Reconnaissance
Run a quick **scout** to identify which files each task will likely touch. This is critical for file claiming.

Scout must **also flag framework triggers** — for every task, note if its OWNS files match any registered `conventions/*.md` trigger (e.g. `.tsx`/`.jsx` → `conventions/react.md`). The canonical registry of triggers lives in `AGENTS.md` → `FRAMEWORK_CONVENTIONS`.

### Step 3: Validate Independence & Assign File Ownership
For each task:
1. Identify files it needs to modify
2. Check for overlapping files between tasks
3. If overlap exists: warn user, suggest sequential execution for conflicting tasks
4. Assign file ownership:

```
Craftsman 1: OWNS [files for task 1] / MUST NOT MODIFY [files for tasks 2, 3]
Craftsman 2: OWNS [files for task 2] / MUST NOT MODIFY [files for tasks 1, 3]
Craftsman 3: OWNS [files for task 3] / MUST NOT MODIFY [files for tasks 1, 2]
```

**Worktree isolation (git repos):** When launching parallel craftsmen that mutate files in a git repo, dispatch each with `isolation: "worktree"` so every agent works in its own isolated git worktree. Merge mechanics (conflict detection, user notification, no forced merges) are handled by the executor after all craftsmen complete — see `agents/executor.md` for details; do not duplicate that logic here.

OWNS/MUST-NOT-MODIFY remain semantic discipline in all cases — they define intent and prevent accidental cross-task edits regardless of isolation mode.

**File-lock protocol** (legacy / fallback): The `scripts/pretooluse-guard.sh` lock mechanism is a fallback for **non-git directories only**. In a git repo with worktrees active, file locks are redundant and should not be used.

### Step 4: Launch Craftsmen
For each task, spawn a **craftsman** agent in parallel using the Agent tool. Each craftsman receives:
- Its specific task description
- **OWNS**: files it may modify
- **MUST NOT MODIFY**: files owned by other craftsmen
- Conventions from the codebase (read wisdom if available)
- **Applicable framework conventions** — explicitly cite every `conventions/*.md` file whose trigger matches the OWNS list (e.g. `conventions/react.md` when OWNS contains `*.tsx`/`*.jsx`). Pass these as hard constraints, not hints.
- What other craftsmen are working on (awareness, not coordination)
- **The report protocol**: write the full Craftsman Report to `.claude/orchestra/reports/<task-id>.md` and return only the ≤5-line summary (STATUS, one-sentence outcome, files changed, report path, needs-from-other-agents if any)

**IMPORTANT:** Launch ALL craftsman agents in a single message with multiple Agent tool calls to ensure true parallel execution.

**Hard limit: Max 5-8 parallel craftsmen.** If more tasks, batch them.

### Step 5: Collect Results
As craftsmen complete, verify from their ≤5-line summaries — do NOT read a report file for a DONE task:
- What each accomplished
- Files changed by each
- Any needs from other agents (files outside ownership that need changes)

Read `.claude/orchestra/reports/<task-id>.md` only when a task is PARTIAL/BLOCKED or a cross-cutting need flagged in the summary must be resolved.

### Step 6: Integration Check
After all craftsmen complete:
- Verify no conflicting changes (file ownership should prevent this)
- Handle any cross-cutting needs flagged by craftsmen
- Run tests if available
- Report overall status

## Example
```
/parallel Implement user registration form | Create registration API endpoint | Write registration validation tests
```

Scout identifies:
- Task 1 → `src/components/RegistrationForm.tsx`
- Task 2 → `src/api/routes/auth.ts`, `src/api/handlers/register.ts`
- Task 3 → `src/__tests__/registration.test.ts`

No overlap → 3 craftsmen launched in parallel with explicit file ownership.

## Scale decision

Choose the dispatch strategy based on task count and repeatability:

| Situation | Strategy |
|-----------|----------|
| ≤ 8 independent tasks | **Prompt-driven craftsman dispatch** (current flow above) |
| > 8 tasks, OR repeatable batch (audits, migrations, codemods) | **Workflow script** — see below |

### When to generate a Workflow script
If the task list exceeds 8 items, or the work is a repeatable fan-out pattern (e.g. "run this codemod over 40 files", "audit every route handler"), generate a Workflow script instead of dispatching craftsmen by hand:

- Use `pipeline()` over the work-list with `isolation: "worktree"` for each mutating agent step
- Define schema-validated outputs so each step's result is checkable before the next step runs
- Save the generated script to `.claude/workflows/<task-name>.js` so it can be re-run without re-prompting

**Trade-offs:**
- Workflow scripts have higher upfront token cost (generation + schema definitions) but lower per-run cost on repetition
- Prompt-driven dispatch is more reviewable interactively (3–8 agents); workflows are better for headless / CI fan-out
- Workflow scripts are deterministic and auditable; prompt-driven dispatch is more adaptive to surprises mid-run

**No silent caps:** The runtime caps concurrency at ~16 concurrent agents and ~1000 total agents per session. If a workflow would exceed these limits, the orchestrator **must** surface which items were dropped or deferred in the report — never silently omit work items.

### Prompt-driven dispatch (≤ 8 tasks)
Continue with the standard Steps 4–6 above.

## Rules
- Always scout first to identify file ownership
- Never launch craftsmen without file ownership assignments
- Max 5-8 parallel craftsmen (prompt-driven); use Workflow script above threshold
- If tasks share files, run them sequentially
