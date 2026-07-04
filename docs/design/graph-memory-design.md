# Deep Plan: Extending the Orchestra plugin with a cross-project graph memory system

## 1. Context

### Current state
The Orchestra plugin (v2.0.0, `<project-root>/`) is a pure markdown + bash solution. It has no JS/TS code, no `.mcp.json`, and depends only on `bash` + `jq` (and `jq` is treated as optional — hooks fail open). Cross-session memory today is provided by two separate layers:

1. **Built-in Claude Code auto-memory** — `~/.claude/projects/<encoded>/memory/*.md` (7 user markdown files), with `MEMORY.md` loaded per-git-repo, first 200 lines / 25 KB. No global mode, no scoping, not AI-optimized.
2. **Orchestra wisdom** — `.claude/orchestra-wisdom.json` per project, categories `conventions/gotchas/decisions/failed_approaches`, entries `{text, ts, confidence, source}` (+ legacy plain-string compatibility). Readers: `agents/executor.md` (l. 94–117), `agents/conductor.md` (l. 120–124), `commands/wisdom.md`, `scripts/post-compact.sh` (l. 64–79), `scripts/session-start.sh` (l. 54–59), `skills/skill-extract/SKILL.md`.

Both layers are per-project/per-repo, isolated, with no fact sharing across projects, no temporal validity, and no controlled confidentiality scoping.

