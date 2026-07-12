# Plan: Remote-Backed Graph Memory (Docker server + thin local MCP)

> Status: implemented (Waves 1-3, 2026-07-11/12). All phases below (0-5) have shipped; see per-task checkboxes and notes in section 4 for what actually landed and where the implementation refined the original plan.
> Origin: /orchestrate planning run (scout + scholar + architect), 2026-07-11.
> Scope: `packages/orchestra-memory` — migrate from local-only SQLite to an optional client-server model.

## 0. Answer to the architecture question

**Yes, the idea makes sense — but not as "the DB in Docker with the MCP talking to it via a raw DB/URL connection."** A database exposed over a URL is a database port, not a memory service. The right shape is: **a memory *server process* in Docker that owns the SQLite file, exposing a small RPC API; the existing local MCP becomes a thin client that talks to it when configured, and otherwise keeps using local SQLite exactly as today.**

### Recommended topology: **(C) Hybrid** — local stdio MCP with a pluggable backend

- **Unset `ORCHESTRA_MEMORY_URL`** → today's behavior, local SQLite, zero config, zero network. This stays the default forever.
- **Set `ORCHESTRA_MEMORY_URL`** → the same local stdio process routes all data access to the remote server over HTTP, with bounded timeouts and fail-open degradation.

**Why not (B) pure remote MCP over Streamable HTTP:**

1. **Hooks don't speak MCP.** `--inject` (SessionStart), `--backup`, `--migrate`, and `post-compact.sh` exec the CLI directly and read the DB — they never go through the MCP transport. A pure-remote MCP leaves every hook stranded; they'd each need their own remote path anyway, so you don't escape building a client.
2. **Fail-open mandate.** SessionStart must be instant and must never break the session. Putting the network on the hot path of every session start (with no local fallback) violates the project's hardest invariant.
3. **project_id is a *client* fact.** It is `sha256($CWD)` of the *project directory the user is working in*. Only the local process knows that cwd. In a shared container the server's cwd is meaningless. The client must assert project_id — which is exactly what the `--inject` hook already does (`--project-id "$PROJECT_ID"`).
4. **Backward compatibility.** Existing single-machine users must not be forced onto Docker.

**Why not (A) thin MCP → custom HTTP API → server as three tiers:** the "custom HTTP API" and "the server" are the same process. There is no third tier. (A) collapses into (C)'s server component.

## 1. API boundary: **Repository-interface RPC** (not MCP-over-HTTP, not REST resources)

The server exposes `POST /rpc` with `{ method, params }` mapping **1:1 onto the existing `Repository` interface** (`src/db/repository.ts`), plus `GET /health`.

**Rationale:**

- The `Repository` seam already exists and is the single security-critical data boundary (`scopeGuard()` lives there). Mirroring it means the **entire policy layer stays client-side and unchanged**: tool handlers, `resolveProjectId`, rendering, byte-budgeting, near-dup logic. Only the data-access implementation swaps local ↔ remote.
- The same handler unit tests keep passing against either a local `Repository` or a `RemoteRepository` — the interface is the contract.
- **MCP-over-HTTP** would push tool handlers and the trust boundary server-side, still requires the client to send its project_id/cwd, duplicates the MCP protocol layer, and doesn't help hooks. No benefit, more surface.
- **REST resource API** would force a redesign around resources instead of the existing verb-shaped methods — pure cost.

**Transport implementation:** Node built-in `node:http` server + global `fetch` on the client. **Do not add express.** This preserves the package's defining "zero runtime deps beyond the MCP SDK + zod" property and keeps the Docker image tiny.

**Critical prerequisite:** several call sites bypass the repository with direct SQL and must be folded back into it first, or the remote backend will silently miss reads. These are Phase 0.

**One remaining direct-SQL bypass, deliberately out of Phase 0's scope:** `src/migrate.ts`'s `importWisdomEntry()` still does a raw `db.prepare('UPDATE observations SET valid_from = ? WHERE id = ?').run(...)` after `handleSave()`, to preserve a wisdom-JSON entry's original historical timestamp (`handleSave()` always stamps "now"). This is reachable only from `--migrate --commit`, which — per Task 4.3's Option B — refuses entirely whenever `ORCHESTRA_MEMORY_URL` is set. So this bypass is local-only, cannot be reached over `/rpc`, and does not weaken the "Repository is the single security-critical data boundary" invariant for anything the remote backend serves. It is a deliberate, scoped exception, not an oversight left over from Phase 0.

## 2. Trust model for project_id / scopes on a shared server

The trust boundary **splits** across client and server:

