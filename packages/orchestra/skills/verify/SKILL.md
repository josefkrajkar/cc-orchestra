---
name: verify
description: |
  End-to-end / smoke verification skill. Use when a change should be exercised at runtime — started, clicked through, or hit with a request — rather than only read.

  Trigger when the user says: "verify", "verify the flow", "smoke test", "e2e", "run it and check", "check it works end to end", "ověř", "ověř funkčnost", "otestuj E2E", "otestuj tok", "otestuj v prohlížeči", "zkus jestli to funguje".

  Also trigger proactively when:
  - The conductor judges the change web-facing (new/changed route, UI flow, or user-visible endpoint)
  - The user passes a `--verify` flag or otherwise explicitly opts into runtime verification

  Do NOT trigger for:
  - Pure code review without running anything (use deep-review instead)
  - Unit-test-only requests — running the existing unit test suite, no end-to-end/browser check
  - Planning or research tasks with nothing yet to run
version: 1.0.0
---

# Verify Skill

This skill is the natural-language entry point for runtime verification. It routes the work to the `verifier` agent (`agents/verifier.md`), which owns the full verification protocol — this skill does not restate it.

## Optional, opt-in stage

Verification is **stage 6.5** of the orchestration pipeline, and it is **not part of the default pipeline**. It only runs when:
- the user explicitly opts in (e.g. asking to verify/smoke-test, or a `--verify` flag), or
- the conductor judges the change web-facing and decides to invoke it proactively.

If neither condition holds, the pipeline completes without this stage and pays no extra cost for it.

## Fail-open behavior

Verification never blocks completion. If there is nothing runnable, or no browser MCP (Playwright) tools are discoverable, the verifier emits a **SKIP**. A skip is not a failure — it is a valid, expected outcome and the pipeline proceeds as if the stage were absent.

## Tool discovery

Browser tools (Playwright MCP) are located at runtime via ToolSearch, never assumed to be pre-attached or required. See `agents/verifier.md` for the discovery and execution protocol.
