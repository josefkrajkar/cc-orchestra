# Plan: Split Orchestra into `orchestra-memory` + `orchestra` and prepare for public release

> Status: APPROVED with decisions (2026-07-04):
> - **Language:** English-only; Czech README archived as `README.cs.md`.
> - **License:** MIT.
> - **npm:** NOT publishing to npm for now — Phase 3 is DEFERRED; distribution is Claude Code marketplace only. Revisit npm (and scope naming) later.
> Author: architect agent, 2026-07-04. Grounded in scout reconnaissance of the v2.2.0 codebase.

## Goal
Carve the current single `orchestra` plugin (v2.2.0) into two independently installable, publicly releasable products — `orchestra-memory` (the standalone MCP graph-memory server + session injection) and `orchestra` (the orchestration plugin) — where `orchestra` works fully with or without `orchestra-memory`, and both ship in English with license, CI, and install/uninstall docs.

## Key facts that shaped this plan (from reconnaissance)
- **`.mcp.json` + hooks** currently resolve the server via `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs` and sibling script paths — a single plugin root. A plugin cannot reference *another* plugin's `CLAUDE_PLUGIN_ROOT`, so the split must avoid any cross-plugin path reference.
- **Coupling is confined to two scripts.** `session-start.sh` shells out to sibling `memory-inject.sh` + `memory-backup.sh`; `post-compact.sh` inlines a direct `node .../server.mjs --inject` call. Everything else is cleanly one-sided.
- **`project_id` = `sha256(path + "\n")[:16]`** is triplicated in bash (`memory-inject.sh:56` via `pwd`, `session-start.sh:65` and `post-compact.sh:101` via `echo`) and once in TS (`mcp-server/src/migrate.ts:84` `computeProjectId`). The trailing newline is load-bearing. Boulder instance key == graph project_id is a **cross-package invariant** after the split.
- **mcp-server is clean**: no personal paths, `name: orchestra-memory-mcp-server`, `"private": true`, no `bin`/`files`/`exports`, shebang already present in `src/server.ts`, `dist/` committed (not gitignored), 42 tests importing from `src/` (build-independent), DB at `~/.claude/orchestra-memory/graph.db`. CLI modes: `--inject`/`--migrate`/`--backup` (no `--help`).
- **Czech volume is smaller than feared.** README.md (~175 Czech lines of 513) is the bulk. Agent frontmatter is already English; Czech lives only in `<example>` dialogue snippets (~28 lines). Commands/skills ~9 lines total; the one user-facing runtime string is `commands/status.md:26`. Script "Czech" is code comments only. Personal paths appear only in `PLAN-graph-memory.md` (lines 6, 208).
- **Marketplace** (`orchestra-marketplace/`) is just `.claude-plugin/marketplace.json` + a symlink `orchestra → orchestra-plugin`. Adding a second product = append one entry + one symlink.
- **Naming**: no exact `orchestra-memory` npm package found; the bare `orchestra` name is crowded (claude-orchestration, oh-my-claudecode, `@xen-orchestra/*`). Recommend scoped npm + marketplace prefix, verified before release.

## Packaging decision (recommendation)

**Monorepo, two Claude Code plugins, plus npm-published MCP server. Decouple via per-plugin hooks — no inter-plugin path references.**

### Repo layout (single public GitHub repo)
```
orchestra/                              # public monorepo
├── packages/
│   ├── orchestra-memory/               # PLUGIN A (also the npm-publish source)
│   │   ├── .claude-plugin/plugin.json  # name: orchestra-memory
│   │   ├── .mcp.json                   # registers orchestra-memory MCP server (own PLUGIN_ROOT)
│   │   ├── mcp-server/                 # TS src + dist (moved verbatim)
│   │   ├── scripts/
│   │   │   ├── session-start.sh        # memory injection + daily backup ONLY
│   │   │   ├── post-compact.sh         # memory re-injection ONLY
│   │   │   ├── memory-inject.sh
│   │   │   └── memory-backup.sh
│   │   └── README.md                   # flagship positioning
│   └── orchestra/                      # PLUGIN B (orchestration)
│       ├── .claude-plugin/plugin.json  # name: orchestra
│       ├── agents/ commands/ skills/ conventions/
│       ├── scripts/                    # orchestration hooks + slim session-start/post-compact
│       └── README.md
├── .github/workflows/ci.yml
├── LICENSE  CONTRIBUTING.md  README.md
```

