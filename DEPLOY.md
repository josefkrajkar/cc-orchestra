# Deploy Procedure

This monorepo ships two independent Claude Code plugins:

- `packages/orchestra` — the orchestration plugin
- `packages/orchestra-memory` — the standalone graph-memory MCP server plugin

Both are consumed directly from this repository via its own marketplace
manifest, [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)
— **this repo is the marketplace**. There is no separate `orchestra-marketplace`
checkout to keep in sync and no rsync step: consumers register this repo as a
Git-source marketplace (`claude plugin marketplace add jKrajkar/cc-orchestra`)
and Claude Code fetches plugin metadata straight from GitHub.

## Deploy = commit + push to `main`

Because marketplace and plugin sources are both resolved from this Git repo,
"deploying" a change is simply committing it and pushing to `main` on GitHub.
Any consumer whose marketplace entry points at `jKrajkar/cc-orchestra` will
pick up the new commit the next time Claude Code refreshes that marketplace
(e.g. via `claude plugin marketplace update` or the periodic background
refresh) — there is no separate publish/sync step to run.

## Pre-release checklist

Run through this before pushing a change that should count as a release
(a new plugin version, a behavior change, or a fix consumers should pick up):

- [ ] **Bump plugin versions.** If the change affects `packages/orchestra` and/or
      `packages/orchestra-memory`, bump the `version` field in the corresponding
      `packages/*/​.claude-plugin/plugin.json` (semver — patch for fixes, minor
      for backwards-compatible features, major for breaking changes).
- [ ] **Rebuild and commit `dist/` if `orchestra-memory` source changed.** If
      `packages/orchestra-memory/mcp-server/src/` or `schema.sql` changed, run
      `npm run build` inside `packages/orchestra-memory/mcp-server` and commit
      the resulting `dist/server.mjs`, `dist/server.mjs.map`, and
      `dist/schema.sql` alongside the source change. A PR that changes `src/`
      but not `dist/` is missing a build step — see
      [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full gotcha.
- [ ] **Run tests.** `npm test` inside `packages/orchestra-memory/mcp-server`
      must pass (currently 44 tests, including the `project_id` cross-package
      contract test).
- [ ] **Validate the marketplace manifest.** `claude plugin validate .` from
      the repo root must pass (add `--strict` to also fail on warnings).
- [ ] **Shell scripts pass `shellcheck`** if you touched any hook script in
      either package (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

```bash
# From the repo root
claude plugin validate .

# From packages/orchestra-memory/mcp-server
npm run build   # only if src/ or schema.sql changed
npm test
```

Once the checklist is green, commit and push to `main` as usual (or merge the
PR) — that push *is* the deploy.

## Legacy: the rsync / `orchestra-marketplace` flow is retired

Earlier versions of this repo were deployed by rsyncing `packages/orchestra`
and `packages/orchestra-memory` into a separate, non-git
`orchestra-marketplace` checkout, which held its own
`.claude-plugin/marketplace.json` and symlinks (or rsynced copies) of each
plugin. That flow is retired now that this repo carries its own
`.claude-plugin/marketplace.json` at the root and plugins are referenced via
relative `source` paths (`./packages/orchestra`, `./packages/orchestra-memory`)
directly from GitHub.

If you previously registered the old `orchestra-marketplace` checkout or a
GitHub source pointing at a per-plugin repo, remove it and re-add this repo
instead:

```bash
claude plugin marketplace remove <old-marketplace-name>
claude plugin marketplace add jKrajkar/cc-orchestra
claude plugin install orchestra@orchestra
claude plugin install orchestra-memory@orchestra
```

No rsync, backup, or dry-run steps are needed going forward — see the
[README's Install section](README.md#install) for the current, supported
install flow.
