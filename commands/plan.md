---
name: plan
description: Create a detailed plan for a complex task using architect agent
argument-hint: <what to plan>
---

# Strategic Planning Mode

You are entering **strategic planning mode**. The user wants a thorough plan before any implementation.

## Input
Plan request: `$ARGUMENTS`

## Protocol

### Step 1: Reconnaissance
Spawn a **scout** agent to explore the relevant codebase areas. Provide the scout with specific guidance about what to look for based on the user's request.

### Step 2: Research (if needed)
If the task involves unfamiliar libraries, APIs, or patterns, spawn a **scholar** agent to research documentation and best practices.

### Step 3: Architecture
Spawn an **architect** agent with:
- The user's request
- Scout's reconnaissance findings
- Scholar's research (if applicable)

The architect will produce a structured plan with phases, tasks, risks, and validation criteria.

### Step 4: Review
Present the plan to the user. Highlight:
- Key design decisions and their rationale
- Risks and mitigations
- Parallelization opportunities
- Estimated scope

### Step 5: Iterate
If the user has feedback, refine the plan. Once approved, the plan is ready for `/orchestrate` or manual execution.

## Rules
- Planning is read-only — no file modifications
- Be thorough but proportional to task complexity
- Always include validation criteria in the plan
- Flag assumptions that need user confirmation