| Concern | Where enforced | Mechanism |
|---|---|---|
| Which project am I? | **Client** | `computeProjectId(cwd)` — same sha256-16 derivation used today. The client asserts `project_id` in every RPC. |
| LLM can't spoof another project in tool args | **Client** | `resolveProjectId()` stays; rejects tool-arg `project_id` that differs from the client's own. Unchanged. |
| Caller is allowed to talk to the server at all | **Server** | `Authorization: Bearer <token>` validated against `ORCHESTRA_MEMORY_SERVER_TOKEN`. |
| Scope visibility (global vs project/private) | **Server** | The server runs the *real* `Repository`, so `scopeGuard(project_id)` executes server-side on the client-asserted project_id. |
| Ownership of id-only mutations/reads (`addAlias`, `findSupersedeTarget`, `invalidate`/`supersedeObservation`/`Edge` — six methods with no `project_id` param) | **Server** | `handleRpc()` requires and format-validates the `x-orchestra-project-id` header on every `/rpc` call, cross-checks it against any params-embedded `project_id` (403 on mismatch), then resolves each referenced row's own scope/`project_id` (via `findSupersedeTarget` or the internal-only `findNodeOwner`/`findEdgeOwner` lookups) and rejects with 403 — or, for the read-only `findSupersedeTarget`, nulls the result — unless the row is global or owned by the header's project. Closes an id-enumeration + oracle gap in the raw `/rpc` dispatch. |
| DNS-rebinding / browser attacks | **Server** | Validate `Origin`; bind `127.0.0.1` by default. |

**Token model — v1: single shared bearer token = single logical tenant.**

- Fits the actual use case: one user (or one trusted team) sharing memory across machines.
- **Requires no schema change.** The token gates access; the existing `scopeGuard` handles project/global/private exactly as today. Schema stays at v1.
- **Explicit semantic to document:** with a shared token, **`private` scope means "this project only," not "this user only."** Anyone holding the token and working in the same project directory sees that project's private facts. State this loudly in the setup docs.

**Per-user tokens / true multi-user isolation is explicitly deferred** (see §6). It would add a `tenant_id` column (schema v2) and namespace project/private by tenant.

**Server startup change:** in `--serve-http` mode the server must **not** bind its own cwd-derived `ownProjectId` (its cwd is `/`, meaningless). Instead it trusts the per-request client-asserted `project_id` (after token auth). `resolveProjectId`'s mismatch check is a *client-side* guard and does not run server-side in serve mode.

## 3. Server package layout & config surface

**Single package, new run mode — do NOT create `packages/orchestra-memory/server/`.**

The Docker image is *the same bundle* run as `node dist/server.mjs --serve-http`. Client and server share `connection.ts`, `repository.ts`, and `schema.sql` **by being the same build artifact**. This is the single strongest mitigation against schema/version drift: there is nothing to drift.

New files (all under `mcp-server/src/`):

- `config.ts` — centralized env reads.
- `serve.ts` — `node:http` server, `/rpc` dispatch, `/health`, auth + Origin middleware.
- `remote/protocol.ts` — shared request/response types (one per `Repository` method).
- `remote/client.ts` — `RemoteRepository implements Repository` via `fetch`.

**Env var surface:**

| Var | Side | Default | Purpose |
|---|---|---|---|
| `ORCHESTRA_MEMORY_URL` | client | *(unset)* | Set → remote backend. Unset → local SQLite (default). |
| `ORCHESTRA_MEMORY_TOKEN` | client | — | Bearer token sent to server. |
| `ORCHESTRA_MEMORY_TIMEOUT_MS` | client | `1000` (tools), `500` (inject) | Per-request timeout → fail-open. |
| `ORCHESTRA_MEMORY_DB_PATH` | both | `~/.claude/orchestra-memory/graph.db` (client), `/data/graph.db` (container) | **New** — removes the hardcoded path in `connection.ts`. |
| `ORCHESTRA_MEMORY_LISTEN` | server | `127.0.0.1:8787` | Bind address. |
| `ORCHESTRA_MEMORY_SERVER_TOKEN` | server | — | Expected bearer token(s). |
| `ORCHESTRA_MEMORY_ALLOWED_ORIGINS` | server | *(none/deny)* | Origin allowlist. |
| `ORCHESTRA_MEMORY_INJECT_MODE` | client | `full` | Existing — keep. |

`.mcp.json` inherits the parent process environment, so exported vars reach the stdio server without change. **Verify** (Phase 5) whether Claude Code also supports `${VAR}` expansion inside `.mcp.json` `"env"` for the current version; document the reliable path (shell export) regardless.

## 4. Phased execution plan

