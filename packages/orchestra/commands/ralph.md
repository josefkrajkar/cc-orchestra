---
name: ralph
description: Execute a batch of similar tasks iteratively using the Ralph Loop pattern (pick, implement, verify, commit, repeat)
argument-hint: <task type or description>
---

# Ralph Loop — Iterative Batch Execution

Execute a batch of similar, repetitive tasks using the stateless-but-iterative Ralph Loop pattern. Ideal for: lint fixes, test fixes, migration tasks, bulk refactoring.

## Input
Task description: `$ARGUMENTS`

## Protocol

### Step 1: Identify Tasks
Analyze the batch work needed:
- What are all the individual items to fix/change?
- Are they truly independent and similar?
- Create a task list via TaskCreate

### Step 2: Ralph Loop
For each task in the batch, execute this atomic cycle:

```
1. PICK: Select the next pending task
2. IMPLEMENT: Spawn a craftsman to implement the fix
3. VERIFY: Run tests / linter to confirm fix
4. COMMIT: If verify passes, stage the changes (don't commit unless user asked)
5. REPORT: Mark task complete, note any learnings
6. REPEAT: Move to next task
```

### Hard Limits
- **MAX_ITERATIONS = 8** — after 8 tasks, pause and report progress
- **STUCK_LIMIT = 2** — if the same task fails 2 times, skip it and move on
- **TOTAL_FAILURES = 3** — if 3+ tasks fail, stop the loop and report

### Semantic Completion (Early Exit)
The loop also ends early — before reaching MAX_ITERATIONS — when **both** conditions are met:
1. The verify step includes `<promise>DONE</promise>` in its report (signals the craftsman assessed all remaining work as complete)
2. Test/lint verification actually passed for that iteration

When both conditions hold, skip remaining iterations and proceed directly to Step 4: Report.

**Fragility note:** The `<promise>DONE</promise>` tag depends on the craftsman/verify agent emitting it consistently — it may be omitted if the agent doesn't recognise completion or uses different phrasing. MAX_ITERATIONS = 8 is always the hard backstop and must never be removed or relaxed.

### Step 3: Error Handling
When a task fails:
1. **Reflect**: What exactly failed? Is it the same root cause as a previous failure?
2. **Retry once**: Run `skills/systematic-debugging/SKILL.md` to trace the root cause, then retry with the one fix that hypothesis implies (not a blind alternative approach)
3. **Skip if still failing**: Mark as skipped, continue with next task
4. **Feed errors forward**: If the error reveals something useful, pass it to next iteration

### Step 4: Report
After loop completes (or hits a limit):

```markdown
## Ralph Loop Report

### Completed: X/Y tasks
- [x] Task 1 — [brief description of what was done]
- [x] Task 2 — [brief description]
- [ ] Task 3 — SKIPPED: [reason]

### Files Changed
[list of all modified files]

### Learnings
[patterns discovered during batch execution]

### Remaining
[tasks that weren't reached due to limits]
```

## Rules
- Each iteration is atomic — verify before moving on
- Don't carry stale context — each iteration starts fresh
- Extract patterns from early iterations to speed up later ones
- Respect hard limits — never exceed MAX_ITERATIONS