### Target state
A unified **cross-project graph memory** system shipped as part of the Orchestra plugin:
- A plugin-bundled **MCP server** (stdio) on top of **SQLite** (nodes/edges/observations + FTS5).
- **AI-optimized** writes via LLM distillation (atomic propositions, canonical entities, triples, merge instead of duplication).
- **First-class scoping** `global / project / private` (client A must not see client B's facts by default).
- **Temporal validity**, Graphiti-style (`valid_from`, `superseded_by`, `invalidated_at`, `confidence`).
- **SessionStart injection** of relevant memory into context (budget < 10 KB, DB query < 100 ms).
- Built-in auto-memory **disabled** (`autoMemoryEnabled: false` — a user-side change; the plugin cannot set this itself).
- Wisdom **absorbed** as a category/scope in the graph, with backward compatibility during the transition.
- **Migration** of existing markdown memories (7 files) + `orchestra-wisdom.json`.
- Subagents (scout, craftsman, executor…) get access via MCP tools (ToolSearch).

### Constraints
- **Runtime:** this is the first time the plugin gains a Node.js dependency. It must degrade fail-open (like the rest of Orchestra) if Node is missing.
- **Latency:** the SessionStart hook must stay fast; the DB query for injection must stay < 100 ms.
- **Injection limit:** SessionStart stdout / `hookSpecificOutput.additionalContext` has a hard limit of 10,000 characters.
- **Deploy:** dev → marketplace via rsync (`orchestra-marketplace/orchestra/`); the marketplace is **not a git repo** → a backup before changes is mandatory. rsync must not overwrite the fable-model experiment in the plugin cache.
- **Concurrency:** multiple sessions/subagents may write concurrently → SQLite WAL mode is mandatory.
- **Embeddings/hybrid retrieval:** deferred to v2 (v1 = FTS5 BM25 + graph expansion).
- **Kuzu / Neo4j:** rejected (see below).

---

## 2. Approaches to packaging and running the MCP server

### Approach A — TypeScript + esbuild bundle into a single JS file (RECOMMENDED)
Source in TS (`mcp-server/src/`), built via `esbuild` into a single `mcp-server/dist/server.mjs` (bundling all JS dependencies except the native SQLite). `.mcp.json` launches `node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs`.

- **SQLite driver:** primarily `node:sqlite` (stable since Node 22.5+, no native compilation, no `node_modules` in the distribution). Fallback detection: if `node:sqlite` is unavailable, the server prints diagnostics and MCP tools return a degraded status (fail-open).
- **Pros:** type safety, a single distributed artifact, readable development, easy testing (vitest). `node:sqlite` = zero native dependencies → rsync-safe, no `node_modules` bundle in the marketplace.
- **Cons:** a build step (devs must run `npm run build` before deploy); requires Node ≥ 22.5 for `node:sqlite`; FTS5 must be built into the SQLite build (`node:sqlite`'s SQLite has FTS5 compiled in — verify at acceptance).

### Approach B — Plain Node, no dependencies, pure `node:sqlite`, hand-written MCP JSON-RPC
No build, no TS, no esbuild — just `mcp-server/server.mjs` in plain JS, a manual implementation of the MCP stdio protocol.
- **Pros:** zero dependencies, zero build, maximally rsync-safe, minimal attack surface.
- **Cons:** a manual MCP protocol implementation = more code and more bugs (without `@modelcontextprotocol/sdk`), worse DX, no types. Distillation prompt handling and schema validation without libraries are fragile.

### Approach C — npx-installed dependency (`better-sqlite3` + MCP SDK via npm install)
`.mcp.json` launches a server that has `node_modules` installed at runtime / bundled in.
- **Pros:** `better-sqlite3` is the fastest synchronous SQLite driver, with robust FTS5.
- **Cons:** a **native module** (compiled at install time / prebuilt per-platform binaries) → rsyncing into the marketplace would carry platform-specific binaries, fragile; first install requires network/`npm install`; violates Orchestra's "fail-open with no dependencies" ethos. Rejected as the default.

### Recommendation
**Approach A** (TypeScript + esbuild bundle, `node:sqlite` as the primary driver with fail-open detection). It combines DX/type safety with zero native dependencies and rsync-safety. We use `@modelcontextprotocol/sdk` (bundled by esbuild into dist — it's pure JS), so we avoid the manual protocol implementation of approach B while avoiding the native dependency of approach C.

**Node fallback strategy:** if `node` is missing or < 22.5, the `.mcp.json` server won't boot → MCP tools are unavailable. Bash hooks (SessionStart) MUST therefore detect memory availability and fail open (no injection, no error) — exactly like today's `jq` detection.

### Rejected options (recap)
- **Kuzu** — archived after the Apple acquisition, uncertain future.
- **Neo4j** — overkill, a separate server process, heavy operational burden.
- **`better-sqlite3` as default** — native module, rsync/platform issues (see approach C).
- **Manual MCP protocol (approach B)** — unnecessary complexity when the SDK is pure JS and bundleable.
- **Markdown as source of truth** — rejected in the locked decisions (storage is opaque, AI-optimized).
- **Embeddings in v1** — deferred to v2 (hybrid RRF).

---

## 3. Data model (SQLite schema)

DB location: `~/.claude/orchestra-memory/graph.db` (user-global, not per-repo — this is the key to cross-project sharing). WAL mode mandatory.

### Scope model
Enum `scope`: `global` | `project` | `private`.
- `global` — surfaces in every project.
- `project` — bound to `project_id` (a stable key derived from cwd), surfaces only within the same project.
- `private` — bound to `project_id`, NEVER injected cross-project or into subagents outside the project; intended for sensitive client facts.

`project_id` = the first 16 hex characters of `sha256($PROJECT_ROOT)` — **the same algorithm as the boulder instance** in `session-start.sh` (l. 35), for consistency. A human-readable `project_label` (basename of cwd) is also stored, for `memory_inspect`.

### DDL

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;   -- for session/subagent concurrency

-- Entities (graph nodes), canonically named
CREATE TABLE nodes (
  id            INTEGER PRIMARY KEY,
  canonical     TEXT NOT NULL,          -- canonical entity name
  kind          TEXT NOT NULL,          -- person|project|tech|convention|decision|gotcha|failed_approach|preference|fact|other
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,                   -- NULL for global; otherwise sha256-16 of cwd
  project_label TEXT,
  created_at    TEXT NOT NULL,          -- ISO-8601
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_nodes_canonical ON nodes(canonical, scope, COALESCE(project_id,''));
CREATE INDEX idx_nodes_scope_proj ON nodes(scope, project_id);
CREATE INDEX idx_nodes_kind ON nodes(kind);

-- Aliases for entity dedup / canonicalization
CREATE TABLE node_aliases (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alias    TEXT NOT NULL
);
CREATE INDEX idx_aliases_alias ON node_aliases(alias);

-- Observations = atomic, self-contained propositions (one fact each)
CREATE TABLE observations (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,          -- distilled atomic proposition, token-dense
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,
  category      TEXT,                   -- convention|gotcha|decision|failed_approach|preference|fact (absorbs wisdom)
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
  source        TEXT,                   -- session-id | 'user' | 'migration:wisdom' | 'migration:md'
  valid_from    TEXT NOT NULL,          -- ISO-8601
  invalidated_at TEXT,                  -- NULL = still valid
  superseded_by INTEGER REFERENCES observations(id),  -- newer fact that replaced this one
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_obs_node ON observations(node_id);
CREATE INDEX idx_obs_scope_proj ON observations(scope, project_id);
CREATE INDEX idx_obs_valid ON observations(invalidated_at) WHERE invalidated_at IS NULL;
CREATE INDEX idx_obs_category ON observations(category);

-- Edges = relations between entities (triples: subject -[predicate]-> object)
CREATE TABLE edges (
  id            INTEGER PRIMARY KEY,
  src_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,          -- e.g. "uses", "depends_on", "prefers", "decided"
  dst_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL CHECK(scope IN ('global','project','private')),
  project_id    TEXT,
  confidence    TEXT NOT NULL DEFAULT 'medium',
  valid_from    TEXT NOT NULL,
  invalidated_at TEXT,
  superseded_by INTEGER REFERENCES edges(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_edges_src ON edges(src_id);
CREATE INDEX idx_edges_dst ON edges(dst_id);
CREATE INDEX idx_edges_scope_proj ON edges(scope, project_id);
CREATE UNIQUE INDEX idx_edges_triple ON edges(src_id, predicate, dst_id, scope, COALESCE(project_id,''))
  WHERE invalidated_at IS NULL;

-- FTS5 full-text over observations (BM25 relevance driver in v1)
CREATE VIRTUAL TABLE observations_fts USING fts5(
  text,
  content='observations',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Schema version, for future migrations
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key,value) VALUES ('schema_version','1');
```

### Entity canonicalization (v1, no embeddings)
On write (`memory_save`), LLM distillation returns a candidate entity name. The server:
1. Normalizes (lowercase, trim, whitespace collapse) → looks for an exact match in `nodes.canonical` and `node_aliases.alias` within the given scope/project.
2. On a match: reuse the existing `node_id`, optionally adding a new alias.
3. On no match: an FTS5 lookup for similar existing entities → the LLM (in the save prompt) decides merge vs. new entity.
4. New entity → `INSERT` + optional aliases.

Merging facts: a new observation is compared against existing valid ones for the same node/category; on semantic match the LLM either (a) supersedes the old one (`superseded_by`, `invalidated_at` = now), (b) discards the duplicate, or (c) adds it as a new independent fact.

---

## 4. MCP tool surface

Server name: `orchestra-memory`. Tools:

- **`memory_save`** — `{content, scope?, project_hint?, source?}` → distills the input into atomic propositions + triples, canonicalizes entities, merges with existing ones (supersede/dedup), writes nodes/observations/edges. **Distillation contract:** returns canonical entities, one fact = one self-contained sentence (no pronoun references to context), relations as `subject | predicate | object`; scope defaults to `project` if unspecified; NEVER writes raw text without distillation.
- **`memory_search`** — `{query, scope_filter?, project_id?, limit?, include_invalidated?}` → FTS5 BM25 over valid observations respecting scope (default: global + the current project, NEVER another project's private data) + 1-hop graph expansion from hit nodes. Returns token-dense text (one fact per line, triple-style).
- **`memory_link`** — `{src, predicate, dst, scope?}` → creates/updates an edge (triple) between canonical entities; idempotent via the unique triple index.
- **`memory_traverse`** (alias `memory_expand`) — `{entity, depth?, scope_filter?}` → a graph walk from a node to depth N, returning connected entities + their valid observations, respecting scope.
- **`memory_inspect`** — `{scope_filter?, project_id?, entity?}` → **debug/trust escape hatch**; generates a human-readable view (markdown) of stored data on demand, including metadata (confidence, valid_from, superseded_by, source). The only human-readable output in the system.
- **`memory_invalidate`** (alias `memory_forget`) — `{observation_id? | entity? | query?, reason?}` → sets `invalidated_at` = now (soft delete). Hard delete only with an explicit `{hard:true}`.
- **`memory_stats`** — `{}` → counts of nodes/observations/edges per scope, count of invalidated entries, DB size, a flag for entries older than 90 days. Used for SessionStart budget decisions.

### Wisdom compat tools
- **`wisdom_get`** — `{project_id?}` → reads facts with `category IN (convention,gotcha,decision,failed_approach)` from the graph, returned in a format compatible with the existing injection. Internally calls `memory_search`.
- **`wisdom_add`** — `{text, category, confidence?}` → a thin wrapper over `memory_save` with a forced category; preserves `/wisdom add` behavior.

During the transition, `commands/wisdom.md` and agent protocols call these compat tools instead of writing directly to `orchestra-wisdom.json`. Legacy JSON reads remain as a fallback until the migration is complete (see Phase 7).

---

## 5. Phases

Paths are always absolute, under `<project-root>/`.

### Phase 0 — MCP server project bootstrap
- **OWNS:** `mcp-server/package.json`, `mcp-server/tsconfig.json`, `mcp-server/esbuild.config.mjs`, `mcp-server/.gitignore`, `mcp-server/vitest.config.ts`
- **MUST NOT MODIFY:** anything in `.claude-plugin/`, `agents/`, `scripts/`, `commands/`.
- **Dependencies:** none. **Parallelizable:** no.
- **Risk:** wrong Node target choice → build/runtime incompatibility. Low.
- **Acceptance:** `npm install && npm run build` produces an empty `dist/server.mjs`; `npm test` runs.

### Phase 1 — Schema + storage layer
- **OWNS:** `mcp-server/src/db/schema.sql`, `mcp-server/src/db/connection.ts` (WAL, busy_timeout, migrations via meta.schema_version, `node:sqlite` detection with fail-open), `mcp-server/src/db/repository.ts` (CRUD, FTS5 search, graph expansion, canonicalization, supersede/invalidate), `mcp-server/test/repository.test.ts`
- **Dependencies:** Phase 0. **Parallelizable:** no (core).
- **Risk:** `node:sqlite` FTS5 unavailable → mitigation: an acceptance test for FTS5; sql.js fallback.
- **Acceptance:** unit tests — insert entity, dedup via alias, FTS5 BM25 search, supersede sets invalidated_at, scope filter isolates private.

### Phase 2 — MCP server core + tool surface
- **OWNS:** `mcp-server/src/server.ts`, `mcp-server/src/tools/{save,search,link,traverse,inspect,invalidate,stats}.ts`, `mcp-server/src/tools/wisdom-compat.ts`, `mcp-server/src/distill.ts`, `mcp-server/src/render.ts`, `mcp-server/test/tools.test.ts`, `.mcp.json` (root)
- **MUST NOT MODIFY:** plugin.json hooks, agents.
- **Dependencies:** Phase 1. **Parallelizable:** individual tool files in parallel once the repository API is frozen.
- **Risk:** distillation garbage-in → server-side shape validation, rejecting empty/duplicate entries.
- **Acceptance:** all 9 tools respond over MCP stdio; save→search round trip; memory_inspect returns readable markdown; scope isolation verified.

### Phase 3 — SessionStart hook integration (10 KB budget)
- **OWNS:** `scripts/memory-inject.sh` (new), an edit to `scripts/session-start.sh` (additive call).
- **Injects:** a project-scope index (valid project facts by confidence/recency) + top-K global facts + private facts of only the current project. CLI mode: `node dist/server.mjs --inject --project-id <key>`. Byte-count truncation, overflow → file + preview.
- **Dependencies:** Phase 2. **Parallelizable:** no.
- **Risk:** latency, exceeding 10 KB, Node absence → hard timeout, fail-open.
- **Acceptance:** injection ≤ 10,000 characters; hook continues silently without Node; query < 100 ms against a DB with ~1000 facts.

### Phase 4 — Write-discipline skill + PostCompact re-injection
- **OWNS:** `skills/memory-discipline/SKILL.md` (new), an edit to `scripts/post-compact.sh` (memory re-injection with legacy fallback).
- **Dependencies:** Phase 2. **Parallelizable:** yes — concurrently with Phase 3.
- **Risk:** write spam → a quality filter (non-obvious/reusable/stable) from skill-extract l. 64–71.
- **Acceptance:** skill triggers work; post-compact re-injection stays under budget; legacy wisdom JSON is read if the graph is empty.

### Phase 5 — Agent/command protocol migration (wisdom → graph memory)
- **OWNS:** `agents/executor.md` (l. 94–117), `agents/conductor.md` (l. 120–124), `commands/wisdom.md`, `skills/skill-extract/SKILL.md` (l. 18–61), `agents/{scout,craftsman,scholar,sentinel,architect}.md` (the "Memory access via orchestra-memory MCP tools" section)
- **Dependencies:** Phase 2, 4. **Parallelizable:** yes — up to 8 parallel craftsmen (disjoint files).
- **Risk:** wisdom backward-compat breakage → dual mode, legacy fallback until migration is confirmed.
- **Acceptance:** `/wisdom show` works from both the graph and legacy JSON; executor writes a fact to the graph; a subagent can call memory_search.

### Phase 6 — UX for disabling built-in auto-memory
- **OWNS:** `commands/memory-setup.md` (new command `/memory-setup`: check Node ≥ 22.5, verify the MCP server, run migration, print instructions for `"autoMemoryEnabled": false` — never sets it without confirmation), an edit to README.md.
- **MUST NOT MODIFY:** `~/.claude/settings.json` automatically.
- **Dependencies:** Phase 2, 7. **Parallelizable:** no.
- **Risk:** built-in + graph memory running concurrently → `/memory-setup` explicitly warns and verifies.
- **Acceptance:** `/memory-setup` diagnoses, migrates, prints exact instructions.

### Phase 7 — Migration command (markdown memories + wisdom.json import)
- **OWNS:** `mcp-server/src/migrate.ts`, `commands/memory-migrate.md` (dry-run default, `--commit` to write), `mcp-server/test/migrate.test.ts`
- **MUST NOT MODIFY:** the original markdown files (read-only).
- **Dependencies:** Phase 2. **Parallelizable:** yes — concurrently with 5/6.
- **Risk:** data loss / bad distillation → dry-run first, originals never deleted, idempotence, DB backup before --commit.
- **Acceptance:** dry-run report of 7 md files + N wisdom entries; --commit is idempotent; originals untouched.

### Phase 8 — Documentation
- **OWNS:** README.md, AGENTS.md, mcp-server/README.md. Plugin version → 2.1.0.
- **Dependencies:** Phases 1–7. **Parallelizable:** yes.

### Phase 9 — Deploy to the marketplace (BACKUP FIRST!)
- Backup: `cp -R orchestra-marketplace/orchestra orchestra-marketplace/orchestra.bak-2026-07-04`
- rsync dev → marketplace with `--exclude` for the fable-model experiment + `--exclude node_modules` (only `dist/` is deployed). `--dry-run` first, no `--delete` without review.
- **Dependencies:** ALL phases + validation.
- **Acceptance:** the marketplace works; the fable experiment is preserved; a backup exists; the MCP server boots from the marketplace path.

---

## 6. Parallelization

- **Sequential spine:** Phase 0 → 1 → 2.
- **Within Phase 2:** tool files in parallel once the repository API is frozen (worktree isolation).
- **After Phase 2, in parallel:** Track A (Phase 3), Track B (Phase 4), Track C (Phase 7) — disjoint files.
- **Phase 5:** up to 8 parallel craftsmen.
- **Phase 8:** 3 doc files in parallel. **Phases 6, 9:** sequential.

## 7. Risk matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Node.js missing / < 22.5 | Medium | High | Fail-open everywhere; bash detection; /memory-setup verification; node:sqlite = 0 native dependencies |
| SessionStart latency > 100 ms | Medium | High | Hard timeout, indexes, top-K limit, fail-open with no injection |
| Cross-project leakage | Low | Critical | Scope mandatory; default = global + current project; private NEVER cross-project; e2e test |
| Injection exceeds 10 KB | Medium | Medium | Byte-count truncation, overflow → file + preview |
| Wisdom backward-compat breakage | Medium | High | Dual mode, legacy fallback until migration confirmed |
| Distillation garbage-in | Medium | Medium | Server-side validation, dedup/merge, quality filter, memory_inspect audit |
| SQLite concurrency | High | Medium | WAL, busy_timeout=5000, short transactions |
| Migration data loss | Low | High | Dry-run default, read-only originals, idempotence, DB backup |
| rsync overwrites the fable experiment | Medium | High | Mandatory backup, --exclude, --dry-run, no --delete |
| FTS5 unavailable in node:sqlite | Low | High | Acceptance test in Phase 1; sql.js fallback |
| esbuild bundle incompatibility | Low | Medium | node:* as external; dist smoke test in Phase 2 |

## 8. Rollback strategy

- **P0–2:** purely additive → delete mcp-server/ + .mcp.json.
- **P3:** the memory block is a separate script called conditionally → remove the call.
- **P4:** delete the skill; the post-compact memory block is conditional.
- **P5:** legacy fallback preserved → restore original files (backup taken before editing).
- **P6:** delete the command; the user reverts autoMemoryEnabled to true.
- **P7:** migration is non-destructive; data rollback = DB backup restore or `memory_invalidate` with `source LIKE 'migration:%'`.
- **P9:** restore from orchestra.bak-<date>.
- **Globally:** built-in auto-memory is only disabled in Phase 6, and legacy wisdom JSON stays readable → a working memory layer is always available.

## 9. End-to-end acceptance scenarios

1. **Global cross-project surfacing:** a global fact from project A appears in project B's SessionStart injection.
2. **Private isolation:** a private fact from project A does NOT appear in either the injection or memory_search of project B.
3. **Project-scope isolation:** a project fact from A does not appear in B, and reappears on returning to A.
4. **Supersession:** "uses Express" → "migrated to Hono"; search returns only Hono; inspect shows the history.
5. **Entity canonicalization:** "Josef" and "Josef Krajkar" → a single entity with an alias.
6. **Injection under 10 KB** with ~1000 facts; query < 100 ms.
7. **Wisdom migration + compat:** import wisdom.json; `/wisdom show` from the graph; legacy strings tolerated.
8. **Markdown migration:** 7 files imported; originals untouched; re-run idempotent.
9. **Fail-open without Node:** the hook continues silently, the rest of Orchestra works.
10. **Subagent access:** scout finds orchestra-memory tools via ToolSearch and calls memory_search.
11. **memory_inspect trust:** readable markdown with confidence, valid_from, source.

---

## Execution order
Phase 0→1→2 sequentially (core) → parallel tracks A/B/C (Phases 3/4/7) → Phase 5 (parallel craftsmen) → Phase 6 → Phase 8 → Phase 9 (deploy with backup).
