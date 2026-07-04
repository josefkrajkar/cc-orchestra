---
name: boulder
description: Save or restore orchestration state for session persistence
argument-hint: [save|restore|clear]
allowed-tools: [Read, Write, Bash, TaskList, TaskGet]
---

# Boulder — Session Persistence

Manage orchestration state persistence across sessions. Inspired by oh-my-openagent's boulder.json system.

## Input
Action: `$ARGUMENTS` (defaults to "save" if empty)

## Actions

### save
Capture current orchestration state to `.claude/orchestra-boulder.json`:

1. Get all current tasks via TaskList
2. Get current git state (`git diff --stat`, `git status`, `git rev-parse --abbrev-ref HEAD`)
3. Read existing wisdom — primary path: locate orchestra-memory MCP tools via ToolSearch (query like `select:wisdom_get` or keyword `memory`) and call `wisdom_get`; legacy fallback (mandatory when those tools are unavailable, i.e. not found via ToolSearch or the MCP server isn't running): read `.claude/orchestra-wisdom.json` if available
4. Compute file hashes for changed files: `git hash-object <file>` for each
5. Derive the instance key from the full working directory path:
   ```bash
   echo "$PWD" | shasum -a 256 | cut -c1-16
   ```
   This produces the first 16 hex characters of the SHA-256 hash of the full cwd path.
6. Create a structured state snapshot:

```json
{
  "version": 2,
  "instance": "cwd-derived-key",
  "phase": "current phase name",
  "intent": "quick|standard|complex|research|review",
  "timestamp": "ISO 8601 timestamp",
  "tasks": [
    {
      "id": "1",
      "subject": "...",
      "status": "completed|in_progress|pending",
      "description": "...",
      "file_ownership": ["files this task owns"]
    }
  ],
  "changed_files": {
    "path/to/file.ts": "git-hash-at-save-time",
    "path/to/other.ts": "git-hash-at-save-time"
  },
  "plan_summary": "brief description of the plan being executed",
  "next_steps": "what should happen next",
  "git_branch": "current branch name",
  "git_commit": "HEAD commit hash at save time"
}
```

**Instance field contract:**
- `instance` is the first 16 hex characters of `sha256(full cwd path)`, computed as:
  ```bash
  echo "$PWD" | shasum -a 256 | cut -c1-16
  ```
  This allows `session-start.sh` to match the boulder against the cwd of a new Claude session and only announce boulders that belong to the current project.
- `instance` is an **optional additive field** — `version` stays `2` regardless. Boulders without `instance` (written before this change) are treated as legacy and announced everywhere; the matching logic lives in `scripts/session-start.sh`.
- Always include `instance` in new saves.

7. Write to `.claude/orchestra-boulder.json`
8. Confirm save to user with summary

### restore
Load orchestration state from a previous session:

1. Read `.claude/orchestra-boulder.json`
2. **Validate file integrity**: For each file in `changed_files`, compute the current git hash and compare to the saved hash:
   - Collect all files whose current hash differs from the saved hash (mismatches)
   - Collect all files that no longer exist on disk (missing)
3. **If any mismatches or missing files exist — STOP and confirm before proceeding:**

   Present a summary to the user, for example:
   ```
   ⚠️  File integrity mismatch — the following files changed since the boulder was saved:

     MODIFIED: src/api/handler.ts  (saved: a1b2c3d, current: e4f5g6h)
     MISSING:  src/utils/legacy.ts

   Recreating tasks from this boulder may overwrite or conflict with the current
   state of these files.

   Proceed with restore anyway? (yes / no)
   ```

   - **Wait for explicit user confirmation** (`yes` or equivalent) before calling TaskCreate for any task.
   - If the user responds `no` or anything other than a clear affirmative, abort the restore and report that no tasks were created.
   - Do NOT silently skip the mismatched files and restore anyway — always surface them first.

4. Check git branch matches; warn if it differs (non-blocking, just inform the user)
5. Present the full saved state to the user
6. **Only after confirmation (or if no mismatches):** Recreate tasks from the saved state via TaskCreate
7. Read wisdom — primary path: locate orchestra-memory MCP tools via ToolSearch (query like `select:wisdom_get` or keyword `memory`) and call `wisdom_get`; legacy fallback (mandatory when those tools are unavailable): read `.claude/orchestra-wisdom.json`
8. Suggest next steps based on saved state

### clear
Remove orchestration state:

1. Delete `.claude/orchestra-boulder.json`
2. Delete `.claude/orchestra-locks/` directory if exists
3. Optionally keep `.claude/orchestra-wisdom.json` (ask user)
4. Confirm to user

## Boulder Schema Versioning

Current version: 2. If loading a version 1 boulder, migrate:
- Add `"version": 2`
- Convert `changed_files` from array to hash object
- Add `"intent": "complex"` as default

## Rules
- Boulder file should be in `.gitignore`
- Always capture file hashes for integrity validation on restore
- Include enough context for a cold resume by a new session
- Wisdom file is separate — it persists independently of boulder
- Lock files are cleaned up on clear