### Why monorepo over two repos
- The `project_id` newline contract and the boulder-key==graph-project-id invariant must stay in lockstep across both plugins; a monorepo lets one CI job assert bash-vs-TS agreement atomically.
- Coordinated versioning and a single E2E pipeline that installs both.
- Two repos fragment the shared contract and make cross-cutting changes non-atomic. Rejected.

### How `orchestra` "declares" its memory dependency
Claude Code has **no formal inter-plugin dependency mechanism**. So `orchestra` treats `orchestra-memory` as an **optional companion (soft dependency), not a bundled one**:
- `orchestra` ships **no `.mcp.json`** and no reference to `mcp-server/`. Its agents already reach memory tools via ToolSearch + fail-open, and `/memory-setup` / `session-start.sh` already fall back to legacy `.claude/orchestra-wisdom.json`.
- **The decoupling mechanism is separate hooks.** Both plugins register `SessionStart`/`PostCompact`; Claude Code runs both. `orchestra-memory` gets its *own* `session-start.sh` (memory injection + backup) and `post-compact.sh` (re-injection), each resolving `mcp-server/dist` under its **own** `CLAUDE_PLUGIN_ROOT`. `orchestra`'s hooks keep only boulder + wisdom-summary logic. Result: zero cross-plugin path references, and `orchestra` degrades to legacy wisdom when `orchestra-memory` is absent.

### Distribution channels for `orchestra-memory`
1. **Claude Code plugin** via the marketplace (second entry). — the only channel for now.
2. ~~npm package~~ **DEFERRED by user decision (2026-07-04).** When revisited: scoped name (e.g. `@orchestra-code/memory` or `@josefkrajkar/orchestra-memory`), keep MCP server identity string `orchestra-memory`. Until then the server remains `"private": true`.

## Phases

### Phase 0 — Decisions, naming, scaffolding (sequential, blocks all) — 0.5 day
- [ ] **T0.1** Confirm decisions: (a) English-only vs English-primary+Czech-kept — **recommend English-only**, archive Czech README as `README.cs.md` if sentimental value; (b) license (recommend **MIT** or **Apache-2.0**); (c) npm scope name. — OWNS: decision record in root `README.md` draft. MUST NOT MODIFY: source.
- [ ] **T0.2** Naming-collision verification: marketplace listing check for `orchestra`/`orchestra-memory`; `npm view <scope>/memory`; GitHub repo-name check. Record fallbacks (`orchestra-mem`, `maestro`, `orchestra-graph-memory`). — OWNS: decision record.
- [ ] **T0.3** Create monorepo skeleton `packages/orchestra-memory/` and `packages/orchestra/`. — OWNS: new dirs.
- Parallelizable: T0.1/T0.2 parallel; T0.3 after.
- Risk: picking a name later found taken. Mitigation: verify before any publish; MCP server identity string stays `orchestra-memory` regardless.
- Acceptance: decisions written down; names confirmed available; skeleton exists.

