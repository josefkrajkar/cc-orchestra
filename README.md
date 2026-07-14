# Orchestra

A monorepo with two independently installable Claude Code plugins:

| Package | What it is | Standalone? |
|---|---|---|
| [`packages/orchestra`](packages/orchestra/README.md) | Multi-agent orchestration plugin — 3-layer architecture (planning/orchestration/execution), 8 specialized agents, staged pipeline with quality gates, file claiming, wisdom accumulation, boulder session persistence. | Yes |
| [`packages/orchestra-memory`](packages/orchestra-memory/README.md) | Standalone cross-project graph-memory MCP server — SQLite-backed (`node:sqlite`), FTS5 full-text search, temporal validity, `global`/`project`/`private` scoping, plus session-start/post-compact context injection. | Yes |

Both plugins are fully usable on their own. `orchestra-memory` is the **optional companion** to `orchestra`: install it alongside `orchestra` to upgrade wisdom accumulation from a single project's JSON file into a graph of facts shared across every project on the machine, with temporal validity and scoping. Install `orchestra` without it and everything still works — it falls back to the legacy `.claude/orchestra-wisdom.json` file. Install `orchestra-memory` on its own and you get a general-purpose graph-memory MCP server with no dependency on the orchestration plugin at all.

For the full feature set, commands, agents, and internals of each package, see their own READMEs:
- [`packages/orchestra/README.md`](packages/orchestra/README.md)
- [`packages/orchestra-memory/README.md`](packages/orchestra-memory/README.md)

A Czech-language archive of the original single-plugin README (pre-split) is kept at [`README.cs.md`](README.cs.md) for historical reference; it is not maintained going forward.

## Repository layout

```
orchestra/                              # this repo
├── packages/
│   ├── orchestra/                      # orchestration plugin
│   │   ├── .claude-plugin/plugin.json  # name: orchestra — 9 hook events, no .mcp.json
│   │   ├── agents/                     # conductor, architect, executor, craftsman, sentinel, scout, scholar, verifier
│   │   ├── commands/                   # /orchestrate, /plan, /review, /parallel, /ralph, /boulder, /wisdom,
│   │   │                               #   /status, /memory-setup, /memory-migrate
│   │   ├── skills/                     # orchestrate, deep-plan, deep-review, skill-extract, memory-discipline,
│   │   │                               #   verify, systematic-debugging
│   │   ├── conventions/                # framework-specific rule digests (e.g. React)
│   │   ├── scripts/                    # orchestration hooks (session-start, guards, tracking, gates)
│   │   └── README.md
│   └── orchestra-memory/               # graph-memory MCP server plugin
│       ├── .claude-plugin/plugin.json  # name: orchestra-memory — SessionStart + PostCompact
│       ├── .mcp.json                   # registers the orchestra-memory MCP server (own PLUGIN_ROOT)
│       ├── mcp-server/                 # TypeScript source → esbuild → dist/server.mjs
│       ├── scripts/                    # memory injection + daily backup hooks
│       └── README.md
├── .github/                            # CI workflows
├── LICENSE                             # MIT
├── CONTRIBUTING.md                     # build/test/contract notes for contributors
├── AGENTS.md                           # agent architecture reference (STYLE/GOTCHAS/ARCH_DECISIONS)
├── README.md                           # this file
└── README.cs.md                        # archived Czech original (pre-split), unmaintained
```

## Soft-companion relationship

Claude Code has no formal inter-plugin dependency mechanism, so `orchestra` and `orchestra-memory` are decoupled deliberately, not by convention:

- **No cross-plugin path references.** `orchestra` ships no `.mcp.json` and holds no reference anywhere to `orchestra-memory`'s `mcp-server/` directory. Each plugin resolves its own scripts and, where applicable, its own MCP server strictly under its **own** `${CLAUDE_PLUGIN_ROOT}` — a plugin cannot address another plugin's root.
- **Decoupled via separate hooks, not a shared one.** Both plugins register their own `SessionStart` and `PostCompact` hooks; Claude Code runs both independently when both are installed. `orchestra-memory`'s hooks handle graph-memory injection and the daily `graph.db` backup. `orchestra`'s hooks handle boulder state and the legacy wisdom-file summary only.
- **Runtime discovery, not a hard dependency.** `orchestra`'s agents and commands look up `orchestra-memory`'s MCP tools (`memory_save`, `memory_search`, `wisdom_get`, `wisdom_add`, etc.) via ToolSearch at runtime — they are not pre-attached. If the tools can't be found (plugin not installed, Node < 22.16, or the bundle isn't built), every code path that touches wisdom falls back automatically to reading/writing the per-project `.claude/orchestra-wisdom.json` file, exactly as `orchestra` behaved before graph memory existed.
- **Fail-open, always.** Every point of contact between the two plugins is designed to degrade silently to "orchestra-memory absent" rather than error. This is true whether `orchestra-memory` was never installed, was uninstalled, or is temporarily unavailable (e.g. Node downgraded below 22.16).

