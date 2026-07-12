// Exercises server.ts's selectRepo() — the backend-selection logic used by
// main() to choose between local SQLite and the remote HTTP backend per
// docs/design/remote-memory-plan.md Task 1.4. Not an end-to-end MCP-stdio
// test (that's a later integration-test task); just confirms the local
// branch (unchanged) and the remote branch's fail-open behavior on a
// healthy server, an unreachable one, and a schema mismatch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServeHttpServer } from '../src/serve.js';
import { selectRepo } from '../src/server.js';

const ENV_KEYS = [
  'ORCHESTRA_MEMORY_URL',
  'ORCHESTRA_MEMORY_TOKEN',
  'ORCHESTRA_MEMORY_TIMEOUT_MS',
  'ORCHESTRA_MEMORY_DB_PATH',
  'ORCHESTRA_MEMORY_LISTEN',
] as const;

describe('server.selectRepo', () => {
  let tempDir: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-selectrepo-'));
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

  it('local mode (URL unset): opens the local db, no diagnostic', async () => {
    const { repo, diagnostic } = await selectRepo();
    expect(repo).not.toBeNull();
    expect(diagnostic).toBeNull();
  });

  it('remote mode with a healthy server: builds a repo, no diagnostic', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'orchestra-selectrepo-remote-'));
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(remoteDir, 'graph.db');
    process.env.ORCHESTRA_MEMORY_LISTEN = '127.0.0.1:0';
    const server = createServeHttpServer();
    if (!server) throw new Error('test setup: createServeHttpServer() unexpectedly failed to start');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    process.env.ORCHESTRA_MEMORY_URL = `http://127.0.0.1:${address.port}`;
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db'); // client's own (unused) local path

    try {
      const { repo, diagnostic } = await selectRepo();
      expect(diagnostic).toBeNull();
      expect(repo).not.toBeNull();
      // Sanity: the remote repo is actually wired to the live server.
      const stats = await repo!.stats(null);
      expect(stats).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it('remote mode, server unreachable: fails open with repo null + diagnostic set', async () => {
    process.env.ORCHESTRA_MEMORY_URL = 'http://127.0.0.1:1'; // nothing listens here
    process.env.ORCHESTRA_MEMORY_TIMEOUT_MS = '200';

    const { repo, diagnostic } = await selectRepo();
    expect(repo).toBeNull();
    expect(diagnostic).toContain('orchestra-memory: remote server unreachable at startup');
  });

  it('remote mode, server healthy but schemaVersion mismatched: fails open with repo null + diagnostic set', async () => {
    // A minimal fake /health responder (NOT createServeHttpServer — that
    // always reports this build's own real SCHEMA_VERSION) so we can report
    // an intentionally wrong one and exercise selectRepo()'s
    // `schemaVersion !== SCHEMA_VERSION` branch (src/server.ts).
    const fakeServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, schemaVersion: 'not-a-real-schema-version', serverVersion: '0.0.0' }));
    });
    await new Promise<void>((resolve, reject) => {
      fakeServer.once('listening', () => resolve());
      fakeServer.once('error', reject);
      fakeServer.listen(0, '127.0.0.1');
    });
    const address = fakeServer.address() as AddressInfo;
    process.env.ORCHESTRA_MEMORY_URL = `http://127.0.0.1:${address.port}`;

    try {
      const { repo, diagnostic } = await selectRepo();
      expect(repo).toBeNull();
      expect(diagnostic).toContain('schema mismatch');
    } finally {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    }
  });
});
