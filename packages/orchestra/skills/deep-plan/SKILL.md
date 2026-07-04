---
name: deep-plan
description: |
  Deep planning skill for thorough architectural analysis. Use when the user needs detailed planning before implementation.

  Trigger when the user says: "design the architecture", "navrhni architekturu", "make a plan", "udělej plán", "how would you design this", "jak bys to navrhl", "plan it out", "naplánuj", "design this", "plan this", "rozplánuj", "migration strategy", "migration plan", "migrační plán", "create a plan", "lay out the plan".

  Also trigger proactively when:
  - Task is complex enough to need upfront design
  - User asks "how would you approach X" for a large change
  - Migration or major refactoring is discussed

  Do NOT trigger for:
  - Simple questions about architecture (just answer them)
  - Tasks that are already well-defined and ready to implement
  - Code review requests
version: 2.0.0
---

# Deep Planning Skill

This skill provides thorough planning using the scout → scholar → architect pipeline.

## Planning Depth Levels

### Quick Plan (single concern, <5 files)
1. Scout explores affected area
2. Architect produces lightweight plan
3. Present to user

### Standard Plan (multi-file, single system)
1. Scout explores codebase structure and conventions
2. Architect produces phased plan with risk assessment
3. Present to user with options

### Deep Plan (multi-system, high risk)
1. Scout explores all affected systems
2. Scholar researches external dependencies and best practices (parallel with scout)
3. Architect produces comprehensive plan with:
   - Multiple approach analysis (2-3 options with trade-offs)
   - Detailed risk matrix
   - Rollback strategy per phase
   - Validation criteria per phase
   - File ownership strategy for parallel execution
4. Present to user for discussion and iteration

## Plan Template

A plan covers: Context (current vs desired state, constraints) → Approach (selected + alternatives) → Phases (tasks with OWNS lists, dependencies, parallelizability, risk, acceptance criteria) → Parallelization Strategy → Risk Matrix → Validation.

Full template: see `agents/architect.md` → `### Step 4: Execution Plan`.

## Framework-Aware Planning

When the task or codebase involves a framework with registered conventions in `conventions/`, the architect **must** apply framework-aware planning from `agents/architect.md` → "Framework-Aware Planning".

### React / Next.js tasks

When planning React/TSX work:
- For each new/changed component, decide **Server vs Client** explicitly — mark `'use client'` boundaries in the plan
- Name the **data layer** per task (RSC fetch / TanStack Query / Server Action / local state) — never leave it implicit
- Decide **state ownership** hierarchy (URL / server / context / local) at plan time, not implementation time
- Include a **React Compiler assumption** in Risk Assessment (active → no manual memoization; inactive → memoize where measured)
- Load conventions using the two-tier precedence model: if `~/.claude/skills/react-conventions/` exists, read its `SKILL.md` and `reference/review-checklist.md` — they take precedence; use the plugin `conventions/react.md` and `conventions/react-review-checklist.md` as the offline fallback digest when the user skill is absent. Reference this in every phase that touches `.tsx` / `.jsx` (consistent with the wording in `agents/architect.md`)
- Validation criteria must include a walk-through of the review checklist (user skill first, plugin digest as fallback)

## Interview Mode

For ambiguous requests, the architect enters interview mode:
1. Present initial understanding
2. Ask 2-3 targeted clarifying questions
3. Present options for key decisions
4. Converge on a plan

## Specification Output

After plan approval, produce a specification that executor can consume directly:
- Task list with file ownership per craftsman
- Conventions to follow (from scout findings)
- Acceptance criteria per task
- Dependency graph

## Critical Rules

1. **Planning is read-only** — no file modifications during planning
2. **Be specific** — name files, functions, line numbers where possible
3. **Include file ownership** — every task must specify which files it owns
4. **Match depth to complexity** — don't over-plan simple tasks
5. **Always include validation criteria** — how to verify the work is correct
