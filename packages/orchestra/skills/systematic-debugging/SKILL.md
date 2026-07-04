---
name: systematic-debugging
description: |
  Disciplined root-cause debugging methodology. Use when a fix attempt fails, an error keeps recurring, or the actual cause of a bug is not yet understood — replaces guess-and-check with a structured trace-analyze-hypothesize-test cycle.

  Trigger when the user says: "debug systematically", "root cause", "find the root cause", "why does this keep failing", "stuck on this bug", "najdi příčinu", "najdi kořenovou příčinu", "debuguj systematicky", "proč to pořád padá".

  Also trigger proactively when:
  - A craftsman's fix attempt failed and a retry is about to happen
  - A `/ralph` task hit its STUCK_LIMIT
  - The same error recurs across attempts

  Do NOT trigger for:
  - Trivial one-line fixes with an obvious cause
  - Feature work that isn't a bug
  - When the root cause is already known and only the fix remains
version: 1.0.0
---

# Systematic Debugging

This skill provides a disciplined method for finding and fixing the ROOT cause of a bug, rather than guessing. It exists to stop the "spray-and-hope" pattern — piling on speculative changes and hoping one of them happens to make the symptom go away — which tends to mask the real defect, add unrelated risk, and burn retry budget without producing understanding.

Use this skill whenever a fix has already failed once, or whenever a failure resists a quick, obvious explanation. The goal of every pass through this skill is not "make the error disappear" but "understand exactly why it happens" — the fix should follow naturally once that understanding exists.

## The 4-phase protocol

Work through these four phases in order, every time. Do not skip ahead to phase 4 without completing 1-3.

1. **Trace the root cause** — Reproduce the failure reliably first; a fix you can't reliably trigger, you can't reliably verify. Then follow the failure backward from where it surfaces to where it actually originates: read the stack trace, the logs, the state at the point of failure, and walk backward through the call chain or data flow until you reach the first place things went wrong. Treat the visible error message as a symptom, not the diagnosis — the line that throws is rarely the line that's broken.

2. **Analyze related systems** — Before touching anything, map what else touches the failing code path: callers, shared state, configuration, other consumers of the same data or API, recent changes nearby. Understand the blast radius of both the bug and any candidate fix. A change that looks locally correct can break a caller you haven't looked at yet.

3. **Form one hypothesis** — State a single, specific, testable explanation for the cause: "X happens because Y, which I can confirm by Z." Write it down before writing any fix code. If you find yourself listing several plausible causes, that's a signal phase 1 or 2 wasn't finished — go back rather than picking one at random.

4. **Test that one fix** — Apply exactly one change that targets the hypothesis from phase 3, then verify against the reproduction from phase 1. If the fix confirms the hypothesis, done. If it doesn't, discard the change, keep what you learned, and return to phase 1 with that new information — do not layer a second speculative change on top of the first while the first is still in place.

## One hypothesis at a time

Never make several unrelated changes at once "to see what sticks." Every cycle through the protocol commits to exactly one hypothesis, one corresponding change, and one verification step before the next hypothesis is even considered. If a fix fails, roll it back (mentally or literally) before forming the next hypothesis — a failed speculative change left in place contaminates the next attempt and makes it impossible to tell what actually fixed (or didn't fix) the problem.

## How this bounds retries

This protocol governs the *quality* of a retry, not how many retries are allowed. It plugs into two existing retry paths without changing their hard limits:

- **Craftsman Error Recovery loop**: on a failed attempt, the craftsman's existing reflect step is where this protocol runs — trace the root cause and form one hypothesis before the retry, instead of just trying "something else." The craftsman's cap of 2 failed attempts before stopping and reporting is unchanged; this skill only makes each of those 2 attempts more likely to target the real cause.
- **`/ralph` Step 3 / STUCK_LIMIT path**: when a task fails, run this protocol before the retry attempt rather than retrying blindly. `STUCK_LIMIT = 2` and `MAX_ITERATIONS = 8` remain the hard backstops for the loop — this skill improves what happens *inside* an attempt, it does not raise, relax, or extend either limit.

If root cause can't be pinned down within the existing retry budget, stop and report what was ruled out and what remains uncertain — do not spend extra attempts beyond the caps above chasing a diagnosis.

## Attribution

Adapted clean-room from the systematic-debugging methodology popularized by obra/superpowers (MIT, © 2025 Jesse Vincent) — https://github.com/obra/superpowers. Methodology inspiration only; no source text reproduced.
