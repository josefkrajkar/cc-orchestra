// CLI migration importer for legacy Orchestra memory sources, consumed by
// `commands/memory-migrate.md`:
//   node dist/server.mjs --migrate [--commit] [--project-root <path>]
//                                  [--wisdom <path>] [--memory-dir <path>]
//
// Design decision (see PLAN-graph-memory.md Fáze 7): v1 distillation is
// performed by the CALLING LLM, not by code. This module therefore handles
// ONLY the mechanical part:
//   1. Importing `.claude/orchestra-wisdom.json` — entries there are already
//      atomic propositions (wisdom.md's add flow already enforces that), so
//      they can be imported directly through the existing handleSave path
//      for validation/dedupe consistency. No LLM involvement needed.
//   2. Producing a dry-run inventory report of legacy markdown memory files
//      (~/.claude/projects/*/memory/*.md) — read-only reconnaissance. This
//      code NEVER distills or imports markdown content; the semantic work is
//      orchestrated by the /memory-migrate command doc, which reads each
//      file itself and calls memory_save with distilled facts.
//
// Fail-open contract: dry-run mode NEVER writes anything and always exits 0,
// even on error (diagnostics go to stderr). --commit mode is the opposite —
// data safety takes priority over fail-open, so any failure exits 1. The DB
// is backed up before --commit ever touches it, and the wisdom import runs
// inside a single transaction so a mid-import failure rolls back rather than
// leaving a partial import silently in place.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultDbPath, openDb, type SqliteDatabase } from './db/connection.js';
import { createRepository } from './db/repository.js';
import type { ToolContext } from './tools/context.js';
import { handleSave } from './tools/save.js';

// ---------------------------------------------------------------------------
// Wisdom file shapes (see commands/wisdom.md's "Wisdom File Schema (v2)" —
// every category array holds a mix of v2 entry objects and legacy plain
// strings; readers must tolerate both).
// ---------------------------------------------------------------------------

export interface WisdomEntryV2 {
  text: string;
  ts?: string;
  confidence?: 'high' | 'medium' | 'low';
  source?: string;
}

export type WisdomEntry = string | WisdomEntryV2;

export interface WisdomFile {
  conventions?: WisdomEntry[];
  gotchas?: WisdomEntry[];
  decisions?: WisdomEntry[];
  failed_approaches?: WisdomEntry[];
}

type WisdomCategory = 'convention' | 'gotcha' | 'decision' | 'failed_approach';

const WISDOM_CATEGORIES: ReadonlyArray<{ key: keyof WisdomFile; category: WisdomCategory }> = [
  { key: 'conventions', category: 'convention' },
  { key: 'gotchas', category: 'gotcha' },
  { key: 'decisions', category: 'decision' },
  { key: 'failed_approaches', category: 'failed_approach' },
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * project_id = first 16 hex chars of sha256(--project-root + "\n"). The
 * trailing newline is intentional: the canonical derivation across the plugin
 * is `echo "$PWD" | shasum -a 256 | cut -c1-16` (session-start.sh, boulder,
 * memory-inject.sh), and `echo` appends "\n" to the hashed input. Facts
 * imported here must land under the same project_id the hooks compute.
 */
export function computeProjectId(projectRoot: string): string {
  return createHash('sha256').update(`${projectRoot}\n`).digest('hex').slice(0, 16);
}

function defaultWisdomPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'orchestra-wisdom.json');
}

/**
 * Finds legacy markdown memory files: default scan is
 * "$HOME/.claude/projects/<project>/memory/<file>.md" excluding MEMORY.md;
 * `memoryDir` overrides this to a single flat directory of ".md" files (also
 * excluding MEMORY.md). Read-only — never writes, never deletes.
 */
