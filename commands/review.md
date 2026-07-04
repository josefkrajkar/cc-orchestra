---
name: review
description: Run a thorough code review using sentinel agent
argument-hint: [files or scope to review]
---

# Code Review Mode

You are entering **code review mode**. The sentinel agent will perform a thorough review.

## Input
Review scope: `$ARGUMENTS`

## Protocol

### Step 1: Determine Scope
If the user specified files or a scope, use that. Otherwise:
- Check `git diff` for uncommitted changes
- Check `git diff HEAD~1` for recent commits
- If no changes found, ask the user what to review

### Step 2: Launch Sentinel
Spawn a **sentinel** agent with:
- The list of files/changes to review
- Context about what the changes are for (if known)
- Any specific concerns the user mentioned

### Step 3: Report
Present the sentinel's review report to the user. The report includes:
- Overall assessment (PASS / NEEDS CHANGES / CRITICAL)
- P0-P3 severity-rated issues
- Positive notes

### Step 4: Follow-up
If issues were found:
- Ask the user if they want to fix them
- If yes, spawn a **craftsman** agent with the specific issues to fix
- After fixes, optionally re-run sentinel for verification

## Rules
- Sentinel is read-only — it identifies issues but doesn't fix them
- Always include severity ratings
- Be honest — don't hide critical issues
- Praise good patterns alongside criticism
