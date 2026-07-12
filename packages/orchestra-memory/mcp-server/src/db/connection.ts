// SQLite connection management for the Orchestra graph memory store.
//
// Fail-open contract: node:sqlite is only available on Node >= 22.5. We must
// never let importing this module crash the process on older Node — all
// resolution of the `node:sqlite` builtin happens lazily inside tryOpenDb()
// via createRequire(), so a missing module surfaces as a diagnostic string
// instead of an unhandled module-resolution error at load time.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { getDbPath } from '../config.js';

// Type-only import — erased at compile time, never causes a runtime failure
// even if the ambient node:sqlite types are absent.
export type SqliteDatabase = DatabaseSyncCtor;

const require_ = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(moduleDir, 'schema.sql');

/** Current schema version this codebase expects (see schema.sql `meta` table). */
export const SCHEMA_VERSION = '1';

// Overridable via ORCHESTRA_MEMORY_DB_PATH (see config.ts's getDbPath()).
export function defaultDbPath(): string {
  return getDbPath();
}

export interface OpenResult {
  db: SqliteDatabase | null;
  diagnostic: string | null;
}

/**
 * Attempts to open (creating + migrating if needed) the graph memory DB.
 * Never throws: on any failure (node:sqlite missing, unsupported schema
 * version, filesystem error) returns { db: null, diagnostic }. Callers
 * (MCP tools, hooks) must treat a null db as "memory features disabled"
 * and continue without crashing (Orchestra's fail-open ethos).
 */
export function tryOpenDb(dbPath: string = defaultDbPath()): OpenResult {
  let DatabaseSync: new (path: string) => SqliteDatabase;
  try {
    ({ DatabaseSync } = require_('node:sqlite'));
  } catch (err) {
    return {
      db: null,
      diagnostic:
        'orchestra-memory: node:sqlite is unavailable (requires Node >= 22.5). ' +
        'Graph memory tools will be disabled for this session. ' +
        `Underlying error: ${errorMessage(err)}`,
    };
  }

  try {
    const db = openAndMigrate(DatabaseSync, dbPath);
    return { db, diagnostic: null };
  } catch (err) {
    return {
      db: null,
      diagnostic: `orchestra-memory: failed to open database at "${dbPath}": ${errorMessage(err)}`,
    };
  }
}

/**
 * Throwing variant of tryOpenDb, for contexts (tests, CLI) that already know
 * node:sqlite is available and prefer a hard failure over a null return.
 */
export function openDb(dbPath: string = defaultDbPath()): SqliteDatabase {
  const { db, diagnostic } = tryOpenDb(dbPath);
  if (!db) {
    throw new Error(diagnostic ?? 'orchestra-memory: failed to open database');
  }
  return db;
}

function openAndMigrate(
  DatabaseSync: new (path: string) => SqliteDatabase,
  dbPath: string
): SqliteDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // journal_mode returns a result row when queried directly; exec() discards
  // it, which is fine — we don't need the confirmed mode value here.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: SqliteDatabase): void {
  const metaTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();

  if (!metaTable) {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    return;
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const version = row?.value ?? '0';

  if (version !== SCHEMA_VERSION) {
    // No prior schema versions exist yet in v1; future migrations branch here.
    throw new Error(
      `unsupported schema_version "${version}" (expected "${SCHEMA_VERSION}"); no migration path defined`
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