export function findLegacyMdFiles(memoryDir?: string): string[] {
  const files: string[] = [];

  function collectFrom(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        files.push(join(dir, entry.name));
      }
    }
  }

  if (memoryDir) {
    collectFrom(memoryDir);
    return files.sort();
  }

  const base = join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) return files;
  for (const projectDir of readdirSync(base, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    collectFrom(join(base, projectDir.name, 'memory'));
  }
  return files.sort();
}

export interface FrontmatterInfo {
  name?: string;
  description?: string;
  type?: string;
}

/** Minimal line-based frontmatter parser — good enough for the flat
 * `key: value` frontmatter Claude Code's auto-memory files use. */
export function parseFrontmatter(content: string): FrontmatterInfo {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) {
      fields[match[1] as string] = (match[2] ?? '').trim();
    }
  }
  return { name: fields.name, description: fields.description, type: fields.type };
}

export type ScopeSuggestion = 'global' | 'project' | 'unknown';

/** Scope heuristic from PLAN-graph-memory.md Fáze 7: frontmatter
 * `type: user|feedback|reference` → global; `type: project` → project. */
export function suggestScope(type: string | undefined): ScopeSuggestion {
  const t = type?.trim().toLowerCase();
  if (t === 'user' || t === 'feedback' || t === 'reference') return 'global';
  if (t === 'project') return 'project';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface MigrateArgs {
  commit: boolean;
  projectRoot: string;
  wisdomPath?: string;
  memoryDir?: string;
}

export function parseArgs(argv: string[]): MigrateArgs {
  let commit = false;
  let projectRoot = process.cwd();
  let wisdomPath: string | undefined;
  let memoryDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') {
      commit = true;
    } else if (arg === '--project-root') {
      projectRoot = argv[++i]?.trim() || projectRoot;
    } else if (arg === '--wisdom') {
      wisdomPath = argv[++i];
    } else if (arg === '--memory-dir') {
      memoryDir = argv[++i];
    }
  }

  return { commit, projectRoot, wisdomPath, memoryDir };
}

// ---------------------------------------------------------------------------
// Dry-run report (no writes)
// ---------------------------------------------------------------------------

