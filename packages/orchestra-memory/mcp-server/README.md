# orchestra-memory MCP server

Stdio MCP server providing **cross-project graph memory** for Claude Code — a SQLite-backed store of entities, observations, and relations shared across every project on the machine, with first-class scoping (`global` / `project` / `private`) and temporal validity (supersession, soft-invalidation, confidence).

This document covers the server's internals: build, test, run, CLI modes, schema, scoping, and the MCP tool surface. For install instructions and the user-facing pitch, see the [package README](../README.md) one level up. See [`docs/design/graph-memory-design.md`](../../docs/design/graph-memory-design.md) for the original design rationale.

## Positioning

Most "AI memory" tools fall into one of two camps: a hosted service backed by vector embeddings, or a pile of markdown files a subagent greps through. `orchestra-memory` is neither — it's a local relational+full-text store with an explicit temporal model.

| | **orchestra-memory** | Mem0-style memory layers | markdown/JSON session-memory plugins (e.g. claude-mem) |
|---|---|---|---|
| Storage | Local SQLite file (`node:sqlite`), single process | Hosted API + vector database (or a self-hosted vector store) | Local markdown/JSON files, one per project or session |
| Retrieval | FTS5 BM25 full-text search + 1-hop graph expansion | Embedding similarity search | File re-read / grep, no ranking |
| Embeddings | None — no embedding model, no vector index, no dimensionality tuning | Required — needs an embedding provider and API calls per write/read | None |
| Network calls | None — fully offline, works on a plane | Yes — storage and retrieval (and usually embedding generation) go over the network | None |
| Temporal validity | Explicit: every fact carries `valid_from`, optional `invalidated_at`, optional `superseded_by`, and a `confidence` tier; superseding a fact is a first-class operation, not an overwrite | Typically implicit or absent — newer writes don't formally retire older ones | None — files are appended to or overwritten; there is no supersession or invalidation model |
| Scoping | `global` / `project` / `private`, with `project_id` deterministically derived from the working directory (no manual registration, no API keys) | Account- or user-scoped; no built-in per-repository isolation model | One store per project directory; no structured cross-project sharing |
| Dependencies | Zero native/npm dependencies in the deployed bundle (`@modelcontextprotocol/sdk` and `zod` are inlined by esbuild; SQLite comes from Node's own `node:sqlite`) | A hosted account and/or a vector DB deployment | None, but also no query language beyond text matching |
| Cost | Free, local | Usage-based / hosted pricing | Free, local |

The trade-off is honest: no semantic ("fuzzy meaning") search — BM25 is lexical, so it rewards shared vocabulary between the query and the stored fact rather than conceptual similarity. In exchange you get zero network dependency, zero embedding cost, a fully inspectable single-file database, and a temporal model that lets a fact be formally retired rather than silently shadowed by a newer one.

## Requirements

- **Node.js ≥ 22.5** — the server uses the `node:sqlite` builtin (`DatabaseSync`), stable since Node 22.5, with zero native/npm SQLite dependencies. Tested on Node 25.9.
- No other runtime dependencies are installed into the deployed bundle — `@modelcontextprotocol/sdk` and `zod` are bundled at build time by esbuild.

## Install

This package is distributed as part of the `orchestra-memory` Claude Code plugin via the Claude Code plugin marketplace — not via `npm` (the `mcp-server` package is intentionally `"private": true`; npm publication of the server is deferred, see the design plan). Install and configuration instructions live in the [package README](../README.md). The rest of this section is for people building or hacking on the server itself.

## Build

```bash
cd mcp-server
npm install
npm run build
```

`npm run build` runs `esbuild.config.mjs`, which:
1. Bundles `src/server.ts` and everything it imports into a single ESM file, `dist/server.mjs` (Node builtins, including `node:sqlite`, are left external — never inlined).
2. Copies `src/db/schema.sql` to `dist/schema.sql`. This is a manual step because esbuild only bundles JS: `connection.ts` loads the schema file via `readFileSync` relative to `import.meta.url`, and once bundled that resolves to `dist/schema.sql`, not `src/db/schema.sql`. If you ever see a "schema.sql not found" error after a build, check that this copy step actually ran.

Output: `dist/server.mjs` + `dist/server.mjs.map` + `dist/schema.sql`. These three files are everything the plugin needs at runtime — no `node_modules` in the deployed artifact.

## Test

```bash
npm test        # vitest run — 42 tests across repository/tools/migrate/backup
npm run test:watch
```

## Running

The server is normally launched by Claude Code itself via the plugin's `.mcp.json`:

```json
{
  "mcpServers": {
    "orchestra-memory": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs"]
    }
  }
}
```

With no arguments, `dist/server.mjs` starts as an MCP stdio server and registers 9 tools (see below). It also supports standalone CLI modes used by hooks/commands instead of the MCP protocol:

```bash
# SessionStart / PostCompact context injection — always exits 0 (fail-open)
node dist/server.mjs --inject --project-id <sha256-16-of-cwd> [--budget <bytes>]

# Legacy memory migration — dry-run by default, --commit to write
node dist/server.mjs --migrate [--commit] [--project-root <path>] [--wisdom <path>] [--memory-dir <path>]

# Daily rotating graph.db backup — always exits 0 (fail-open), see below
node dist/server.mjs --backup [--keep <n>]
```

All three CLI modes open the database directly (no MCP handshake) and are consumed by `scripts/memory-inject.sh`, `scripts/memory-backup.sh`, and `commands/memory-migrate.md` (in the `orchestra` package) respectively — see those for the full contract.

**`--help` / `-h`:** prints a usage summary of all CLI modes (the four above plus `--help`) to stdout and exits 0. The dispatcher (`main()` in `src/server.ts`) checks `--help`/`-h` first, before `--inject`/`--migrate`/`--backup`; invoking with no flag starts the default MCP stdio server. Any unrecognized flag also falls through to the default server mode.

### `--backup` mode (v2.2.0)

Rotating daily snapshot of `~/.claude/orchestra-memory/graph.db` into `~/.claude/orchestra-memory/backups/graph-<YYYY-MM-DD>.db`, invoked once per `SessionStart` via `scripts/memory-backup.sh` so a corrupted or bad-migration DB can be rolled back to "yesterday" (or further, per `--keep`).

- **Hot path (the common case):** if today's target file already exists, this is a pure `existsSync()` check — exit 0 immediately, no DB connection opened at all. This keeps the per-session-start cost negligible.
- **Fresh day:** WAL checkpoint (reusing `migrate.ts`'s `checkpointWal`, for the same "an uncheckpointed copy can silently drop recent writes" reason documented there) → `copyFileSync` into `backups/graph-<today>.db` → rotation.
- **Rotation:** after a successful copy, keeps only the newest `--keep` backups (default `7`, clamped to `≥ 1`) by filename date, deleting the rest. Only touches files matching `graph-<YYYY-MM-DD>.db` in the backups directory.
- **`--keep` timing gotcha:** a changed `--keep` value only takes effect on the *next fresh copy* — rotation is coupled to the copy step, not to the daily no-op path. If you bump `--keep` mid-day after today's backup already exists, nothing is rotated until tomorrow's first backup. This is fine for a fixed daily hook invocation but worth knowing if you ever call `--backup` manually to change retention.
- **Fail-open:** same contract as `--inject` — never throws, always exits 0, nothing on stdout, diagnostics (if any) on stderr only. No DB yet → no-op with a stderr note.

## Database

Location: `~/.claude/orchestra-memory/graph.db` (user-global, **not** per-repo — this is what makes cross-project sharing possible). WAL journal mode, `busy_timeout=5000` for concurrent sessions/subagents writing at once. Schema versioned via a `meta` table (`schema_version`); `connection.ts` throws on an unrecognized version rather than guessing a migration path.

Core tables: `nodes` (canonical entities), `node_aliases` (dedup/canonicalization), `observations` (atomic, self-contained facts with `valid_from`/`invalidated_at`/`superseded_by`/`confidence`), `edges` (subject–predicate–object triples with the same temporal fields), and `observations_fts` (FTS5 virtual table over `observations.text`, kept in sync via triggers).

### Scopes

| Scope | Meaning |
|---|---|
| `global` | Surfaces in every project. Never put client-identifying facts here. |
| `project` | Tied to a `project_id`; only surfaces in that project. |
| `private` | Tied to a `project_id`; never injected or searched cross-project — for client-confidential facts. |

### `project_id` derivation

`project_id` = first 16 hex characters of `sha256($PROJECT_ROOT + "\n")`. In shell terms:

```bash
echo "$PWD" | shasum -a 256 | cut -c1-16
```

The trailing newline from `echo` is **intentional and load-bearing** — it must match the exact byte sequence hashed elsewhere in the plugin (`scripts/memory-inject.sh`, `scripts/post-compact.sh`, and the `orchestra` package's boulder instance keys). `migrate.ts`'s `computeProjectId()` hashes `` `${projectRoot}\n` `` on the TypeScript side to match this exactly. If you ever reimplement this derivation anywhere else, get the trailing newline right or facts will silently land under a different `project_id` than the hooks expect. This makes `project_id` fully deterministic and derivable from the filesystem path alone — there is no registration step, no config file, and no ID to keep in sync manually.

## Security model: server-bound project identity

At startup, the MCP server computes its **own** `project_id` from `process.cwd()` (the exact same `computeProjectId()` derivation described above) and binds every tool call to it via an internal `ToolContext` (`src/tools/context.ts`). This closes the trust boundary that a naive "trust whatever `project_id` the caller passes" design would leave open: without it, any caller who knows or computes another project's `project_id` could read *and write* that project's `project`/`private`-scoped data simply by passing it as an argument.

The enforced rule, applied in every handler that accepts a `project_id` argument (reads and writes alike, `project` and `private` scope alike — `global` is unaffected since it was never gated by `project_id`):

- **Omitted** → defaults to this server instance's own `project_id`.
- **Supplied and equal to** this server instance's own `project_id` → allowed.
- **Supplied and different** → rejected with a tool error (`project_id mismatch: ...`), never silently narrowed or ignored.
- If the server's own identity is unavailable (`process.cwd()` failed — not expected in practice), it **fails closed for `private` scope**: no private reads or writes are permitted until an identity is available, and the tool result says so explicitly.

The two CLI modes (`--inject`, `--migrate`) are exempt from this check: they receive their project identity from a trusted, explicit shell argument (`--project-id` / `--project-root`), not from an untrusted MCP caller, so there is no mismatch to enforce — the CLI's own argument simply *is* the identity.

## MCP tool surface

| Tool | Purpose |
|---|---|
| `memory_save` | Write distilled facts (+ optional relations) into the graph. Caller must distill first — this is not a raw-text dump. A fact can carry `supersedes_observation_id` to atomically invalidate an older observation (found via its `#<id>` prefix in memory_search/memory_traverse output) in favor of the new one. |
| `memory_search` | FTS5 BM25 search over valid observations, scope-guarded, expanded 1 hop into the graph. Each result line is prefixed with a stable `#<id>` for later reference (invalidate/supersede). |
| `memory_link` | Create/update a `subject -predicate-> object` edge between two canonical entities. |
| `memory_traverse` | Graph walk from an entity to depth N, scope-guarded. |
| `memory_inspect` | The one human-readable debug view in the system — shows metadata (id, confidence, valid_from, superseded_by, source). |
| `memory_invalidate` | Soft-delete (default) or hard-delete (`hard: true`) observations, by id or by entity. Rejects invalidating an observation_id that belongs to a different project. |
| `memory_stats` | Counts per scope/table, invalidated counts, DB size, staleness (>90 days). |
| `wisdom_get` | Read wrapper over the graph filtered to wisdom categories (convention/gotcha/decision/failed_approach); includes `global` + your own project's `project` **and** `private` facts, for backward compatibility with `/wisdom show`. |
| `wisdom_add` | Write wrapper over `memory_save` with a forced category. `scope` defaults to `project` (your own project) — pass `scope: "global"` as an explicit opt-in to share wisdom across every project, or `scope: "private"` for client-confidential wisdom, for backward compatibility with `/wisdom add`. |

Full parameter shapes are defined as Zod schemas next to each handler in `src/tools/*.ts` and are also surfaced to the calling model via each tool's MCP `description`. These tools are discoverable through Claude Code's ToolSearch by any agent, in any plugin — you don't need commands from this package to use them; `wisdom_get`/`wisdom_add`/`/wisdom` are a convenience layer provided by the companion `orchestra` package, not a requirement.

## Fail-open behavior

Every entry point into this server is designed to degrade silently rather than break the rest of the session:

- If `node:sqlite` isn't available (Node < 22.5, or the build was missing at import time), `tryOpenDb()` returns `{ db: null, diagnostic }` instead of throwing; MCP tool calls then return a "disabled for this session" text result instead of crashing the server.
- `--inject` always exits 0, even on internal error — diagnostics go to stderr, stdout is empty, and the calling bash hook (`scripts/memory-inject.sh`) itself also checks for `node` on PATH and a built bundle before ever invoking the CLI.
- `--migrate` dry-run mode always exits 0. `--migrate --commit` is the one exception to fail-open: since it's about to write to a shared, cross-project database, it exits 1 on any failure instead of pretending success — data safety takes priority there.
- `--backup` always exits 0, even on internal error — diagnostics go to stderr, stdout is empty, and `scripts/memory-backup.sh` itself also checks for `node` on PATH and a built bundle before ever invoking the CLI, mirroring `memory-inject.sh`'s guard chain.

## Source layout

```
mcp-server/
├── src/
│   ├── server.ts              # MCP entry point; wires tool handlers into McpServer + dispatches CLI modes
│   ├── inject.ts               # --inject CLI mode
│   ├── migrate.ts              # --migrate CLI mode (mechanical wisdom import + markdown inventory)
│   ├── backup.ts                # --backup CLI mode (daily rotating snapshot)
│   ├── distill.ts              # Fact validation shared by memory_save
│   ├── render.ts               # Token-dense text rendering for tool responses
│   ├── db/
│   │   ├── schema.sql          # DDL (copied to dist/ at build time)
│   │   ├── connection.ts       # Open/migrate DB, node:sqlite detection, fail-open
│   │   └── repository.ts       # CRUD, FTS5 search, graph expansion, canonicalization, supersede/invalidate
│   └── tools/                  # One handler module per MCP tool, plus wisdom-compat.ts and
│                                #   context.ts (ToolContext / project_id trust-boundary helpers)
├── test/                       # vitest — repository, tools, migrate, backup, project-id contract
├── esbuild.config.mjs          # Bundle + schema.sql copy step
├── package.json
├── tsconfig.json
└── dist/                       # Build output — server.mjs + schema.sql. NOT gitignored: the
                                 # built bundle is intentionally checked in / shipped as-is and
                                 # deployed to the marketplace as part of the orchestra-memory
                                 # plugin (only node_modules/ is gitignored — see .gitignore).
                                 # Run `npm run build` after any source change so dist/ stays
                                 # in sync before committing/deploying.
```
