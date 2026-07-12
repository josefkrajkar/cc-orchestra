// Exercises runInject()'s remote-mode fail-open behavior (Task 4.1 of
// docs/design/remote-memory-plan.md Phase 4). Complements
// test/inject-index.test.ts (local-only dispatch) and
// test/server-backend-selection.test.ts (the analogous remote-selection
// logic for the MCP-tools path) rather than duplicating them:
//   (a) ORCHESTRA_MEMORY_URL unset -> byte-for-byte unchanged local behavior
//       (regression guard).
//   (b) URL set but unreachable, local DB has data -> falls back to local,
//       still produces correct output, exits 0, stays fast.
//   (c) URL set but unreachable, local DB ALSO unopenable -> empty output,
//       exits 0, stays fast (bounded by the timeout, never hangs).
//   (d) URL set, remote server healthy and has data -> uses the remote
//       result directly (sanity check that the happy path is wired up).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type SqliteDatabase } from '../src/db/connection.js';
import { createRepository, type Repository } from '../src/db/repository.js';
import { createServeHttpServer } from '../src/serve.js';
import { runInject } from '../src/inject.js';
import { computeProjectId } from '../src/migrate.js';

const ENV_KEYS = [
  'ORCHESTRA_MEMORY_URL',
  'ORCHESTRA_MEMORY_TOKEN',
  'ORCHESTRA_MEMORY_TIMEOUT_MS',
  'ORCHESTRA_MEMORY_DB_PATH',
  'ORCHESTRA_MEMORY_LISTEN',
] as const;

/** Mirrors inject-index.test.ts's callInject helper: mocks process.exit,
 * stdout, and stderr so runInject's fail-open contract can be asserted
 * (exit is always 0, stdout carries only the injectable text) without
 * actually terminating the test process. */
async function callInject(argv: string[]): Promise<{ output: string; exitCode: number | undefined }> {
  const stdoutChunks: string[] = [];
  let exitCode: number | undefined;
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined;
    }) as unknown as typeof process.exit);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runInject(argv);
  } finally {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { output: stdoutChunks.join(''), exitCode };
}

describe('runInject remote-mode fail-open (Task 4.1)', () => {
  let tempDir: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-inject-remote-'));
    for (const key of ENV_KEYS) {
      if (key in process.env) savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
      if (key in savedEnv) process.env[key] = savedEnv[key]!;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedLocalFact(): Promise<void> {
    const db: SqliteDatabase = openDb(process.env.ORCHESTRA_MEMORY_DB_PATH);
    try {
      const repo: Repository = createRepository(db);
      const node = await repo.upsertNode({ canonical: 'Remote Inject Sample', kind: 'fact', scope: 'global' });
      await repo.addObservation({
        nodeId: node.id,
        text: 'A globally visible fact seeded for the remote-inject fallback tests.',
        scope: 'global',
        confidence: 'high',
        validFrom: '2024-01-01T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  }

  it('(a) URL unset: identical to today\'s local-only behavior', async () => {
    await seedLocalFact();
    const { output, exitCode } = await callInject(['--inject', '--project-id', 'remote-inject-a']);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/^# Graph memory \(project remote-inject-a\)/);
    expect(output).toContain('remote inject sample');
  });

  it('(b) URL set but unreachable, local DB has data: falls back to local and stays fast', async () => {
    await seedLocalFact();
    process.env.ORCHESTRA_MEMORY_URL = 'http://127.0.0.1:1'; // nothing listens here
    process.env.ORCHESTRA_MEMORY_TIMEOUT_MS = '200';

    const start = Date.now();
    const { output, exitCode } = await callInject(['--inject', '--project-id', 'remote-inject-b']);
    const elapsedMs = Date.now() - start;

    expect(exitCode).toBe(0);
    expect(output).toMatch(/^# Graph memory \(project remote-inject-b\)/);
    expect(output).toContain('remote inject sample');
    // Bounded by the (200ms) timeout, not hanging — generous margin for CI jitter.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('(c) URL set but unreachable, local DB ALSO unopenable: empty output, still fast', async () => {
    process.env.ORCHESTRA_MEMORY_URL = 'http://127.0.0.1:1';
    process.env.ORCHESTRA_MEMORY_TIMEOUT_MS = '200';
    // Simulate an unopenable local DB: a garbage file at the target path
    // (not a valid SQLite database) so tryOpenDb()'s open-and-migrate throws
    // and returns { db: null }.
    const dbPath = process.env.ORCHESTRA_MEMORY_DB_PATH!;
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, 'not a real sqlite database file');

    const start = Date.now();
    const { output, exitCode } = await callInject(['--inject', '--project-id', 'remote-inject-c']);
    const elapsedMs = Date.now() - start;

    expect(exitCode).toBe(0);
    expect(output).toBe('');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('(d) URL set, remote server healthy with data: uses the remote result', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'orchestra-inject-remote-server-'));
    const savedListen = process.env.ORCHESTRA_MEMORY_LISTEN;
    const savedDbPath = process.env.ORCHESTRA_MEMORY_DB_PATH;
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(remoteDir, 'graph.db');
    process.env.ORCHESTRA_MEMORY_LISTEN = '127.0.0.1:0';

    // Seed the SERVER's own DB (not the client-side local one) with a fact.
    const serverDb = openDb(process.env.ORCHESTRA_MEMORY_DB_PATH);
    const serverRepo = createRepository(serverDb);
    const node = await serverRepo.upsertNode({ canonical: 'Remote Server Fact', kind: 'fact', scope: 'global' });
    await serverRepo.addObservation({
      nodeId: node.id,
      text: 'A fact that only exists on the remote server, not the local client DB.',
      scope: 'global',
      confidence: 'high',
      validFrom: '2024-01-01T00:00:00.000Z',
    });
    serverDb.close();

    const server = createServeHttpServer();
    if (!server) throw new Error('test setup: createServeHttpServer() unexpectedly failed to start');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;

    try {
      // Client-side env: URL points at the live server; local DB path is a
      // separate, empty DB so a successful test can only be explained by the
      // remote path actually being used.
      process.env.ORCHESTRA_MEMORY_URL = `http://127.0.0.1:${address.port}`;
      process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db');

      // The remote client asserts an `x-orchestra-project-id` header derived
      // from THIS process's own cwd (remote/client.ts's computeProjectId()),
      // and serve.ts's ownership check 403s if a method's params-embedded
      // project_id disagrees with that header — so --project-id here must be
      // the real cwd-derived id, not an arbitrary test string.
      const ownProjectId = computeProjectId(process.cwd());
      const { output, exitCode } = await callInject(['--inject', '--project-id', ownProjectId]);
      expect(exitCode).toBe(0);
      expect(output).toMatch(new RegExp(`^# Graph memory \\(project ${ownProjectId}\\)`));
      expect(output).toContain('remote server fact');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(remoteDir, { recursive: true, force: true });
      if (savedListen !== undefined) process.env.ORCHESTRA_MEMORY_LISTEN = savedListen;
      if (savedDbPath !== undefined) process.env.ORCHESTRA_MEMORY_DB_PATH = savedDbPath;
    }
  });
});