export function buildDryRunReport(args: MigrateArgs): string {
  const wisdomPath = args.wisdomPath ?? defaultWisdomPath(args.projectRoot);
  const lines: string[] = [];

  lines.push('# Orchestra memory migration — DRY RUN (nothing written)');
  lines.push('');
  lines.push('## Wisdom file');
  if (!existsSync(wisdomPath)) {
    lines.push(`Not found: ${wisdomPath}`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(wisdomPath, 'utf8')) as WisdomFile;
      lines.push(`Found: ${wisdomPath}`);
      let totalV2 = 0;
      let totalLegacy = 0;
      for (const { key, category } of WISDOM_CATEGORIES) {
        const entries = parsed[key];
        if (!Array.isArray(entries) || entries.length === 0) {
          lines.push(`  - ${key} (category: ${category}): 0 entries`);
          continue;
        }
        const v2 = entries.filter((e) => typeof e === 'object' && e !== null).length;
        const legacy = entries.length - v2;
        totalV2 += v2;
        totalLegacy += legacy;
        lines.push(
          `  - ${key} (category: ${category}): ${entries.length} entries (${v2} v2 objects, ${legacy} legacy strings)`
        );
      }
      lines.push(`  Total: ${totalV2 + totalLegacy} entries (${totalV2} v2 objects, ${totalLegacy} legacy strings).`);
      lines.push(`  On --commit these import as scope=project, project_id=${computeProjectId(args.projectRoot)}.`);
    } catch (err) {
      lines.push(`Found but could not be parsed as JSON: ${wisdomPath} (${errorMessage(err)})`);
    }
  }

  lines.push('');
  lines.push('## Legacy markdown memory files');
  const mdFiles = findLegacyMdFiles(args.memoryDir);
  if (mdFiles.length === 0) {
    lines.push(
      args.memoryDir
        ? `No .md files found in ${args.memoryDir} (MEMORY.md is always excluded).`
        : 'No legacy markdown memory files found under ~/.claude/projects/*/memory/ (MEMORY.md is always excluded).'
    );
  } else {
    lines.push(`Found ${mdFiles.length} file(s):`);
    for (const file of mdFiles) {
      let sizeBytes = 0;
      let fm: FrontmatterInfo = {};
      try {
        sizeBytes = statSync(file).size;
        fm = parseFrontmatter(readFileSync(file, 'utf8'));
      } catch (err) {
        lines.push(`  - ${file} — could not be read (${errorMessage(err)})`);
        continue;
      }
      const scope = suggestScope(fm.type);
      lines.push(
        `  - ${file} (${sizeBytes} bytes)\n` +
          `      name: ${fm.name ?? '(none)'}\n` +
          `      description: ${fm.description ?? '(none)'}\n` +
          `      type: ${fm.type ?? '(none)'} → suggested scope: ${scope}`
      );
    }
  }

  lines.push('');
  lines.push('Nothing was written by this dry run.');
  lines.push('Run again with --commit to mechanically import the wisdom file above (backs up the DB first).');
  lines.push(
    'Markdown files are NEVER imported by this CLI — run the `/memory-migrate` command, which reads each ' +
      'file, distills atomic facts per the memory-discipline contract, and calls memory_save itself.'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// --commit: mechanical wisdom.json import
// ---------------------------------------------------------------------------

interface WisdomImportSummary {
  saved: number;
  duplicate: number;
  rejected: number;
}

/** Imports one already-atomic wisdom entry via the frozen handleSave path
 * (validation + exact-normalized dedupe), matching wisdom_add's convention
 * of attaching every wisdom fact to a single "project wisdom" entity so
 * /wisdom show / wisdom_get can find it. handleSave's fact shape has no
 * `valid_from` field (it always stamps "now"), so once a fact is newly
 * saved we patch valid_from directly from the wisdom entry's `ts` — the same
 * "query the underlying SqliteDatabase directly" pattern wisdom-compat.ts
 * already uses to work around the frozen repository.ts surface. */
function importWisdomEntry(
  db: SqliteDatabase,
  repo: ReturnType<typeof createRepository>,
  entry: WisdomEntry,
  category: WisdomCategory,
  projectId: string,
  projectLabel: string
): 'saved' | 'duplicate' | 'rejected' {
  const isLegacy = typeof entry === 'string';
  const text = isLegacy ? entry : entry.text;
  const confidence: 'high' | 'medium' | 'low' = isLegacy ? 'medium' : entry.confidence ?? 'medium';
  const ts = isLegacy ? undefined : entry.ts;

  // CLI mode is trusted (project_id comes from --project-root, a shell arg,
  // not an untrusted MCP caller) — bind ctx.ownProjectId to the same
  // projectId being imported so handleSave's Finding 1 mismatch check is
  // trivially satisfied rather than duplicating a separate trust path here.
  const ctx: ToolContext = { ownProjectId: projectId };
  const result = handleSave(
    repo,
    db,
    {
      facts: [
        {
          entity: { name: 'project wisdom', kind: 'wisdom' },
          text: text ?? '',
          category,
          confidence,
        },
      ],
      relations: [],
      scope: 'project',
      project_id: projectId,
      project_label: projectLabel,
      source: 'migration:wisdom',
    },
    ctx
  );

  const outcome = result.facts[0];
  if (outcome?.status === 'saved') {
    if (ts && outcome.observationId) {
      db.prepare('UPDATE observations SET valid_from = ? WHERE id = ?').run(ts, outcome.observationId);
    }
    return 'saved';
  }
  if (outcome?.status === 'duplicate') return 'duplicate';
  return 'rejected';
}

function importWisdomFile(
  db: SqliteDatabase,
  repo: ReturnType<typeof createRepository>,
  wisdomPath: string,
  projectId: string,
  projectLabel: string
): WisdomImportSummary {
  const parsed = JSON.parse(readFileSync(wisdomPath, 'utf8')) as WisdomFile;
  const summary: WisdomImportSummary = { saved: 0, duplicate: 0, rejected: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { key, category } of WISDOM_CATEGORIES) {
      const entries = parsed[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const status = importWisdomEntry(db, repo, entry, category, projectId, projectLabel);
        summary[status] += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return summary;
}

/**
 * The DB runs in WAL journal mode (see connection.ts), which means recent
 * writes may live only in the "<dbPath>-wal" sidecar file, not yet folded
 * into the main .db file. A plain copyFileSync() of just the main file can
 * therefore silently drop un-checkpointed writes from the backup. Opening a
 * short-lived connection and forcing `PRAGMA wal_checkpoint(TRUNCATE)`
 * flushes the WAL into the main file (and truncates the sidecar) before the
 * copy, so the backup is a complete, self-contained snapshot.
 */
export function checkpointWal(dbPath: string): void {
  const db = openDb(dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }
}

function commitMigration(args: MigrateArgs): string {
  const wisdomPath = args.wisdomPath ?? defaultWisdomPath(args.projectRoot);
  const wisdomExists = existsSync(wisdomPath);

  const dbPath = defaultDbPath();
  const dbExistedBefore = existsSync(dbPath);
  let backupPath: string | null = null;
  if (dbExistedBefore) {
    checkpointWal(dbPath);
    backupPath = `${dbPath}.bak-${isoStamp()}`;
    copyFileSync(dbPath, backupPath);
  }

  const lines: string[] = [];
  lines.push('# Orchestra memory migration — COMMIT');
  lines.push(
    dbExistedBefore
      ? `DB backed up: ${dbPath} -> ${backupPath}`
      : `No pre-existing DB at ${dbPath} — skipped backup (first run).`
  );

  // openDb() throws on failure (e.g. node:sqlite unavailable) — this is
  // intentionally NOT caught here so the caller (runMigrate) can exit 1
  // without pretending anything was imported.
  const db = openDb(dbPath);
  const repo = createRepository(db);

  if (wisdomExists) {
    const projectId = computeProjectId(args.projectRoot);
    const projectLabel = basename(args.projectRoot);
    const summary = importWisdomFile(db, repo, wisdomPath, projectId, projectLabel);
    lines.push(
      `Wisdom import from ${wisdomPath}: saved=${summary.saved}, duplicate=${summary.duplicate}, ` +
        `rejected=${summary.rejected} (scope=project, project_id=${projectId}).`
    );
  } else {
    lines.push(`No wisdom file found at ${wisdomPath} — nothing to import.`);
  }

  lines.push('');
  lines.push(
    'Markdown memory files were NOT imported by this command (mechanical import only, per design). ' +
      'Run the `/memory-migrate` command to distill and import legacy markdown memories — originals are ' +
      'never modified or deleted, and re-running this import is safe (dedupe prevents duplicates).'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point for `node dist/server.mjs --migrate ...`
// ---------------------------------------------------------------------------

/** Never throws. Dry-run always exits 0 (fail-open, even on internal error).
 * --commit exits 1 on any failure — data safety takes priority over
 * fail-open once we're about to write to the shared graph DB. */
export function runMigrate(argv: string[]): void {
  const args = parseArgs(argv);

  if (!args.commit) {
    try {
      process.stdout.write(buildDryRunReport(args) + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`orchestra-memory --migrate (dry-run) failed (fail-open, exiting 0): ${errorMessage(err)}\n`);
      process.exit(0);
    }
    // Load-bearing despite the "unreachable" hint: tests mock process.exit as
    // a no-op, and without this return a dry-run would fall through into the
    // --commit path below.
    return;
  }

  try {
    process.stdout.write(commitMigration(args) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`orchestra-memory --migrate --commit failed (no changes assumed committed): ${errorMessage(err)}\n`);
    process.exit(1);
  }
}
