# Contributing

Thanks for your interest in contributing. This repo is a monorepo containing
two independently installable Claude Code plugins. Please read this whole
document before opening a PR — the `project_id` contract and the
`dist/`-is-committed rule below are easy to break by accident.

## Repository layout

```
packages/
├── orchestra-memory/        # Plugin A — MCP graph-memory server + session injection
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json             # registers the orchestra-memory MCP server
│   ├── mcp-server/            # TypeScript source, tests, and the committed build
│   │   ├── src/
│   │   ├── test/
│   │   ├── dist/              # prebuilt bundle — committed, see gotcha below
│   │   └── esbuild.config.mjs
│   └── scripts/                # SessionStart / PostCompact hooks for memory only
└── orchestra/                # Plugin B — orchestration (agents, commands, skills)
    ├── .claude-plugin/plugin.json
    ├── agents/ commands/ skills/ conventions/
    └── scripts/                 # orchestration hooks (boulder + legacy wisdom fallback)
```

- **`packages/orchestra-memory`** is an MCP graph-memory plugin: a stdio MCP
  server backed by SQLite (`node:sqlite`) with FTS5 full-text search plus
  1-hop graph expansion, and the shell hooks that inject relevant memory into
  a session and rotate backups. The server itself lives under `mcp-server/`.
- **`packages/orchestra`** is the orchestration plugin (agents, commands,
  skills, conventions) that Orchestra ships. It works standalone; when
  `orchestra-memory` is also installed it gets richer cross-project memory,
  but it never hard-depends on it (see "Soft-companion decoupling" below).

## Building and testing the MCP server

All server work happens inside `packages/orchestra-memory/mcp-server`:

```bash
cd packages/orchestra-memory/mcp-server
npm install
npm run build
npm test
```

- **Node.js ≥ 22.16.0 is required.** The server uses `node:sqlite`, which is
  usable without flags only from Node 22.13 onward, and whose bundled SQLite
  is compiled with FTS5 (required by the schema) only from Node 22.16 onward. There is no native
  module / `better-sqlite3` fallback — that dependency was deliberately
  rejected so the plugin ships with zero native/platform-specific binaries.
- `npm test` runs the vitest suite directly against `src/` (build-independent)
  and currently expects **44 passing tests**, including the `project_id`
  contract test described below. If your change reduces that count without an
  explanation, something probably broke.
- `npm run build` invokes `esbuild.config.mjs`, which bundles `src/server.ts`
  into a single `dist/server.mjs` (Node built-ins, including `node:sqlite`,
  are kept external — never bundled).

## The `project_id` newline contract — never change the formula

`project_id` is the stable key used to scope `project`/`private` memory to a
given repo/directory. It is defined as:

```
project_id = first 16 hex characters of sha256(path + "\n")
```

The **trailing newline is load-bearing**. It exists because the bash sites
compute this via `echo "$path" | shasum -a 256 | cut -c1-16` (and, in
`memory-inject.sh`, `pwd | shasum -a 256 | cut -c1-16`) — both `echo` and
`pwd` append a trailing newline to their output, and the TypeScript
implementation, `computeProjectId()` in `mcp-server/src/migrate.ts`, has to
reproduce that exact byte sequence to agree with the shell one-liners.

This formula is duplicated in multiple places on purpose (there is no shared
runtime between bash hooks and the TS server):

- `packages/orchestra-memory/scripts/memory-inject.sh` (via `pwd`)
- `packages/orchestra-memory/scripts/session-start.sh` / `post-compact.sh`
  (via `echo`)
- `packages/orchestra/scripts/session-start.sh` (boulder instance key — must
  stay in lockstep with the graph `project_id` even though `orchestra` never
  imports the memory server)
- `computeProjectId()` in `packages/orchestra-memory/mcp-server/src/migrate.ts`

All of these **must** produce byte-identical output for the same path. This
is guarded by
`packages/orchestra-memory/mcp-server/test/project-id-contract.test.ts`, which
shells out to the real bash one-liners and cross-checks them against
`computeProjectId()`. If that test ever fails, the formula has diverged
somewhere — that is a P0 bug, because it silently fragments every user's
memory graph (facts written under one `project_id` become invisible to
lookups computed under a different one). **Do not "fix" a failing contract
test by changing the formula.** Find and fix the divergent call site instead.

## The `schema.sql`-copied-at-build gotcha

`esbuild.config.mjs` bundles `src/server.ts` into `dist/server.mjs`, but
esbuild only bundles JavaScript — it does not copy non-JS assets. The
connection layer loads `schema.sql` at runtime via `readFileSync` relative to
`import.meta.url`, and once bundled, `import.meta.url` inside
`dist/server.mjs` points at `dist/server.mjs` itself. So the build script
explicitly copies `src/db/schema.sql` → `dist/schema.sql` after bundling.

**`dist/` is intentionally committed to this repository.** This is not an
accident or an oversight — plugins ship the prebuilt bundle so that
consumers installing the plugin do not need to run a build step (no Node
toolchain, no `npm install` at install time). This means:

- After editing `schema.sql` or anything under `mcp-server/src/`, you must
  run `npm run build` and **commit the resulting `dist/server.mjs`,
  `dist/server.mjs.map`, and `dist/schema.sql`** alongside your source change.
- A PR that changes `src/` but not `dist/` is almost certainly missing a
  build step — reviewers should treat that as a request-changes item, not a
  nitpick.
- `mcp-server/dist/` is deliberately absent from `.gitignore` (only
  `node_modules/`, runtime `*.db*` files, and `backups/` are ignored) — do not
  add it back.

## Soft-companion decoupling

`orchestra` and `orchestra-memory` are independently installable plugins with
**no cross-plugin path references**. Claude Code has no formal inter-plugin
dependency mechanism, so the two plugins are decoupled via separate hooks:

- `orchestra-memory` registers its own `SessionStart`/`PostCompact` hooks
  that resolve `mcp-server/dist` under **its own** `${CLAUDE_PLUGIN_ROOT}`.
- `orchestra` ships no `.mcp.json` and never references
  `orchestra-memory/mcp-server`. Its agents reach memory tools opportunistically
  via ToolSearch, and when `orchestra-memory` is not installed (or its MCP
  server fails to boot), `orchestra` falls back to the legacy
  `.claude/orchestra-wisdom.json` file for conventions/gotchas/decisions —
  the pre-graph-memory wisdom store. This fallback path must keep working;
  don't remove it without also removing every reader of it (agents,
  `commands/wisdom.md`, `scripts/session-start.sh`, `scripts/post-compact.sh`).

If you find yourself adding a reference to `mcp-server/` or
`${CLAUDE_PLUGIN_ROOT}` of the *other* plugin from inside `packages/orchestra`
(or vice versa), stop — that reintroduces the coupling this split was meant
to remove.

## Platform note

The `session-start.sh`, `post-compact.sh`, and other shell hooks in both
packages are **bash + `jq`, and are Unix-only** (they are not tested or
supported on Windows/PowerShell). `jq` is treated as optional and hooks fail
open (no crash, just no enrichment) if it is missing — please preserve that
fail-open behavior in any hook changes.

## Pull requests

- Keep changes scoped to one package where possible; cross-package changes
  (e.g. touching the `project_id` formula) need extra care and should call
  out every affected site in the PR description.
- Run the full test suite (`npm test` in `mcp-server/`) and, if you touched
  any shell script, run `shellcheck` on it locally before opening a PR.
- CI runs on Node 22.16 and the latest Node release, executes the test suite,
  builds and smoke-boots the server, and lints all shell scripts with
  `shellcheck`.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](./LICENSE) that covers this repository.