### Phase 1 — Structural split (sequential, blocks 2/6/7) — 1.5 days
- [ ] **T1.1** Move `mcp-server/` → `packages/orchestra-memory/mcp-server/` verbatim (src, test, dist, config). — OWNS: `packages/orchestra-memory/mcp-server/**`. MUST NOT MODIFY: TS logic.
- [ ] **T1.2** Move memory-infra scripts → `packages/orchestra-memory/scripts/`: `memory-inject.sh`, `memory-backup.sh`. — OWNS: those two files.
- [ ] **T1.3** Create `packages/orchestra-memory/scripts/session-start.sh` + `post-compact.sh` containing **only** the memory halves currently embedded in the root scripts (inject block + backup call; re-injection block). Resolve `mcp-server/dist` via this plugin's own root. — OWNS: new memory hooks.
- [ ] **T1.4** Create `packages/orchestra-memory/.mcp.json` (server args `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs`) and `.claude-plugin/plugin.json` (name `orchestra-memory`, registers SessionStart + PostCompact). — OWNS: those files.
- [ ] **T1.5** Move orchestration assets → `packages/orchestra/`: `agents/`, `commands/`, `skills/`, `conventions/`, and orchestration hooks (`pretooluse-guard.sh`, `track-progress.sh`, `validate-completion.sh`, `taskcompleted-gate.sh`, `subagent-log.sh`, `notify.sh`). — OWNS: those.
- [ ] **T1.6** Slim `packages/orchestra/scripts/session-start.sh` and `post-compact.sh` to boulder + legacy-wisdom logic; **remove** the `memory-inject.sh`/`memory-backup.sh` sibling calls (session-start.sh:35-50) and the inline `node --inject` block (post-compact.sh:89-112). Keep the legacy `.claude/orchestra-wisdom.json` read paths intact. — OWNS: those two files.
- [ ] **T1.7** New `packages/orchestra/.claude-plugin/plugin.json`: 7 hook events, **no `.mcp.json`**, version bumped. — OWNS: that file.
- Parallelizable: at most two craftsmen — memory side (T1.1–T1.4) vs orchestration side (T1.5–T1.7); the root-script splitting (T1.3/T1.6) should be one craftsman to keep the boundary coherent.
- Risk: dropping memory calls from orchestra's hooks could regress wisdom fallback. Mitigation: T1.6 explicitly preserves the legacy JSON read; Phase 7 E2E verifies.
- Acceptance: each plugin dir self-contained; `grep -r CLAUDE_PLUGIN_ROOT packages/orchestra/` finds no `mcp-server` reference; `orchestra-memory` boots its MCP server from its own root.

### Phase 2 — Runtime decouple + `project_id` contract (sequential after 1) — 1 day
- [ ] **T2.1** Preserve the `project_id` formula in both plugins (orchestra needs it for the boulder instance key; orchestra-memory in `memory-inject.sh` + `post-compact.sh`). Keep the exact `echo "$X" | shasum -a 256 | cut -c1-16` form; add a prominent shared-contract comment block at each occurrence citing the newline invariant and the TS `computeProjectId`. **Do not** switch to a node-CLI emitter (orchestra must not gain a hard node dependency). — OWNS: the three bash `project_id` sites + comment in `migrate.ts`.
- [ ] **T2.2** Add a CI-runnable contract test asserting the bash formula and TS `computeProjectId` produce identical output for the same path. — OWNS: `mcp-server/test/project-id-contract.test.ts` (or a shell test).
- [ ] **T2.3** Verify fail-open when `orchestra-memory` is not installed: orchestra's slim hooks must run clean with no memory scripts present. — verification; may adjust orchestra hooks.
- Risk: **silent project fragmentation** if the newline is dropped in any rewrite. Mitigation: T2.2 CI test; do not refactor the formula.
- Acceptance: contract test green; orchestra runs with `orchestra-memory` absent; same project_id as pre-split for a given dir.

### Phase 3 — Package `orchestra-memory` for npm — **DEFERRED (user decision 2026-07-04)**
Not publishing to npm for now. Kept for future reference:
- ~~T3.1 package.json publish fields (`bin`, `files`, `exports`, remove `"private"`)~~ — deferred.
- [ ] **T3.2** Add `--help`/usage output to the CLI dispatcher in `src/server.ts`. — OWNS: arg dispatch. *(Kept — cheap and useful regardless of npm.)*
- [ ] **T3.3** `mcp-server/README.md`: standalone positioning (vs Mem0/claude-mem, scope model, temporal validity) with plugin-based install instructions. — OWNS: that README. *(Kept — positioning matters for the marketplace listing too.)*
- Acceptance: `--help` works; README positions the memory server as the flagship.

