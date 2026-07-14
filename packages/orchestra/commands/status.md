---
name: status
description: Show current orchestration status and active agents
argument-hint: 
allowed-tools: [Read, Bash, TaskList, TaskGet]
---

# Orchestration Status

Show the current status of the multi-agent orchestration workflow.

## Protocol

### Step 1: Check Task State
Use TaskList to get all current tasks and their statuses.

### Step 2: Check Orchestration State
Read `.claude/orchestra-boulder.json` if it exists to get the current orchestration state.
Also check accumulated learnings — primary path: locate orchestra-memory MCP tools via ToolSearch (query like `select:wisdom_get` or keyword `memory`) and call `wisdom_get`; legacy fallback (mandatory when those tools are unavailable, i.e. not found via ToolSearch or the MCP server isn't running): read `.claude/orchestra-wisdom.json` if it exists.

### Step 3: Check Git State
Run `git status` and `git diff --stat` to understand what's been changed so far.

### Step 4: Check Graph Memory Health
Locate `memory_stats` via ToolSearch (query like `select:memory_stats` or keyword `memory`) — it isn't pre-attached to commands. If found, call it and capture its one-block output (counts per scope, invalidated count, staleness >90 days, DB size) for the report below. If the tool can't be found via ToolSearch, or the call fails (MCP server not running, Node < 22.16, bundle missing), do not silently omit the section — surface a single visible line instead:
`Graph memory: unavailable (MCP server not running or Node < 22.16 — run /memory-setup to diagnose)`

### Step 5: Report

Present a concise status report:

```
## Orchestra Status

### Current Phase: [phase name]

### Tasks
- [x] Completed task 1
- [~] In progress task 2
- [ ] Pending task 3

### Files Changed
[list of files modified in this session]

### Active Agents
[any agents currently running]

### Graph memory
[memory_stats one-block output, or the visible unavailability line from Step 4]

### Next Steps
[what happens next in the workflow]
```

## Rules
- Be concise — status should fit on one screen
- Show progress visually (checkmarks, progress indicators)
- Highlight blockers if any exist
