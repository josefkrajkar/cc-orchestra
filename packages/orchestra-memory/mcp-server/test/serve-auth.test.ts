import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServeHttpServer } from '../src/serve.js';

interface RpcResult {
  status: number;
  json: { result?: unknown; error?: { message: string; code?: string } };
}

// Valid-format (16 lowercase hex chars) project id, sent as the
// x-orchestra-project-id header the client always asserts. These auth tests
// only ever call `stats` with a null project_id (global), so the exact value
// doesn't matter for the P0 ownership checks — any well-formed header passes.
const DEFAULT_HEADER_PROJECT_ID = 'aaaaaaaaaaaaaaaa';

describe('serve (--serve-http) auth', () => {
  let tempDir: string;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-serve-auth-'));
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db');
    process.env.ORCHESTRA_MEMORY_LISTEN = '127.0.0.1:0';
  });

  afterEach(async () => {
    delete process.env.ORCHESTRA_MEMORY_DB_PATH;
    delete process.env.ORCHESTRA_MEMORY_LISTEN;
    delete process.env.ORCHESTRA_MEMORY_SERVER_TOKEN;
    delete process.env.ORCHESTRA_MEMORY_ALLOWED_ORIGINS;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    server = createServeHttpServer();
    if (!server) throw new Error('test setup: createServeHttpServer() unexpectedly failed to start');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function rpc(method: string, params: unknown[], headers?: Record<string, string>): Promise<RpcResult> {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-orchestra-project-id': DEFAULT_HEADER_PROJECT_ID,
        ...headers,
      },
      body: JSON.stringify({ method, params }),
    });
    const json = (await res.json()) as RpcResult['json'];
    return { status: res.status, json };
  }

  it('refuses to start when no token is configured and the bind host is not loopback', () => {
    process.env.ORCHESTRA_MEMORY_LISTEN = '0.0.0.0:0';

    const exitCodes: Array<number | undefined> = [];
    const stderrChunks: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    let result: Server | undefined;
    try {
      result = createServeHttpServer();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(result).toBeUndefined();
    expect(exitCodes).toEqual([1]);
    expect(stderrChunks.join('')).toContain('no ORCHESTRA_MEMORY_SERVER_TOKEN is configured');
  });

  it('starts fine with no token when bound to loopback, and allows requests with no Authorization header', async () => {
    await startServer();
    const { status, json } = await rpc('stats', [null]);
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
  });

  it('rejects with 401 when a token is configured and no Authorization header is sent', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    await startServer();
    const { status, json } = await rpc('stats', [null]);
    expect(status).toBe(401);
    expect(json.error?.message).toBe('unauthorized');
  });

  it('rejects with 401 when a token is configured and the wrong token is sent', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    await startServer();
    const { status, json } = await rpc('stats', [null], { Authorization: 'Bearer wrong-token' });
    expect(status).toBe(401);
    expect(json.error?.message).toBe('unauthorized');
  });

  it('allows the request through when the correct bearer token is sent', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    await startServer();
    const { status, json } = await rpc('stats', [null], { Authorization: 'Bearer some-secret-token' });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.result).toBeDefined();
  });

  it('rejects with 403 when Origin is present but not in the allowlist, regardless of a correct token', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    process.env.ORCHESTRA_MEMORY_ALLOWED_ORIGINS = 'http://allowed.example.com';
    await startServer();
    const { status, json } = await rpc('stats', [null], {
      Origin: 'http://not-allowed.example.com',
      Authorization: 'Bearer some-secret-token',
    });
    expect(status).toBe(403);
    expect(json.error?.message).toBe('origin not allowed');
  });

  it('allows the request through when Origin matches the allowlist and the token is correct', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    process.env.ORCHESTRA_MEMORY_ALLOWED_ORIGINS = 'http://allowed.example.com';
    await startServer();
    const { status, json } = await rpc('stats', [null], {
      Origin: 'http://allowed.example.com',
      Authorization: 'Bearer some-secret-token',
    });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
  });

  it('allows the request through when no Origin header is sent at all, even with an allowlist configured', async () => {
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = 'some-secret-token';
    process.env.ORCHESTRA_MEMORY_ALLOWED_ORIGINS = 'http://allowed.example.com';
    await startServer();
    const { status, json } = await rpc('stats', [null], { Authorization: 'Bearer some-secret-token' });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
  });

  it('never logs the configured token, even on a failed-auth attempt', async () => {
    const secretToken = 'super-secret-token-value-12345';
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = secretToken;
    await startServer();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { status } = await rpc('stats', [null], { Authorization: 'Bearer wrong-token' });
      expect(status).toBe(401);

      const allCalls = [...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls];
      const serialized = allCalls.map((args) => args.map((a) => String(a)).join(' ')).join('\n');
      expect(serialized).not.toContain(secretToken);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
