import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDbPath, openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository } from '../src/db/repository.js';
import { computeProjectId, runMigrate } from '../src/migrate.js';

interface CallResult {
  exitCodes: Array<number | undefined>;
  stdout: string;
  stderr: string;
}

/** Runs runMigrate() with process.exit/stdout/stderr mocked so the test
 * process itself never terminates and output can be asserted on. */
function callMigrate(argv: string[]): CallResult {
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
    runMigrate(argv);
  } finally {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { exitCodes, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

function writeWisdomFixture(projectRoot: string): string {
  const dir = join(projectRoot, '.claude');
  mkdirSync(dir, { recursive: true });
  const wisdom = {
    conventions: [
      {
        text: 'Always use path aliases instead of relative ../../ imports.',
        ts: '2026-01-01T00:00:00.000Z',
        confidence: 'high',
        source: 'user',
      },
      'Legacy convention entry as a plain string.',
    ],
    gotchas: [
      {
        text: 'Prisma generate must run before tsc or type errors appear.',
        ts: '2026-02-02T00:00:00.000Z',
        confidence: 'medium',
      },
    ],
    decisions: [],
    failed_approaches: [],
  };
  const path = join(dir, 'orchestra-wisdom.json');
  writeFileSync(path, JSON.stringify(wisdom, null, 2));
  return path;
}

function writeMdFixtures(home: string): { userMd: string; projectMd: string; memoryMd: string } {
  const memDir = join(home, '.claude', 'projects', 'encoded-project', 'memory');
  mkdirSync(memDir, { recursive: true });

  const userMd = join(memDir, 'user_profile.md');
  writeFileSync(
    userMd,
    '---\nname: User profile\ndescription: A user-level fact\ntype: user\n---\nSome user memory content.\n'
  );

  const projectMd = join(memDir, 'project_notes.md');
  writeFileSync(
    projectMd,
    '---\nname: Project notes\ndescription: A project-level fact\ntype: project\n---\nSome project memory content.\n'
  );

  const memoryMd = join(memDir, 'MEMORY.md');
  writeFileSync(memoryMd, '# This is the aggregate MEMORY.md — must always be excluded.\n');

  return { userMd, projectMd, memoryMd };
}

function countWisdomObservations(dbPath: string): number {
  const db: SqliteDatabase = openDb(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.canonical = 'project wisdom'`
      )
      .get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe('migrate CLI', () => {
  let home: string;
  let projectRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'orchestra-migrate-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'orchestra-migrate-project-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dry-run prints wisdom counts + md inventory and writes nothing', () => {
    const wisdomPath = writeWisdomFixture(projectRoot);
    const { userMd, projectMd, memoryMd } = writeMdFixtures(home);

    const { exitCodes, stdout, stderr } = callMigrate(['--migrate', '--project-root', projectRoot]);

    expect(exitCodes).toEqual([0]);
    expect(stderr).toBe('');
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain(wisdomPath);
    expect(stdout).toContain('conventions (category: convention): 2 entries (1 v2 objects, 1 legacy strings)');
    expect(stdout).toContain('gotchas (category: gotcha): 1 entries (1 v2 objects, 0 legacy strings)');
    expect(stdout).toContain('Total: 3 entries (2 v2 objects, 1 legacy strings)');

    expect(stdout).toContain(userMd);
    expect(stdout).toContain('type: user → suggested scope: global');
    expect(stdout).toContain(projectMd);
    expect(stdout).toContain('type: project → suggested scope: project');
    expect(stdout).not.toContain(memoryMd);

    // Dry run must never create the DB.
    expect(existsSync(defaultDbPath())).toBe(false);
  });

  it('dry-run reports missing wisdom file and empty md inventory gracefully', () => {
    const { exitCodes, stdout } = callMigrate(['--migrate', '--project-root', projectRoot]);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('Not found:');
    expect(stdout).toContain('No legacy markdown memory files found');
    expect(existsSync(defaultDbPath())).toBe(false);
  });

  it('--commit imports wisdom entries and backs up a pre-existing DB', () => {
    writeWisdomFixture(projectRoot);

    // Simulate a DB that already existed from prior orchestra-memory usage.
    const dbPath = defaultDbPath();
    const preexisting = openDb(dbPath);
    preexisting.close();
    expect(existsSync(dbPath)).toBe(true);

    const { exitCodes, stdout } = callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('COMMIT');
    expect(stdout).toContain('DB backed up');
    expect(stdout).toContain('saved=3, duplicate=0, rejected=0');

    const dbDir = join(home, '.claude', 'orchestra-memory');
    const backups = readdirSync(dbDir).filter((f) => f.startsWith('graph.db.bak-'));
    expect(backups.length).toBeGreaterThan(0);

    const db = openDb(dbPath);
    try {
      const rows = db
        .prepare(
          `SELECT o.text as text, o.category as category, o.confidence as confidence, o.source as source,
                  o.scope as scope, o.project_id as projectId, o.valid_from as validFrom
           FROM observations o JOIN nodes n ON n.id = o.node_id
           WHERE n.canonical = 'project wisdom'
           ORDER BY o.id`
        )
        .all() as Array<{
        text: string;
        category: string;
        confidence: string;
        source: string;
        scope: string;
        projectId: string;
        validFrom: string;
      }>;

      expect(rows).toHaveLength(3);
      const projectId = computeProjectId(projectRoot);
      for (const row of rows) {
        expect(row.source).toBe('migration:wisdom');
        expect(row.scope).toBe('project');
        expect(row.projectId).toBe(projectId);
      }

      const aliases = rows.find((r) => r.text.includes('path aliases'));
      expect(aliases?.category).toBe('convention');
      expect(aliases?.confidence).toBe('high');
      expect(aliases?.validFrom).toBe('2026-01-01T00:00:00.000Z');

      const prisma = rows.find((r) => r.text.includes('Prisma generate'));
      expect(prisma?.category).toBe('gotcha');
      expect(prisma?.confidence).toBe('medium');
      expect(prisma?.validFrom).toBe('2026-02-02T00:00:00.000Z');

      const legacy = rows.find((r) => r.text.includes('Legacy convention entry'));
      expect(legacy?.category).toBe('convention');
      expect(legacy?.confidence).toBe('medium');
    } finally {
      db.close();
    }
  });

  it('--commit with no pre-existing DB skips backup but still imports', () => {
    writeWisdomFixture(projectRoot);
    expect(existsSync(defaultDbPath())).toBe(false);

    const { exitCodes, stdout } = callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);

    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('skipped backup');
    expect(countWisdomObservations(defaultDbPath())).toBe(3);
  });

  it('re-running --commit is idempotent — no duplicate observations are created', () => {
    writeWisdomFixture(projectRoot);

    callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);
    const dbPath = defaultDbPath();
    expect(countWisdomObservations(dbPath)).toBe(3);

    const { exitCodes, stdout } = callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);
    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('saved=0, duplicate=3, rejected=0');
    expect(countWisdomObservations(dbPath)).toBe(3);
  });

  it('never touches original wisdom.json or markdown memory files on disk', () => {
    const wisdomPath = writeWisdomFixture(projectRoot);
    const { userMd, projectMd } = writeMdFixtures(home);

    const beforeWisdom = readFileSync(wisdomPath, 'utf8');
    const beforeUserContent = readFileSync(userMd, 'utf8');
    const beforeProjectContent = readFileSync(projectMd, 'utf8');
    const beforeUserMtime = statSync(userMd).mtimeMs;
    const beforeProjectMtime = statSync(projectMd).mtimeMs;

    callMigrate(['--migrate', '--project-root', projectRoot]);
    callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);
    callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);

    expect(readFileSync(wisdomPath, 'utf8')).toBe(beforeWisdom);
    expect(readFileSync(userMd, 'utf8')).toBe(beforeUserContent);
    expect(readFileSync(projectMd, 'utf8')).toBe(beforeProjectContent);
    expect(statSync(userMd).mtimeMs).toBe(beforeUserMtime);
    expect(statSync(projectMd).mtimeMs).toBe(beforeProjectMtime);
  });

  // Finding 4: the DB runs in WAL mode, so recent writes may live only in
  // the "graph.db-wal" sidecar until checkpointed. --commit's backup must
  // force a checkpoint before copying, or a plain file copy of the main .db
  // file can silently miss un-checkpointed rows.
  it('checkpoints the WAL before backing up, so the backup contains recently-written rows', () => {
    const dbPath = defaultDbPath();
    const liveDb = openDb(dbPath);
    const liveRepo = createRepository(liveDb);
    const node = liveRepo.upsertNode({ canonical: 'wal test node', kind: 'other', scope: 'global' });
    liveRepo.addObservation({
      nodeId: node.id,
      text: 'This row must survive into the backup even before any checkpoint.',
      scope: 'global',
    });
    // Deliberately do NOT close/checkpoint liveDb — the write above may still
    // be sitting only in the WAL sidecar file on disk.

    writeWisdomFixture(projectRoot);
    const { exitCodes, stdout } = callMigrate(['--migrate', '--commit', '--project-root', projectRoot]);
    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('DB backed up');

    liveDb.close();

    const dbDir = join(home, '.claude', 'orchestra-memory');
    const backups = readdirSync(dbDir).filter((f) => f.startsWith('graph.db.bak-'));
    expect(backups.length).toBeGreaterThan(0);
    const backupPath = join(dbDir, backups[backups.length - 1]!);

    const backupDb = openDb(backupPath);
    try {
      const row = backupDb
        .prepare(
          `SELECT COUNT(*) as c FROM observations WHERE text = 'This row must survive into the backup even before any checkpoint.'`
        )
        .get() as { c: number };
      expect(row.c).toBe(1);
    } finally {
      backupDb.close();
    }
  });

  it('supports --wisdom and --memory-dir overrides', () => {
    const customWisdom = join(projectRoot, 'custom-wisdom.json');
    writeFileSync(
      customWisdom,
      JSON.stringify({
        conventions: [{ text: 'Custom-path convention fact.', confidence: 'low' }],
        gotchas: [],
        decisions: [],
        failed_approaches: [],
      })
    );

    const customMemoryDir = mkdtempSync(join(tmpdir(), 'orchestra-migrate-mem-'));
    writeFileSync(
      join(customMemoryDir, 'note.md'),
      '---\nname: Note\ndescription: override dir note\ntype: reference\n---\nContent.\n'
    );
    writeFileSync(join(customMemoryDir, 'MEMORY.md'), '# excluded\n');

    const { stdout } = callMigrate([
      '--migrate',
      '--project-root',
      projectRoot,
      '--wisdom',
      customWisdom,
      '--memory-dir',
      customMemoryDir,
    ]);

    expect(stdout).toContain(customWisdom);
    expect(stdout).toContain('Total: 1 entries (1 v2 objects, 0 legacy strings)');
    expect(stdout).toContain(join(customMemoryDir, 'note.md'));
    expect(stdout).toContain('type: reference → suggested scope: global');
    expect(stdout).not.toContain('MEMORY.md');

    rmSync(customMemoryDir, { recursive: true, force: true });
  });
});
