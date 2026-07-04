---
name: deep-review
description: |
  Deep code review skill for thorough quality validation. Use when code changes need systematic review.

  Trigger when the user says: "review", "check this", "inspect this", "audit", "quality check", "security review", "code review", "look at the changes", "check the code".

  Also trigger proactively when:
  - Significant code changes have been made and need validation
  - Security-sensitive code is involved
  - User is about to merge or commit large changes

  Do NOT trigger for:
  - Quick glances at code (user can just read it)
  - Reviewing documentation or config files only
  - When user explicitly says they don't need review
version: 2.0.0
---

# Deep Review Skill

This skill provides comprehensive code review using the sentinel agent with confidence-based filtering.

## Review Depth Levels

### Quick Review (few files, low risk)
1. Sentinel reviews changed files
2. Report only P0-P1 issues at 80%+ confidence

### Standard Review (multi-file changes)
1. Scout maps the change scope and context
2. Sentinel reviews with full context
3. Structured report with all severity levels (80%+ confidence)

### Security Audit (auth, data handling, API)
1. Scout maps all security-relevant code paths
2. Sentinel performs security-focused review:
   - OWASP Top 10 checklist
   - Authentication/authorization flows
   - Input validation at system boundaries
   - Data exposure risks
   - Injection vectors
3. Detailed security report

### React Review (changeset contains `.tsx` / `.jsx`)

React Review is an **additive layer**, not a separate tier. It runs on top of the base tier (Quick / Standard / Security Audit) that the changeset would otherwise get:

- Quick + React Review → fast pass plus React checklist walk
- Standard + React Review → full scout-then-review plus React checklist walk
- Security Audit + React Review → OWASP sweep plus React-specific security items from the checklist (secrets in client code, `dangerouslySetInnerHTML`, Server Action auth)

For a pure React changeset the base tier may collapse to Quick if few files/low risk.

**Steps:**
1. Scout maps React component boundaries (Server vs Client, data layer, state ownership)
2. Sentinel loads `conventions/react.md` + `conventions/react-review-checklist.md`
3. Sentinel walks the full checklist (components, hooks, state, data fetching, performance, TypeScript, a11y, anti-patterns, security, Next.js specifics, testing)
4. Findings mapped to P0-P3 via the severity mapping in sentinel's framework-specific section
5. Each finding cites the rule (`Viz: conventions/react.md#<section>`)

## Confidence-Based Filtering

Sentinel only reports issues at **80%+ confidence**:
- **95-100%**: Definite bug, security vuln, crash → P0
- **80-94%**: Very likely issue, strong evidence → P1/P2
- **60-79%**: Possible issue → P3 Observations only
- **<60%**: Not reported

This prevents noise and false positives.

## Review Checklist

### Correctness
- Logic errors and edge cases
- Error handling completeness
- State management consistency
- Concurrency/race conditions

### Security
- Input validation at boundaries
- Output encoding
- Authentication checks
- Authorization enforcement
- Sensitive data handling

### Performance
- Query efficiency
- Unnecessary computations
- Memory management
- Caching opportunities

### Maintainability
- Code clarity and naming
- Consistent patterns with existing codebase
- Appropriate abstraction level
- Test coverage for new functionality

### Completeness
- Missing changes (files that should have been updated)
- Missing tests for new behavior
- Missing error handling at boundaries

### Framework Conventions (when applicable)
- React/TSX: every item in `conventions/react-review-checklist.md`
- Additional framework checklists can be added to `conventions/` and registered here

## Iterative Review-Fix Loop

After sentinel identifies issues:
1. Present report to user
2. If user wants fixes: spawn craftsman for P0/P1 issues
3. After fixes: re-run sentinel for verification
4. **Max 2 fix-review cycles** — after that, report remaining issues and stop
5. Repeat until clean or user accepts remaining issues
