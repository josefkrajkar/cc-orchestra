# orchestra-memory

**Cross-project graph memory for Claude Code.** A Claude Code plugin that gives every session on your machine a shared, local, structured, temporally-aware memory — no embeddings, no network calls, no manual "remember this" step.

It works two ways:

- **Standalone** — install just this plugin and get durable, cross-project memory for any Claude Code session, discoverable through natural-language tool use (ToolSearch surfaces `memory_save`, `memory_search`, etc. to any agent, in any conversation).
- **Alongside `orchestra`** — install it together with the [`orchestra`](../orchestra) multi-agent orchestration plugin in this monorepo, and orchestra's agents (conductor, executor, craftsman, sentinel, scout, scholar, architect) automatically read and write to it for wisdom accumulation, gotchas, and decisions that outlive a single session and a single project. Without `orchestra-memory` installed, `orchestra` degrades gracefully to its own legacy per-project wisdom file — nothing breaks either way.

## What it is

Under the hood, `orchestra-memory` bundles a local MCP server (also named `orchestra-memory`) backed by SQLite via Node's built-in `node:sqlite` — one file, `~/.claude/orchestra-memory/graph.db`, shared by every project on the machine. There is no vector database, no embedding model, and no outbound network traffic: retrieval is full-text search over your own facts, on your own disk.

Two hooks make the memory layer feel automatic rather than something you have to invoke:

- **`SessionStart`** injects the most relevant facts for the current project into context as soon as the session begins.
- **`PostCompact`** re-injects a smaller slice right after context compaction, so long sessions don't lose their memory when the transcript gets summarized.

Everything else — deciding what's worth remembering, distilling it into a fact, choosing a scope — is done by the calling model through the MCP tool surface (`memory_save`, `memory_search`, `memory_link`, `memory_traverse`, `memory_inspect`, `memory_invalidate`, `memory_stats`, plus `wisdom_get`/`wisdom_add` compatibility wrappers). Full tool reference, schema, and CLI details live in [`mcp-server/README.md`](mcp-server/README.md).

## The memory model

### Nodes, observations, edges

Facts ("observations") are attached to canonical entities ("nodes"); entities can be linked to each other via typed relations ("edges", `subject -predicate-> object`). Search is **FTS5 BM25 full-text over observations, expanded one hop into the graph** — so a query that matches a fact about an entity also surfaces its directly-linked neighbors, without needing an embedding model to find them.

### Scopes

| Scope | Visibility | Typical use |
|---|---|---|
| `global` | Every project on the machine | Facts that are true no matter what you're working on — user preferences, cross-cutting conventions. Never client-identifying data. |
| `project` | Just the current project | The default. Conventions, gotchas, decisions specific to this codebase. |
| `private` | Just the current project, and never surfaced cross-project even by mistake | Client-confidential facts, where the cost of an accidental leak outweighs the convenience of sharing. |

Scoping is enforced server-side: the server binds to its **own** `project_id` (derived deterministically from its working directory, not passed in by the caller) at startup, and rejects any `project`/`private`-scoped call that tries to name a different project. There is no manual project registration and no ID to configure — the identity comes from the filesystem path alone. See [`mcp-server/README.md`](mcp-server/README.md#project_id-derivation) for the exact derivation and the trust-boundary details.

### Temporal validity

Facts aren't edited in place. Each observation carries `valid_from`, an optional `invalidated_at` (soft delete), an optional `superseded_by` (a pointer to the newer fact that replaced it), and a `confidence` tier (`high`/`medium`/`low`). Replacing a stale fact is a first-class operation — search or inspect it to find its `#<id>`, then save the new fact with `supersedes_observation_id` set to that id, and the old one is atomically invalidated and marked as superseded. History stays inspectable rather than silently overwritten.

## Install

Distribution is currently the Claude Code plugin marketplace only — there is no npm package to install (the bundled MCP server ships as a prebuilt artifact and is intentionally marked `"private": true` for now).

```bash
# 1. Register the marketplace that hosts this plugin (once per machine)
claude plugin marketplace add jKrajkar/cc-orchestra --scope user

# 2. Install orchestra-memory on its own...
claude plugin install orchestra-memory@orchestra

# ...or alongside orchestra, for the full multi-agent + memory experience
claude plugin install orchestra@orchestra

# 3. Verify
claude plugin list
```

Use `--scope project` instead of `--scope user` to install only for the current project. After install, nothing further is required — the `SessionStart` and `PostCompact` hooks activate automatically, and the MCP server starts on demand.

### Requirements

- **Node.js ≥ 22.5**, for the `node:sqlite` builtin the server depends on. If Node is missing or too old, every hook and tool call fails open silently (see below) — the rest of your Claude Code session is unaffected.

## Where your data lives

The database is a single file at:

```
~/.claude/orchestra-memory/graph.db
```

This location is deliberately **user-global, not per-repository** — that's what makes cross-project sharing possible. It's a plain SQLite file in WAL mode, so it's safe for concurrent sessions and subagents to write to it at once, and you can inspect it yourself with any SQLite client if you want to see exactly what's stored.

**Daily backups.** Once per `SessionStart`, a rotating snapshot is taken into:

```
~/.claude/orchestra-memory/backups/graph-<YYYY-MM-DD>.db
```

The last 7 daily snapshots are kept by default (older ones are pruned automatically); this gives you a rollback point if a bad migration or a corrupted write ever needs undoing. On the overwhelmingly common case — today's backup already exists — this is a single file-existence check with no database connection opened, so it adds negligible cost to session startup.

## It degrades gracefully

Nothing about this plugin is allowed to break your session. Every entry point — both hooks and every MCP tool — is fail-open by design:

- No Node on `PATH`, or Node older than 22.5, or the bundled server not built: hooks silently no-op (no output, exit 0), and MCP tool calls return a plain "disabled for this session" message instead of erroring.
- A missing or unreachable database behaves the same way — you get a clear "disabled" message from the tools, not a crash.
- The one deliberate exception is a *committed* legacy-memory migration (`--migrate --commit`): because that step writes into the shared, cross-project database, it reports failure loudly rather than silently pretending to succeed. Everything else prioritizes never interrupting your work over surfacing an error.

## Experimental: lazy injection index mode

By default, both hooks inject a full dump of every fact visible to the current project. There's also an experimental **index mode** — a much smaller summary (a handful of pinned high-confidence facts plus a compact roster of every known entity, e.g. `orchestra plugin (5)`) that the model expands on demand with `memory_search` instead of receiving everything upfront. It targets roughly a ~500-token footprint versus the full dump.

This ships **off by default** until it's been validated in practice — the full dump remains the default behavior. To opt in, set an environment variable before your Claude Code session starts:

```bash
export ORCHESTRA_MEMORY_INJECT_MODE=index
```

Unset, or set to anything other than exactly `index`, both hooks fail open to the existing full-dump behavior — no script edits required either way.

## Learn more

- [`mcp-server/README.md`](mcp-server/README.md) — server internals: build/test/run, CLI modes (`--inject`, `--migrate`, `--backup`), full schema, the security model behind scoping, and the complete MCP tool reference. Also has a head-to-head positioning comparison against hosted/embedding-based memory layers and plain markdown session-memory approaches.
- [Repository root README](../../README.md) — how this plugin fits together with `orchestra`, the multi-agent orchestration plugin it's designed to complement.

## License

MIT.
