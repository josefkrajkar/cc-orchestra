# Deploy Procedure

This monorepo ships two independent Claude Code plugins:

- `packages/orchestra` — the orchestration plugin
- `packages/orchestra-memory` — the standalone graph-memory MCP server plugin

Both are consumed by `orchestra-marketplace`, a **non-git** directory that Claude
Code reads plugin metadata from. In local development the marketplace links to
this repo via relative symlinks (see `orchestra-marketplace/.claude-plugin/marketplace.json`
and the `orchestra` / `orchestra-memory` symlinks next to it). For a real deploy —
or for any target that is a plain directory rather than a symlink (e.g. a plugin
cache, a colleague's marketplace checkout, a CI artifact dir) — use `rsync`
following the mandatory safety procedure below.

This procedure and its constraints come from the graph-memory design doc
(`docs/design/graph-memory-design.md`, Phase 9 / deploy section): the marketplace target is
**not a git repo**, so there is no safety net from version control — rsync
mistakes there are permanent unless you've taken your own backup first.

## Mandatory constraints

1. **Backup the target first — always.** The marketplace directory is not
   version-controlled. Before touching it, copy it somewhere safe. There is no
   `git checkout` to fall back on if something goes wrong.
2. **`--dry-run` first, every time.** Run the exact command you intend to run,
   with `--dry-run` (`-n`) added, and read the output line by line before
   dropping the flag. Never skip this step, even for "trivial" changes.
3. **Never use `--delete`.** We only ever add/update files in the target. We do
   not want rsync deciding what to remove — that is how unrelated content
   (including the fable-model experiment, see below) gets destroyed.
4. **`--exclude node_modules`.** Neither package ships a `node_modules`
   directory. `orchestra-memory`'s MCP server uses `node:sqlite` (a Node
   built-in) specifically so there are zero native dependencies and nothing
   `node_modules`-shaped to sync — do not let a stray local install leak into
   the deploy.
5. **DO ship `dist/`.** `packages/orchestra-memory/mcp-server/dist/` is the
   prebuilt esbuild bundle and is intentionally committed to this repo — it is
   the actual artifact the MCP server runs from. Do not exclude it, do not
   treat it like a build cache.
6. **Preserve the fable-model experiment in the target.** The marketplace (or
   plugin cache) directory may contain a `fable-model` experiment that lives
   only in the target, not in this source repo. Because we never use
   `--delete`, an rsync run with no matching source path cannot remove it — but
   still explicitly exclude any `fable-model*` path from the sync as a second
   layer of protection, and re-confirm in the `--dry-run` output that it is not
   listed as a change.

## Example: deploying `packages/orchestra`

```bash
SRC=/Users/josefkrajkar/Desktop/projects/orchestra-plugin/packages/orchestra/
DST=/path/to/marketplace-target/orchestra/

# 1. Backup the target first (mandatory).
cp -a "$DST" "${DST%/}.bak.$(date +%Y%m%dT%H%M%S)"

# 2. Dry run — review every line before proceeding.
rsync -av --dry-run \
  --exclude 'node_modules' \
  --exclude 'fable-model*' \
  "$SRC" "$DST"

# 3. Only after reviewing the dry run output, run for real.
#    Note: no --delete, ever.
rsync -av \
  --exclude 'node_modules' \
  --exclude 'fable-model*' \
  "$SRC" "$DST"
```

## Example: deploying `packages/orchestra-memory`

```bash
SRC=/Users/josefkrajkar/Desktop/projects/orchestra-plugin/packages/orchestra-memory/
DST=/path/to/marketplace-target/orchestra-memory/

# 1. Backup the target first (mandatory).
cp -a "$DST" "${DST%/}.bak.$(date +%Y%m%dT%H%M%S)"

# 2. Dry run — review every line before proceeding.
#    dist/ is NOT excluded — the prebuilt bundle must ship.
rsync -av --dry-run \
  --exclude 'node_modules' \
  --exclude 'fable-model*' \
  "$SRC" "$DST"

# 3. Only after reviewing the dry run output, run for real.
rsync -av \
  --exclude 'node_modules' \
  --exclude 'fable-model*' \
  "$SRC" "$DST"
```

Adjust `SRC`/`DST` for your actual target (e.g. a real `orchestra-marketplace`
checkout on another machine, or a plugin cache directory). The trailing slash
on both `SRC` and `DST` matters — it copies the *contents* of `packages/orchestra/`
into the target directory rather than nesting it one level deeper.

## Checklist before every deploy

- [ ] Target backed up (full copy, timestamped)
- [ ] `--dry-run` output reviewed line by line
- [ ] No `--delete` flag present in the command
- [ ] `--exclude node_modules` present
- [ ] `dist/` is present in the dry-run output as something being copied (not excluded)
- [ ] `fable-model*` excluded, and confirmed absent from the dry-run change list
- [ ] Real run only executed after all of the above are confirmed

## Alternative: public release via a GitHub `source`

The rsync procedure above is for local/dev deploys into a filesystem-based
marketplace target. For a public release, `orchestra-marketplace`'s
`.claude-plugin/marketplace.json` can point each plugin at a GitHub repo
instead of a local symlink, and Claude Code will fetch the plugin directly
from GitHub — no rsync, no local checkout, no symlink management:

```json
{
  "plugins": [
    {
      "name": "orchestra",
      "source": {
        "source": "github",
        "repo": "<owner>/orchestra"
      }
    },
    {
      "name": "orchestra-memory",
      "source": {
        "source": "github",
        "repo": "<owner>/orchestra-memory"
      }
    }
  ]
}
```

This requires each plugin to be published as its own repo (or the marketplace
entry to point at a subdirectory within a monorepo, depending on what the
`github` source type supports). Use this path once the plugins are stable and
publicly released; use the rsync procedure above for local development and
private/internal deploys where the target is a plain directory rather than
something Claude Code can fetch from GitHub.