The practical result: install either plugin alone, both together, or uninstall one without the other, and nothing breaks — see [Install](#install) for the three supported permutations.

## Install

Both plugins are distributed as Claude Code plugins through the marketplace system. This repository is itself the marketplace — there is no separate marketplace checkout to maintain, and no npm package yet (npm publication of the `orchestra-memory` MCP server is deliberately deferred).

### Requirements

- **bash + jq**, for the orchestration plugin's hooks. Hooks are shell scripts and are **Unix-only** (macOS/Linux) — Windows is not supported.
- **Node.js ≥ 22.16**, for `orchestra-memory` only — its MCP server relies on the `node:sqlite` builtin, which is flag-free and compiled with FTS5 only since Node 22.16. `orchestra` itself has no Node dependency.
- If `jq` or a sufficiently recent Node is missing, both plugins fail open: hooks and tools report a visible warning and degrade to their fallback behavior rather than crashing.

### Standard install

```bash
# 1. Register this repo as a marketplace, once
claude plugin marketplace add jKrajkar/cc-orchestra

# 2. Install the plugin(s) you want, referencing the "orchestra" marketplace by name
claude plugin install orchestra@orchestra
claude plugin install orchestra-memory@orchestra   # optional but recommended

# 3. Verify
claude plugin list
```

Add `--scope project` to step 1 to register the marketplace for a single project only instead of for your whole user account (the default). No build step is required on the consumer's side: `orchestra-memory`'s MCP server bundle (`mcp-server/dist/server.mjs`) ships prebuilt in the repo.

### Or just ask Claude Code

Don't want to run the commands yourself? Paste this prompt into any Claude Code session and let it do the install for you:

```text
Install the Orchestra plugins for me:
1. Run `claude plugin marketplace add jKrajkar/cc-orchestra`
2. Run `claude plugin install orchestra@orchestra`
3. Run `claude plugin install orchestra-memory@orchestra`
4. Run `claude plugin list` and confirm both plugins show as enabled.
If any step fails, show me the exact error and suggest a fix. Note the requirements:
bash + jq for orchestra's hooks (Unix-only), and Node.js >= 22.16 for orchestra-memory.
```

Restart the session (or start a new one) afterwards so the plugins' hooks and commands load.

### Zero-step install for teams

To have every teammate on a project get Orchestra automatically (after a one-time trust confirmation), commit an entry like this to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "orchestra": {
      "source": { "source": "github", "repo": "jKrajkar/cc-orchestra" }
    }
  },
  "enabledPlugins": {
    "orchestra@orchestra": true,
    "orchestra-memory@orchestra": true
  }
}
```

With this in place, teammates who open the project only need to confirm the workspace-trust / plugin-install prompt that Claude Code shows the first time — Claude Code ≥ v2.1.195 requires this explicit install consent as a security boundary (not a bug), and there is no way to skip it silently. Once confirmed, both plugins auto-enable for that project with no further commands. Anyone who wants to opt out afterward can disable a plugin via `/plugin`.

### Local development install

To load a plugin for a single session without registering any marketplace — useful while developing this repo itself:

```bash
claude --plugin-dir ./packages/orchestra
```

### The three supported permutations

| Install | Result |
|---|---|
| **Both plugins** | Full experience — orchestration plus cross-project graph memory with temporal validity and scoping. Wisdom accumulates into the graph; `/memory-setup` and `/memory-migrate` are functional. |
| **`orchestra` only** | Orchestration works fully — agents, commands, skills, hooks, file claiming, quality gates. Wisdom accumulation falls back to the per-project `.claude/orchestra-wisdom.json` file. `/memory-setup`/`/memory-migrate` are no-ops with a clear message (see [`packages/orchestra/README.md`](packages/orchestra/README.md)). |
| **`orchestra-memory` only** | A standalone graph-memory MCP server — usable by any agent/tooling that speaks MCP and can discover its tools via ToolSearch, entirely independent of the orchestration plugin. |

```bash
# Both
claude plugin install orchestra@orchestra
claude plugin install orchestra-memory@orchestra

# orchestra only
claude plugin install orchestra@orchestra

# orchestra-memory only
claude plugin install orchestra-memory@orchestra
```

## Uninstall / cleanup

Removing a plugin does not, by itself, delete the state it left behind. To fully clean up:

```bash
# 1. Uninstall the plugin(s)
claude plugin uninstall orchestra@orchestra
claude plugin uninstall orchestra-memory@orchestra

# 2. Purge orchestra-memory's global state (only if you installed it)
rm -rf ~/.claude/orchestra-memory/graph.db ~/.claude/orchestra-memory/backups/

# 3. Purge orchestra's per-project state, run inside each project you used it in
rm -f .claude/orchestra-boulder.json .claude/orchestra-wisdom.json
```

Notes:
- `~/.claude/orchestra-memory/graph.db` and its `backups/` directory are **user-global**, not per-project — deleting them removes graph memory for every project on the machine, not just the current one.
- `.claude/orchestra-boulder.json` and `.claude/orchestra-wisdom.json` are per-project and live inside each project's own `.claude/` directory; repeat step 3 for every project where you used `orchestra`.
- Neither cleanup step touches `.claude/orchestra-log.jsonl` (the `SubagentStart`/`SubagentStop` audit trail) or `.claude/workflows/` (saved Workflow scripts) automatically — remove those too if you want a fully clean slate.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for build/test instructions, the monorepo layout, and the `project_id` cross-package contract (the same SHA-256-of-cwd derivation is used independently by `orchestra`'s boulder instance key and `orchestra-memory`'s project scoping — it must stay byte-identical between the two).

## License

MIT — see [`LICENSE`](LICENSE).