Task sizing target: each ≤15 tool calls (S/M). `repository.ts` is a shared hotspot — one task owns all its additions so others can edit their own files in parallel.

### Phase 0 — Consolidate the Repository seam (prerequisite, blocks everything)

Fold all direct-SQL bypasses into `Repository` so there is exactly one data boundary to remote.

- [x] **Task 0.1** — Extend `Repository` with all missing read methods + implementations + unit tests.
  - OWNS: `src/db/repository.ts`, `test/repository.test.ts`
  - Add: `fetchVisibleEdges` (from search.ts), `findSupersedeTarget` + `findNearDuplicate` (from save.ts, incl. BM25 rank threshold), `listNodes` + `listObservationsForNode` (from inspect.ts), `listWisdomRows` (from wisdom-compat.ts), and inject queries `injectObservations(scope)`, `highConfidenceObservations(scope)`, `entityRoster` (from inject.ts).
  - Every new read method MUST route through `scopeGuard()` — no exceptions.
  - Risk: BM25 threshold + FTS `MATCH` semantics must be preserved exactly. Acceptance: existing save/search tests pass unchanged.
- [x] **Task 0.2** — Rewrite `search.ts` to call `repo.fetchVisibleEdges`. OWNS: `src/tools/search.ts`. Dep: 0.1.
- [x] **Task 0.3** — Rewrite `save.ts` near-dup + supersede to repo calls. OWNS: `src/tools/save.ts`. Dep: 0.1.
- [x] **Task 0.4** — Rewrite `inspect.ts` to repo calls. OWNS: `src/tools/inspect.ts`. Dep: 0.1.
- [x] **Task 0.5** — Rewrite `wisdom-compat.ts` to repo calls. OWNS: `src/tools/wisdom-compat.ts`. Dep: 0.1.
- [x] **Task 0.6** — Rewrite `inject.ts` query functions to repo calls. OWNS: `src/inject.ts`. Dep: 0.1.
- **Parallelization:** 0.2–0.6 run in parallel after 0.1 lands (disjoint file ownership).
- **Acceptance (phase):** full existing test suite green; no `db.prepare(` remains outside `repository.ts` (grep gate).

### Phase 1 — RPC protocol, server, and client

- [x] **Task 1.1** — Wire protocol types. OWNS: `src/remote/protocol.ts`. One typed `{method, params}`/`{result|error}` pair per `Repository` method. Dep: 0.1.
- [x] **Task 1.2** — HTTP server (`--serve-http`). OWNS: `src/serve.ts` + `main()` branch in `src/server.ts`. `node:http` server; `POST /rpc` dispatches to a local `Repository` (opened via `ORCHESTRA_MEMORY_DB_PATH`); `GET /health` returns `{ schemaVersion, serverVersion, ok }`. Server does NOT bind cwd project identity. Dep: 1.1.
- [x] **Task 1.3** — `RemoteRepository`. OWNS: `src/remote/client.ts`. Implements `Repository` via `fetch`; every call has a timeout; on timeout/network/5xx it **throws a typed "remote unavailable" error** (caller degrades — never hangs). Dep: 1.1.
- [x] **Task 1.4** — Backend selection in `main()`. OWNS: `src/server.ts`. If `ORCHESTRA_MEMORY_URL` set: build `RemoteRepository`, probe `/health` at startup with a short timeout; on failure fall back to `disabledResult()` (tools return "disabled this session") — preserving fail-open. If unset: local, unchanged. Dep: 1.2, 1.3.
- **Acceptance:** with a local `--serve-http` instance, all 9 tools behave identically over remote as over local (parity test in Phase 5).

### Phase 2 — Auth & trust enforcement

