# Plan: Integrate E2E Verifier + Systematic-Debugging Discipline into `packages/orchestra`

> Status: DRAFT — awaiting user approval before execution.
> Author: architect agent, 2026-07-04. Based on ecosystem research (scholar) of popular Claude Code skills.
> Research conclusion: of the mid-2026 skills ecosystem (anthropics/skills, obra/superpowers 177k★, Trail of Bits, Playwright skills), only two candidates fill genuine gaps in Orchestra's pipeline without duplicating our skills or native Claude Code features.

## Goal
Add two additive, fail-open capabilities to the orchestration plugin — an **optional** E2E verification pipeline stage (a new `verifier` agent + `verify` skill that prefers Playwright MCP tools when present and skips cleanly otherwise) and a **systematic-debugging** skill that governs the craftsman fix-loop and `/ralph` stuck-handling — without changing the default `/orchestrate` cost or breaking any standalone/fallback behavior.

## License verification (completed)
obra/superpowers is MIT-licensed (© 2025 Jesse Vincent). The MIT notice-retention clause binds only "copies or substantial portions of the Software." A clean-room adaptation reproducing none of their prose/code is **not** required to bundle their LICENSE — an inspired-by note + link suffices. Addition B is therefore written clean-room with a courtesy attribution.

## Key decisions

**Decision 1 — Verifier is a NEW agent (8th), not a sentinel-mode and not skill-only.**
- Sentinel is contractually read-only (`tools: Read/Glob/Grep`; AGENTS.md gotcha: "Scout and sentinel are read-only — they NEVER modify files"). A verifier needs Bash + browser MCP tools. Rejected sentinel-mode.
- Skill-only rejected: no independent tool grant/model tier; verification wants an isolated agent with a bounded, reportable protocol.
- Chosen: `verifier` agent (`tools: ["Read","Glob","Grep","Bash"]`, `model: sonnet`, unused color e.g. orange) that discovers Playwright browser MCP tools at runtime via ToolSearch (same soft-dependency pattern as orchestra-memory tools). Browser MCP tools are NOT added to frontmatter.

**Decision 2 — Verifier stage is OPTIONAL, inserted as stage "6.5 Verification" between Validation and Completion.**
- Invoked only when (a) explicit opt-in flag (e.g. `--verify`), or (b) conductor judges the change web-facing. Default pipeline cost unchanged.
- Reuses sentinel's P0-P3 + confidence % severity model (by reference). Verifier P0/P1 failures re-enter the existing fix loop (max 2 cycles, unchanged).

**Decision 3 — Addition B is a `systematic-debugging` skill, clean-room.**
- 4-phase root-cause protocol (trace root cause → analyze related systems → hypothesize → test fix, one hypothesis at a time, no shotgun fixes) adapted into Orchestra-native prose. Governs craftsman Error Recovery and `/ralph` Step 3 / STUCK_LIMIT path. Attribution footer in the SKILL file + inspiration line in READMEs.

## Phases

### Phase 1 — New-file authoring (3 parallel craftsmen, disjoint new files)

- [ ] **T1.1 — verifier agent** — OWNS: `packages/orchestra/agents/verifier.md` (new). MUST NOT MODIFY: everything else (esp. sentinel.md, craftsman.md).
  Frontmatter matching the 7 existing agents' shape (incl. ≥1 Czech `<example>` like "ověř, že přihlášení funguje"). Protocol: (1) detect project type via Glob, (2) discover browser MCP tools via ToolSearch, (3) web + MCP → drive browser_navigate/click/snapshot flows, (4) web + no MCP → dev-server smoke via Bash if runnable, (5) CLI/server → build/run/health-check smoke, (6) **fail-open SKIP with note** when nothing runnable and no browser tools (skip ≠ failure), (7) report via sentinel's P0-P3 + confidence model (referenced). Memory access section mirroring craftsman's. Inspired-by note (lackeyjb/playwright-skill).
  Acceptance: tools list includes Bash but NO `mcp__…` entry; fail-open SKIP documented; P0-P3 by reference; Czech example present.

- [ ] **T1.2 — verify skill** — OWNS: `packages/orchestra/skills/verify/SKILL.md` (new).
  Bilingual triggers — EN: "verify", "verify the flow", "smoke test", "e2e", "run it and check", "check it works end to end"; CS: "ověř", "ověř funkčnost", "otestuj E2E", "otestuj tok", "otestuj v prohlížeči", "zkus jestli to funguje". "Do NOT trigger for" section (pure review → deep-review; unit-test-only). Body points to `agents/verifier.md`, documents opt-in nature and fail-open.
  Acceptance: EN+CS triggers; documents fail-open skip; states optional/opt-in; no protocol duplication.

- [ ] **T1.3 — systematic-debugging skill** — OWNS: `packages/orchestra/skills/systematic-debugging/SKILL.md` (new).
  Bilingual triggers — EN: "debug systematically", "root cause", "find the root cause", "why does this keep failing", "stuck on this bug"; CS: "najdi příčinu", "najdi kořenovou příčinu", "debuguj systematicky", "proč to pořád padá". Body: clean-room 4-phase protocol + "no spray-and-hope" rule + how it bounds craftsman/ralph retries. Attribution footer: "Adapted clean-room from the systematic-debugging methodology popularized by obra/superpowers (MIT, © 2025 Jesse Vincent) — https://github.com/obra/superpowers. Methodology inspiration only; no source text reproduced."
  Acceptance: EN+CS triggers; 4 phases enumerated; attribution with correct link; no verbatim prose; no bundled LICENSE.

### Phase 2 — Pipeline & agent wiring (after Phase 1; 2 parallel craftsmen)

