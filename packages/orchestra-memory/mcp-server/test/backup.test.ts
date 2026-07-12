import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDbPath, openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository } from '../src/db/repository.js';
import { backupsDir, runBackup, todayStamp } from '../src/backup.js';

interface CallResult {
  exitCodes: Array<number | undefined>;
  stdout: string;
  stderr: string;
}

/** Runs runBackup() with process.exit/stdout/stderr mocked so the test
 * process itself never terminates and output can be asserted on (same
 * harness style as migrate.test.ts's callMigrate). */
function callBackup(argv: string[]): CallResult {
  const exitCodes: Array<number | undefined> = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    runBackup(argv);
  } finally {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { exitCodes, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

const SEEDED_TEXT = 'This row must survive into the daily backup snapshot.';

async function seedDb(dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  try {
    const repo = createRepository(db);
    const node = await repo.upsertNode({ canonical: 'backup test node', kind: 'other', scope: 'global' });
    await repo.addObservation({ nodeId: node.id, text: SEEDED_TEXT, scope: 'global' });
  } finally {
    db.close();
  }
}

describe('backup CLI', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'orchestra-backup-home-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates today\'s dated backup containing the seeded data', async () => {
    const dbPath = defaultDbPath();
    await seedDb(dbPath);

    const { exitCodes, stdout, stderr } = callBackup(['--backup']);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toBe('');
    expect(stderr).toBe('');

    const target = join(backupsDir(dbPath), `graph-${todayStamp()}.db`);
    expect(existsSync(target)).toBe(true);

    const backupDb: SqliteDatabase = openDb(target);
    try {
      const row = backupDb
        .prepare(`SELECT COUNT(*) as c FROM observations WHERE text = ?`)
        .get(SEEDED_TEXT) as { c: number };
      expect(row.c).toBe(1);
    } finally {
      backupDb.close();
    }
  });

  it('is a no-op on a second run the same day (pure existsSync hot path)', async () => {
    const dbPath = defaultDbPath();
    await seedDb(dbPath);

    callBackup(['--backup']);
    const target = join(backupsDir(dbPath), `graph-${todayStamp()}.db`);
    expect(existsSync(target)).toBe(true);
    const firstMtime = statSync(target).mtimeMs;
    const firstContent = statSync(target).size;

    const { exitCodes, stdout, stderr } = callBackup(['--backup']);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(statSync(target).mtimeMs).toBe(firstMtime);
    expect(statSync(target).size).toBe(firstContent);
  });

  it('rotates backups, keeping only the newest N (today included)', async () => {
    const dbPath = defaultDbPath();
    await seedDb(dbPath);

    const dir = backupsDir(dbPath);
    mkdirSync(dir, { recursive: true });
    const fakeDates = [
      '2026-06-20',
      '2026-06-21',
      '2026-06-22',
      '2026-06-23',
      '2026-06-24',
      '2026-06-25',
      '2026-06-26',
      '2026-06-27',
    ];
    for (const date of fakeDates) {
      writeFileSync(join(dir, `graph-${date}.db`), 'fake backup contents');
    }
    expect(readdirSync(dir).length).toBe(fakeDates.length);

    const { exitCodes } = callBackup(['--backup', '--keep', '3']);
    expect(exitCodes).toEqual([0]);

    const remaining = readdirSync(dir).filter((f) => f.startsWith('graph-')).sort();
    expect(remaining).toEqual([
      `graph-${todayStamp()}.db`,
      'graph-2026-06-26.db',
      'graph-2026-06-27.db',
    ].sort());
    expect(remaining.length).toBe(3);
  });

  it('is a no-op when no database exists yet', () => {
    const dbPath = defaultDbPath();
    expect(existsSync(dbPath)).toBe(false);

    const { exitCodes, stdout, stderr } = callBackup(['--backup']);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toBe('');
    expect(stderr).toContain('no database at');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('fails open (exit 0, stderr diagnostic) when the backup path is unwritable', () => {
    process.env.HOME = '/dev/null/x';

    const { exitCodes, stdout, stderr } = callBackup(['--backup']);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toBe('');
    expect(stderr.length).toBeGreaterThan(0);
  });
});

// Docker/remote-server context (Task 3.3, docs/design/remote-memory-plan.md
// Phase 3): `--backup` must operate against ORCHESTRA_MEMORY_DB_PATH, not a
// hardcoded homedir path, since the container has no meaningful $HOME-based
// default and instead bakes ORCHESTRA_MEMORY_DB_PATH=/data/graph.db into the
// image (see ../../Dockerfile). This is exercised end-to-end here (rather
// than only at the config.getDbPath() unit level, see config.test.ts) to
// prove the whole --backup CLI path — defaultDbPath() -> getDbPath() ->
// backupsDir()/copyFileSync — actually honors the override.
describe('backup CLI with ORCHESTRA_MEMORY_DB_PATH override (container path)', () => {
  const ENV_KEY = 'ORCHESTRA_MEMORY_DB_PATH';
  let workDir: string;
  let originalHome: string | undefined;
  let originalOverride: string | undefined;
  let hadOriginalOverride: boolean;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalOverride = process.env[ENV_KEY];
    hadOriginalOverride = ENV_KEY in process.env;

    // A HOME distinct from the override path, so a passing test can only be
    // explained by --backup honoring ORCHESTRA_MEMORY_DB_PATH, not by
    // accidentally falling back to the (also real, but unused) HOME-derived
    // default.
    workDir = mkdtempSync(join(tmpdir(), 'orchestra-backup-override-'));
    process.env.HOME = join(workDir, 'unused-home');
    process.env[ENV_KEY] = join(workDir, 'container-data', 'graph.db');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (hadOriginalOverride) {
      process.env[ENV_KEY] = originalOverride;
    } else {
      delete process.env[ENV_KEY];
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('backs up the ORCHESTRA_MEMORY_DB_PATH-resolved DB, not the HOME-derived default', async () => {
    const dbPath = defaultDbPath();
    expect(dbPath).toBe(join(workDir, 'container-data', 'graph.db'));
    await seedDb(dbPath);

    const { exitCodes, stderr } = callBackup(['--backup']);
    expect(exitCodes).toEqual([0]);
    expect(stderr).toBe('');

    // Backup landed under dirname(ORCHESTRA_MEMORY_DB_PATH)/backups (i.e.
    // container-data/backups — the /data/backups analogue), not under the
    // unused HOME-derived ~/.claude/orchestra-memory/backups path.
    const target = join(backupsDir(dbPath), `graph-${todayStamp()}.db`);
    expect(target).toBe(
      join(workDir, 'container-data', 'backups', `graph-${todayStamp()}.db`)
    );
    expect(existsSync(target)).toBe(true);

    const homeBackupsDir = join(process.env.HOME!, '.claude', 'orchestra-memory', 'backups');
    expect(existsSync(homeBackupsDir)).toBe(false);

    const backupDb: SqliteDatabase = openDb(target);
    try {
      const row = backupDb
        .prepare(`SELECT COUNT(*) as c FROM observations WHERE text = ?`)
        .get(SEEDED_TEXT) as { c: number };
      expect(row.c).toBe(1);
    } finally {
      backupDb.close();
    }
  });
});

// Proves the WAL-checkpoint-before-copy safety net documented in backup.ts's
// runBackup() (checkpointWal(dbPath) before copyFileSync) actually matters:
// without it, a plain file copy of a WAL-mode SQLite DB can silently miss
// recently-written rows that only live in the -wal sidecar file. This test
// keeps the source connection OPEN (never calls db.close(), which would
// itself trigger an implicit checkpoint as the last connection closes) while
// invoking --backup, so the only thing that can flush the WAL into the
// backup's copied bytes is runBackup()'s own checkpointWal() call.
describe('backup CLI WAL checkpoint safety net', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'orchestra-backup-wal-home-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('includes data written on a still-open connection (not yet closed/checkpointed)', async () => {
    const dbPath = defaultDbPath();
    const db = openDb(dbPath);
    try {
      const repo = createRepository(db);
      const node = await repo.upsertNode({ canonical: 'wal test node', kind: 'other', scope: 'global' });
      await repo.addObservation({ nodeId: node.id, text: SEEDED_TEXT, scope: 'global' });

      // Connection intentionally left open here — runBackup() must checkpoint
      // the WAL itself before copying, since nothing else will.
      const { exitCodes, stderr } = callBackup(['--backup']);
      expect(exitCodes).toEqual([0]);
      expect(stderr).toBe('');

      const target = join(backupsDir(dbPath), `graph-${todayStamp()}.db`);
      expect(existsSync(target)).toBe(true);

      const backupDb: SqliteDatabase = openDb(target);
      try {
        const row = backupDb
          .prepare(`SELECT COUNT(*) as c FROM observations WHERE text = ?`)
          .get(SEEDED_TEXT) as { c: number };
        expect(row.c).toBe(1);
      } finally {
        backupDb.close();
      }
    } finally {
      db.close();
    }
  });
});