### Phase 4 — English translation (parallel after 1) — 1.5 days
- [ ] **T4.1** Rewrite README.md → English for **both** packages (orchestra-memory flagship README + orchestra README + root overview README). ~175 Czech lines, the bulk of the effort. — OWNS: the three README.md files.
- [ ] **T4.2** Translate the ~28 Czech `<example>` dialogue lines across the 7 agents (`agents/*.md`). — OWNS: agent files (disjoint per craftsman).
- [ ] **T4.3** Translate `commands/status.md:26` runtime string + the ~9 scattered command/skill trigger lines. — OWNS: `commands/status.md`, affected skills.
- Parallelizable: 3–4 craftsmen on disjoint files (READMEs / agents / commands+skills).
- Risk: translating trigger phrases changes agent invocation behavior. Mitigation: keep semantic intent; sentinel review; prose only, no functional edits.
- Acceptance: a Czech-diacritics regex check over `packages/` returns only intentional residue (e.g. archived `README.cs.md`).

### Phase 5 — Public-release scaffolding (parallel after 1) — 1 day
- [ ] **T5.1** Root `LICENSE` (chosen license) + per-package license reference. — OWNS: `LICENSE`.
- [ ] **T5.2** `CONTRIBUTING.md`: build, test, the `project_id` newline contract, the `schema.sql`-copied-at-build gotcha, monorepo layout. — OWNS: `CONTRIBUTING.md`.
- [ ] **T5.3** `.github/workflows/ci.yml`: Node 22.5+ matrix, vitest (42 tests), build + smoke-boot `dist/server.mjs`, `npm pack --dry-run`, `shellcheck` on all `scripts/*.sh`, project_id contract test. — OWNS: workflow file.
- [ ] **T5.4** Uninstall/cleanup docs: remove plugins + purge `~/.claude/orchestra-memory/` (graph.db + backups/). — OWNS: README section.
- [ ] **T5.5** Install-from-GitHub story: marketplace-add commands for both plugins (npm story deferred). — OWNS: README section.
- [ ] **T5.6** Genericize `PLAN-graph-memory.md` personal paths (lines 6, 208); decide keep/translate/move to `docs/design/`. — OWNS: `PLAN-graph-memory.md`.
- Parallelizable: yes, each task is a disjoint file.
- Acceptance: CI passes on a clean checkout; a check for the literal personal home-directory path returns clean; uninstall doc removes all state.

### Phase 6 — Marketplace wiring (after 1/2) — 0.5 day
- [ ] **T6.1** Update `orchestra-marketplace/.claude-plugin/marketplace.json`: two entries (`orchestra`, `orchestra-memory`). — OWNS: marketplace.json.
- [ ] **T6.2** Replace the single `orchestra` symlink with two symlinks → `packages/orchestra` and `packages/orchestra-memory` (dev); document the GitHub `source` form for public release. — OWNS: marketplace symlinks.
- [ ] **T6.3** Rewrite the rsync deploy procedure for two package dirs, preserving the "backup first, `--dry-run`, no `--delete`, exclude node_modules, ship `dist/`, preserve fable-model experiment" constraints from `PLAN-graph-memory.md` Phase 9. — OWNS: `DEPLOY.md`.
- Risk: rsync overwriting the fable-model experiment / marketplace not a git repo. Mitigation: mandatory pre-deploy backup, `--dry-run`, `--exclude`.
- Acceptance: `claude plugin marketplace add` lists both; both install; deploy doc reproduces the safe procedure.