- [x] **Task 2.1** — Server auth + Origin. OWNS: `src/serve.ts` (auth section) or `src/remote/auth.ts`. Reject missing/wrong bearer with 401; validate `Origin` against allowlist; constant-time token compare; never log token or full request bodies. Single-tenant model — no schema change. Dep: 1.2.
- [x] **Task 2.2** — Client project_id assertion. OWNS: `src/remote/client.ts` (+ note in `context.ts`). `RemoteRepository` attaches `project_id` (from the client's `computeOwnProjectId()`) and bearer token to every request. Dep: 1.3. Implemented as part of `RemoteRepository`'s construction (no separate task report — folded into 1.3's client implementation); every RPC call attaches the `x-orchestra-project-id` header and `Authorization: Bearer` token.
- **Acceptance:** request with no/invalid token → 401; two clients with different project_ids cannot read each other's project/private rows through the same server (integration test in 5.2).

### Phase 3 — Docker packaging (parallelizable with Phase 2 once 1.2 lands)

- [x] **Task 3.1** — `Dockerfile`. OWNS: `packages/orchestra-memory/Dockerfile`, `.dockerignore`. Base `node:22-slim` (NOT alpine — `node:sqlite`/glibc; verify musl support before considering alpine). Copy built bundle + `schema.sql`. `CMD node dist/server.mjs --serve-http`. Non-root user; `/data` volume.
- [x] **Task 3.2** — `docker-compose.yml` + `.env.example`. OWNS: `packages/orchestra-memory/docker-compose.yml`, `.env.example`. Named volume `/data`; `HEALTHCHECK` hitting `/health`; `restart: unless-stopped`; bind `127.0.0.1` by default; env for token/listen. Document reverse-proxy + TLS for LAN/multi-machine. Dep: 3.1.
- [x] **Task 3.3** — Server-side backup. OWNS: `src/backup.ts` (path-configurable via `ORCHESTRA_MEMORY_DB_PATH`), compose doc. Use SQLite `.backup` semantics into the volume; document `docker exec` backup + restore. Dep: 3.1. `--backup` needed zero code changes (already path-configurable via `ORCHESTRA_MEMORY_DB_PATH`); the task added the Docker backup/restore section to `mcp-server/README.md`, including the WAL/SHM-sidecar-cleanup restore gotcha.

### Phase 4 — Hooks & CLI remote-awareness (the delicate fail-open zone)

- [x] **Task 4.1** — `--inject` remote mode. OWNS: `src/inject.ts`, `scripts/memory-inject.sh`. When `ORCHESTRA_MEMORY_URL` set: bounded-timeout (`500ms`) remote fetch of the inject payload; on ANY failure fall back to local DB if present, else empty; always exit 0. Bash script passes URL/token env through. Dep: 1.3, 0.6. `scripts/memory-inject.sh` needed no functional change — env vars pass through via normal shell inheritance.
- [x] **Task 4.2** — `--backup` / post-compact awareness. OWNS: `scripts/memory-backup.sh`, `scripts/post-compact.sh`, `src/backup.ts`. When URL set: client `--backup` becomes a no-op (server owns backups); post-compact inject uses the 4.1 path. Dep: 4.1, 3.3. `post-compact.sh` needed no change (inherits 4.1's remote-aware fallback chain automatically via the shared CLI entry point).
- [x] **Task 4.3** — `--migrate` remote mode (LOW priority, deferrable). OWNS: `src/migrate.ts`. When URL set, import legacy JSON through `RemoteRepository` upserts. Dep: 1.3. **Option B implemented, not Option A** — see the implementation note appended after this list.
- **Acceptance:** with server DOWN and URL set, SessionStart completes with empty injection and exit 0, measurably fast (bounded by timeout).

**Implementation note (Task 4.3 — Option B chosen over Option A):** rather than porting `--migrate --commit`'s wisdom-JSON import through `RemoteRepository`, the shipped behavior is a clean, immediate refusal (stderr message + exit 1) when `ORCHESTRA_MEMORY_URL` is set, directing the user to run `--migrate --commit` on the server host instead. Three real correctness gaps made Option A risky rather than merely tedious: `RemoteRepository` has no transaction verb (an atomic local `BEGIN`/`COMMIT` import would become a partially-committed, non-rollback-able sequence of individual RPCs), the wisdom import's direct-SQL `valid_from` timestamp patch (see the Phase-0 note below) has no remote equivalent, and `commitMigration()`'s local-file backup step doesn't apply to a remote server that owns its own backups. Dry-run (no `--commit`) is completely unaffected in either case — it is pure local file I/O with no DB or network access. Full tradeoff analysis: `.claude/orchestra/reports/task-4.3.md`.

### Phase 5 — Config, tests, docs, rollout

- [x] **Task 5.1** — `config.ts` + de-hardcode DB path. OWNS: `src/config.ts`, `src/db/connection.ts` (read `ORCHESTRA_MEMORY_DB_PATH`). Dep: none (can start early alongside Phase 1).
- [x] **Task 5.2** — Integration test vs a real server. OWNS: `test/remote-integration.test.ts`. Spawn `--serve-http` on ephemeral port + temp DB; run `RemoteRepository` through the full tool set; assert local/remote parity, 401 on bad token, cross-project isolation, timeout→degrade. Dep: Phases 1–2. While building this suite, two real RPC-transport bugs were found and fixed by the executor (trailing-`undefined`-serialized-as-`null` params bypassing server-side JS defaults, and void-returning methods' bare `{}` response body being misread as a malformed response) — both are resolved, not open issues.
- [x] **Task 5.3** — Docs. OWNS: `packages/orchestra/commands/memory-setup.md`, `packages/orchestra-memory/README.md`, `docs/design/graph-memory-design.md`. Cover compose bring-up, env matrix, the `private == per-project` semantic, security (token, TLS, Origin, localhost bind), backup/restore. Dep: Phases 1–4. (Actual OWNS for this task, per its final spec, was `packages/orchestra-memory/README.md`, `packages/orchestra/commands/memory-setup.md`, and this plan document itself — not `docs/design/graph-memory-design.md`, which does not exist in this repo.)
- [x] **Task 5.4** — Versioning & rollout. OWNS: `.mcp.json`, `package.json`, `server.ts` health handshake. Bump to `0.3.0`; client refuses (fail-open → disabled) if `/health` `schemaVersion` ≠ local `SCHEMA_VERSION`; feature flag default OFF; verify `.mcp.json` env passthrough. Dep: 1.4.

## 5. Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| **Latency in SessionStart** hook when remote | High | Bounded 500ms timeout on `--inject`; fail-open to local DB then empty; never block. |
| **Breaking the fail-open mandate** | High | Every remote call has a timeout and degrades to "disabled this session" (tools) or empty+exit 0 (hooks). Startup `/health` probe gates remote mode. Integration test 5.2 asserts server-down behavior. |
| **Schema drift between client & server** | High | Single package = single build artifact; `/health` returns `schemaVersion`; client fails open on mismatch (Task 5.4). |
| **Token leakage** (logs, env dumps, `.env`) | High | Never log Authorization header or bodies; `.env.example` only; localhost bind by default; TLS required for any non-localhost exposure; constant-time compare. |
| **`private` scope leaks across users** under shared token | Med | Documented as a deliberate v1 semantic (`private` == per-project). True per-user isolation is the deferred per-tenant-token feature. |
| **Concurrent writes from multiple machines** | Med | A single server process serializes all writes to one SQLite connection; WAL + `busy_timeout=5000` already handle brief contention. Fine for the stated low write volume. |
| **WAL checkpoint / growth in long-lived container** | Med | Periodic checkpoint on backup; document `PRAGMA wal_checkpoint(TRUNCATE)` in the backup path; healthcheck surfaces DB errors. |
| **`node:sqlite` unavailable in container base image** | Med | Pin `node:22-slim` (≥22.5); verify at image-build, not runtime. |
| **DNS rebinding / cross-origin** | Med | Origin allowlist + localhost bind + reverse-proxy guidance. |
| **Regression from Phase 0 seam consolidation** | Med | Phase 0 is pure refactor behind existing tests; grep gate ensures no `db.prepare` escapes `repository.ts`; done before any remote work so it's independently revertible. |

## 6. Explicitly OUT of scope (do NOT build)

- **No Postgres / no external DB.** SQLite in one server process is sufficient for the stated load.
- **No libSQL / sqld / embedded replicas.** Revisit only if write contention is actually measured.
- **No vector search / embeddings.** FTS5 BM25 stays the retrieval mechanism.
- **No CRDT / offline-first sync engine.** Remote-only with graceful degradation. A local read-through cache is a *possible future* enhancement.
- **No OAuth2 / identity provider.** Self-hosted single/shared bearer token only.
- **No per-user tenancy in v1.** Documented future extension (adds `tenant_id`, schema v2).
- **No rewrite to MCP-over-HTTP.** The Repository-RPC boundary is deliberate.
- **Do not remove or regress local mode.** Local SQLite remains the default; remote is strictly opt-in.

## Relevant files

- `mcp-server/src/db/repository.ts` — the seam to mirror (Phase 0 + 1.1)
- `mcp-server/src/db/connection.ts` — de-hardcode DB path (Task 5.1)
- `mcp-server/src/server.ts` — add `--serve-http`, backend selection (1.2, 1.4)
- `mcp-server/src/tools/context.ts` — trust-boundary logic (split client/server, Phase 2)
- `mcp-server/src/inject.ts` — direct-SQL bypass + remote inject (0.6, 4.1)
- `mcp-server/src/tools/{search,save,inspect,wisdom-compat}.ts` — bypasses (0.2–0.5)
- `scripts/{memory-inject,memory-backup,post-compact}.sh` — hooks (Phase 4)
- `.mcp.json`, `mcp-server/package.json` — env passthrough, version bump (5.4)
- New: `mcp-server/src/{config.ts,serve.ts,remote/protocol.ts,remote/client.ts}`, `packages/orchestra-memory/{Dockerfile,docker-compose.yml,.env.example}`
