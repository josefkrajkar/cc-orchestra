// CLI backup mode, invoked from a SessionStart bash hook (wiring added in a
// later phase — this module only builds the CLI):
//   node dist/server.mjs --backup [--keep <n>]
//
// Purpose: a daily rotating snapshot of ~/.claude/orchestra-memory/graph.db,
// so a corrupted or bad-migration DB can be rolled back to "yesterday" (or
// further, per --keep) without depending on --migrate's one-off backups.
//
// Contract:
//   1. No DB yet -> no-op, exit 0, stderr note.
//   2. Backup dir: ~/.claude/orchestra-memory/backups/. Target file name is
//      `graph-<YYYY-MM-DD>.db` using the LOCAL date (matches "once per
//      SessionStart per day" semantics for whoever's machine this runs on).
//   3. DAILY NO-OP: if today's target already exists, exit 0 immediately
//      without opening the DB. This is the hot path — it runs on every
//      session start, potentially many times a day — so it must be a single
//      existsSync() check with no DB connection involved.
//   4. Otherwise: checkpoint the WAL (reusing migrate.ts's checkpointWal, for
//      the same "un-checkpointed writes can be silently dropped by a plain
//      file copy" reason documented there), then copyFileSync into place.
//   5. Rotation: after a successful copy, keep only the newest N backups
//      (by the date embedded in the filename; ISO YYYY-MM-DD sorts
//      lexicographically) and delete the rest — touching only files in
//      backups/ that match the `graph-<date>.db` pattern.
//
// Fail-open contract (same as --inject): this must NEVER throw and ALWAYS
// exit 0 — a broken backup step must never break the SessionStart hook it's
// invoked from. Diagnostics go to stderr only; stdout is always empty.
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultDbPath } from './db/connection.js';
import { checkpointWal } from './migrate.js';

const DEFAULT_KEEP = 7;
const BACKUP_FILE_RE = /^graph-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupArgs {
  keep: number;
}

export function parseArgs(argv: string[]): BackupArgs {
  let keep = DEFAULT_KEEP;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed)) keep = Math.max(1, Math.floor(parsed));
    }
  }
  return { keep };
}

/** backups/ lives alongside graph.db rather than a second homedir() call, so
 * the two paths can never drift apart if defaultDbPath() ever changes. */
export function backupsDir(dbPath: string = defaultDbPath()): string {
  return join(dirname(dbPath), 'backups');
}

/** Local (not UTC) YYYY-MM-DD — "today" here means the wall-clock day of
 * whichever machine the SessionStart hook runs on. */
export function todayStamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Deletes all but the `keep` newest `graph-<date>.db` files in `dir`.
 * Best-effort per file: a single stray unlink failure (e.g. concurrent
 * deletion) must not abort rotation of the remaining files — the overall
 * fail-open contract is still enforced by runBackup()'s outer try/catch. */
function rotateBackups(dir: string, keep: number): void {
  const entries = readdirSync(dir).filter((name) => BACKUP_FILE_RE.test(name));
  entries.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest (highest date) first
  for (const stale of entries.slice(keep)) {
    try {
      unlinkSync(join(dir, stale));
    } catch {
      // best-effort; not fatal to the backup that already succeeded.
    }
  }
}

/** Entry point for `node dist/server.mjs --backup ...`. Never throws —
 * always exits 0, with nothing on stdout and diagnostics (if any) on stderr
 * only, matching --inject's fail-open contract. */
export function runBackup(argv: string[]): void {
  try {
    const { keep } = parseArgs(argv);
    const dbPath = defaultDbPath();

    if (!existsSync(dbPath)) {
      process.stderr.write(`orchestra-memory --backup: no database at ${dbPath}, nothing to back up\n`);
      process.exit(0);
      // Load-bearing despite the "unreachable" hint: tests mock process.exit
      // as a no-op, so without this return, execution would fall through
      // into the backup logic below with a nonexistent dbPath.
      return;
    }

    const dir = backupsDir(dbPath);
    const target = join(dir, `graph-${todayStamp()}.db`);

    // Hot path: pure existsSync, no DB open — this runs on every session
    // start, so it must stay cheap on the (overwhelmingly common) days when
    // today's backup already exists.
    if (existsSync(target)) {
      process.exit(0);
      return;
    }

    mkdirSync(dir, { recursive: true });
    checkpointWal(dbPath);
    copyFileSync(dbPath, target);
    rotateBackups(dir, keep);

    process.exit(0);
  } catch (err) {
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`orchestra-memory --backup failed (fail-open, exiting 0): ${message}\n`);
    } catch {
      // stderr itself failed — nothing more we can do; still fail open.
    }
    process.exit(0);
  }
}