### Phase 7 — E2E validation (sequential, after all) — 1 day
- [ ] **T7.1** Fresh install **both** plugins → SessionStart injects memory, `memory_save`/`memory_search` roundtrip, backup rotates.
- [ ] **T7.2** Install **orchestra only** → orchestration works, no hook errors, `/wisdom` falls back to `.claude/orchestra-wisdom.json`, `/status` reports memory unavailable (translated string).
- [ ] **T7.3** Install **orchestra-memory only** (as plugin) → standalone MCP works without the orchestra plugin.
- [ ] **T7.4** Verify `project_id` for a given dir is unchanged vs pre-split (no fact fragmentation for existing users) and boulder instance key still matches graph project_id.
- [ ] **T7.5** Run uninstall/cleanup doc end to end.
- Risk: **breaking existing local installs** (current single `orchestra` marketplace entry). Mitigation: migration note; `project_id` continuity means existing `~/.claude/orchestra-memory/graph.db` keeps working.
- Acceptance: all three install permutations pass; existing memory DB intact; uninstall leaves no residue.

## Parallelization strategy
- Sequential spine: Phase 0 → 1 → 2 → … → 7.
- Fan-out after Phase 2: Phases 3 (npm), 4 (translation, 3–4 craftsmen), 5 (scaffolding), 6 (marketplace) run in parallel.
- Within Phase 1: at most 2 craftsmen (memory side vs orchestration side); root-script splitting (T1.3/T1.6) by one craftsman.
- Phases 2 and 7 are single-craftsman (contract-sensitive / whole-system verification).

## Risk assessment (top risks)
1. **`project_id` fragmentation across the package boundary** (newline invariant) — critical, silent. Mitigation: keep exact formula, CI contract test (T2.2), continuity check (T7.4).
2. **Breaking existing local installs** when the marketplace goes from one to two plugins — high. Mitigation: project_id continuity preserves graph.db; migration note; orchestra remains standalone-functional.
3. **Wisdom-fallback regression** when stripping memory calls from orchestra's hooks (T1.6) — high. Mitigation: retain legacy JSON read; T7.2 verifies orchestra-only.
4. **Hook path leaks** — orchestra accidentally still referencing `mcp-server/` — medium. Mitigation: grep gate in Phase 1 acceptance; separate-hooks architecture removes cross-plugin paths entirely.
5. ~~npm publish ships wrong files~~ — n/a while npm is deferred.
6. **Name collision** (`orchestra` is crowded) — medium. Mitigation: Phase 0 verification of marketplace/GitHub names + fallbacks.
7. **rsync overwrites fable-model experiment / marketplace not git** — high. Mitigation: mandatory backup, `--dry-run`, `--exclude`.

## Out of scope (explicit)
- **npm publication of the MCP server** — deferred by user decision (2026-07-04); marketplace-only distribution for now.
- Embeddings / semantic / hybrid retrieval — stays v2 future work (FTS5 BM25 + 1-hop graph expansion only).
- Retaining full Czech localization — English-only recommended (archive Czech README at most).
- Auto-setting `autoMemoryEnabled: false` — remains user-driven via `/memory-setup`.
- Windows support — bash hooks are Unix-only; not addressed here.
- A formal inter-plugin dependency mechanism — not offered by Claude Code; soft-companion model used instead.
- Graph schema migration (schema_version bump) — no data-model changes in this split.
- Kuzu/Neo4j/better-sqlite3 reconsideration — settled; `node:sqlite` stays.

## Effort
~7–8 craftsman-days of work (Phase 3 reduced to two small tasks); with the post-Phase-2 fan-out, wall-clock critical path ≈ 5 days (0.5 + 1.5 + 1 + [max of parallel tracks ≈1.5, translation-dominated] + 1).

## To persist to memory once landed
- Final packaging decision (monorepo + soft-companion split via per-plugin hooks) and rationale.
- The `project_id` cross-package contract and the CI test guarding it.
- Chosen names (marketplace + npm scope) and collision-check outcome.