- [ ] **T2.1 — optional verifier stage** — OWNS: `packages/orchestra/commands/orchestrate.md`, `packages/orchestra/skills/orchestrate/SKILL.md`. MUST NOT MODIFY: agents/*, ralph.md, docs.
  Insert "6.5 Verification (optional)" between Validation and Fix Loop/Completion: opt-in flag OR conductor web-facing judgment; verifier P0/P1 → existing fix loop (no new limits). Update pipeline diagram + quality-gate list in SKILL; add explicit "default pipeline excludes 6.5 unless opted in (cost-neutral by default)" guard sentence.
  Acceptance: default path provably does NOT dispatch verifier; stage marked optional in both files; max-2 fix cycles unchanged.

- [ ] **T2.2 — systematic-debugging wiring** — OWNS: `packages/orchestra/agents/craftsman.md`, `packages/orchestra/commands/ralph.md`, `packages/orchestra/agents/conductor.md`. MUST NOT MODIFY: orchestrate.md, skills/*, docs.
  craftsman.md Error Recovery: replace bare "Try alternative" with pointer to the skill (root cause before fix; one hypothesis at a time; still cap 2 attempts). ralph.md Step 3 + STUCK_LIMIT: invoke the protocol on first failure instead of blind retry; keep STUCK_LIMIT=2 / MAX_ITERATIONS=8. conductor.md: one line on when to elect the optional verify stage.
  Acceptance: skill referenced by path; ALL hard limits preserved verbatim; conductor mentions optional stage.

### Phase 3 — Docs + version bump (after Phase 2; 4 parallel tasks; shared spec constant: "8 agents" + verifier row text)

- [ ] **T3.1 — package README** — OWNS: `packages/orchestra/README.md`. "7 agents"→"8 agents" everywhere; verifier row in agents table; verify + systematic-debugging rows in skills table (with bilingual triggers); 6.5 stage in pipeline diagram; structure tree updated; obra/superpowers + playwright-skill in inspiration list.
- [ ] **T3.2 — root README** — OWNS: root `README.md`. MUST NOT MODIFY: **`README.cs.md` (frozen archive)**. Feature-list cell + repo-layout comments updated.
- [ ] **T3.3 — AGENTS.md** — OWNS: root `AGENTS.md`. verifier in Agent Architecture (Execution layer) + Model Tiering (sonnet, rationale); ARCH_DECISION line ("verifier separate because sentinel is contractually read-only; browser MCP tools via ToolSearch, never pre-attached"); dated upgrade-summary subsection.
- [ ] **T3.4 — version bump** — OWNS: `packages/orchestra/.claude-plugin/plugin.json`. 2.3.0 → **2.4.0**; nothing else changed (hooks untouched — no new hook needed).

### Phase 4 — Validation (sequential, single sentinel)

- [ ] **T4.1** — sentinel review over all changed/added files + acceptance gate: dry-trace default /orchestrate (verifier not invoked); simulate no-Playwright-no-app case (SKIP path); grep EN+CS triggers; verify attribution; grep stray "7 agents"; verify plugin.json diff is version-only; verify README.cs.md untouched; verify hard limits verbatim.

## Parallelization
Phase 1: 3 parallel → barrier (names frozen) → Phase 2: 2 parallel → barrier (final state for docs) → Phase 3: 4 parallel → Phase 4: single reviewer. Peak concurrency 4. Use worktree isolation for mutating craftsmen.

## Risks
- **R1 default cost creep** — opt-in guard sentence + dry-trace in T4.1.
- **R2 hard Playwright dependency leak** — frontmatter capped at Read/Glob/Grep/Bash; ToolSearch discovery only; SKIP path mandatory.
- **R3 fail-open not reached (error instead of skip)** — SKIP-not-fail is a first-class branch; T4.1 simulates the empty environment.
- **R4 license/attribution error** — clean-room, no verbatim prose (acceptance forbids); MIT verified.
- **R5 cross-doc drift ("7 agents")** — shared spec constant to all Phase 3 tasks; sentinel greps.
- **R6 README.cs.md edited** — explicit MUST-NOT-MODIFY.
- **R7 ralph/craftsman limits weakened** — acceptance requires constants verbatim.
- **R8 model frontmatter ignored (known gotcha)** — pipeline wiring must pass `model: "sonnet"` explicitly in the Agent tool call for verifier.

## Out of scope
Bundling/vendoring Playwright; new hooks or .mcp.json for orchestra; any change under packages/orchestra-memory; README.cs.md; a standalone /verify slash command (future follow-up); CI changes; an in-repo Playwright test harness; adding systematic-debugging to sentinel (it doesn't fix).

## Effort
~4-5 craftsman-equivalents; **~1.5-2 days wall-clock** with parallelization. All markdown/JSON — low implementation risk; consistency risk concentrated in cross-doc agent count and the opt-in/fail-open guards.

## Files touched
New: `packages/orchestra/agents/verifier.md`, `packages/orchestra/skills/verify/SKILL.md`, `packages/orchestra/skills/systematic-debugging/SKILL.md`.
Modified: `packages/orchestra/commands/orchestrate.md`, `packages/orchestra/skills/orchestrate/SKILL.md`, `packages/orchestra/agents/craftsman.md`, `packages/orchestra/commands/ralph.md`, `packages/orchestra/agents/conductor.md`, `packages/orchestra/README.md`, root `README.md`, root `AGENTS.md`, `packages/orchestra/.claude-plugin/plugin.json`.
Never: `README.cs.md`, `packages/orchestra/agents/sentinel.md`, anything under `packages/orchestra-memory/`.
