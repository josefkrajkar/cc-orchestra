import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteRepository, probeHealth, RemoteUnavailableError } from '../src/remote/client.js';
import { computeProjectId } from '../src/migrate.js';

// Minimal fake HTTP server — NOT a real Repository backend (Task 1.2's
// serve.ts, built in parallel, owns that). Just enough to exercise this
// client's request/response/error handling in isolation.
interface RpcBody {
  method: string;
  params: unknown[];
}

type RpcHandler = (body: RpcBody, req: IncomingMessage) => {
  status?: number;
  delayMs?: number;
  body?: unknown;
  raw?: string;
};

type HealthHandler = () => { status?: number; body?: unknown; raw?: string };

function startFakeServer(): {
  server: Server;
  url: string;
  setRpcHandler: (handler: RpcHandler) => void;
  setHealthHandler: (handler: HealthHandler) => void;
  lastRequestHeaders: () => Record<string, string | string[] | undefined>;
} {
  let rpcHandler: RpcHandler = (body) => ({ status: 200, body: { result: { method: body.method, params: body.params } } });
  let healthHandler: HealthHandler = () => ({ status: 200, body: { ok: true, schemaVersion: 'v1', serverVersion: '0.2.0' } });
  let lastHeaders: Record<string, string | string[] | undefined> = {};

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') {
        const result = healthHandler();
        respond(res, result);
        return;
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: RpcBody;
        try {
          parsed = JSON.parse(raw) as RpcBody;
        } catch {
          respond(res, { status: 200, raw: 'not json' });
          return;
        }
        const result = rpcHandler(parsed, req);
        if (result.delayMs) {
          setTimeout(() => respond(res, result), result.delayMs);
        } else {
          respond(res, result);
        }
        return;
      }
      res.writeHead(404).end();
    });
  });

  function respond(res: ServerResponse, result: { status?: number; body?: unknown; raw?: string }): void {
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    if (result.raw !== undefined) {
      res.end(result.raw);
    } else {
      res.end(JSON.stringify(result.body ?? {}));
    }
  }

  return {
    server,
    url: '', // filled in by caller after listen()
    setRpcHandler: (h) => {
      rpcHandler = h;
    },
    setHealthHandler: (h) => {
      healthHandler = h;
    },
    lastRequestHeaders: () => lastHeaders,
  };
}

describe('remote/client', () => {
  let fake: ReturnType<typeof startFakeServer>;
  let url: string;

  beforeEach(async () => {
    fake = startFakeServer();
    await new Promise<void>((resolve) => {
      fake.server.listen(0, '127.0.0.1', resolve);
    });
    const address = fake.server.address();
    if (address && typeof address === 'object') {
      url = `http://127.0.0.1:${address.port}`;
    } else {
      throw new Error('failed to determine fake server address');
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('sends POST {url}/rpc with method/params body, content-type, authorization, and project-id headers', async () => {
    const repo = createRemoteRepository({ url, token: 'secret-token', timeoutMs: 1000 });
    const result = await repo.stats(null);

    expect(result).toEqual({ method: 'stats', params: [null] });

    const headers = fake.lastRequestHeaders();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer secret-token');
    expect(headers['x-orchestra-project-id']).toBe(computeProjectId(process.cwd()));
  });

  it('omits the authorization header entirely when no token is passed', async () => {
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await repo.stats(null);

    const headers = fake.lastRequestHeaders();
    expect(headers['authorization']).toBeUndefined();
  });

  it('works for an object-param method (upsertNode)', async () => {
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    const input = { canonical: 'Foo', kind: 'entity', scope: 'global' as const };
    const result = await repo.upsertNode(input);
    expect(result).toEqual({ method: 'upsertNode', params: [input] });
  });

  it('works for a multi-positional-arg method (findSimilarNodes)', async () => {
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    const result = await repo.findSimilarNodes('Foo', 'global', null, 5);
    expect(result).toEqual({ method: 'findSimilarNodes', params: ['Foo', 'global', null, 5] });
  });

  it('rejects with RemoteUnavailableError mentioning "timed out" when the server delays past timeoutMs', async () => {
    fake.setRpcHandler((body) => ({ status: 200, body: { result: body }, delayMs: 300 }));
    const repo = createRemoteRepository({ url, timeoutMs: 50 });

    await expect(repo.stats(null)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RemoteUnavailableError);
      expect((err as Error).message).toMatch(/timed out/);
      return true;
    });
  });

  it('rejects with RemoteUnavailableError on a network error (nothing listening on the port)', async () => {
    const repo = createRemoteRepository({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    await expect(repo.stats(null)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('rejects with RemoteUnavailableError on HTTP 401', async () => {
    fake.setRpcHandler(() => ({ status: 401, body: { error: { message: 'nope' } } }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await expect(repo.stats(null)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('rejects with RemoteUnavailableError on HTTP 500', async () => {
    fake.setRpcHandler(() => ({ status: 500, body: { error: { message: 'boom' } } }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await expect(repo.stats(null)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('rejects with RemoteUnavailableError whose message includes the inner error message on a 200 {error} body', async () => {
    fake.setRpcHandler(() => ({ status: 200, body: { error: { message: 'scope violation for private row' } } }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });

    await expect(repo.stats(null)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RemoteUnavailableError);
      expect((err as Error).message).toContain('scope violation for private row');
      return true;
    });
  });

  it('rejects with RemoteUnavailableError on malformed JSON', async () => {
    fake.setRpcHandler(() => ({ status: 200, raw: 'not valid json{{{' }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await expect(repo.stats(null)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('resolves with an undefined result on a 2xx body with neither result nor error (void-returning method wire shape)', async () => {
    // This is the legitimate wire shape for void-returning Repository methods
    // (addAlias, invalidateObservation, supersedeObservation, invalidateEdge,
    // supersedeEdge): serve.ts sends `{ result: undefined }`, which
    // JSON.stringify serializes as a bare `{}` (an undefined-valued object
    // property is dropped entirely) — a 2xx response with no `error` key IS
    // the success signal, not the presence of a `result` key. See
    // src/remote/client.ts's `call()` doc comment and
    // test/remote-integration.test.ts (task-5.2) for the full root-cause
    // writeup of the bug this test now guards against regressing.
    fake.setRpcHandler(() => ({ status: 200, body: { somethingElse: true } }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await expect(repo.stats(null)).resolves.toBeUndefined();
  });

  it('rejects with RemoteUnavailableError on a non-2xx-shaped body that is not even an object', async () => {
    fake.setRpcHandler(() => ({ status: 200, raw: 'null' }));
    const repo = createRemoteRepository({ url, timeoutMs: 1000 });
    await expect(repo.stats(null)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('probeHealth resolves with the parsed HealthResponse on a healthy response', async () => {
    fake.setHealthHandler(() => ({ status: 200, body: { ok: true, schemaVersion: 'v3', serverVersion: '0.3.0' } }));
    const result = await probeHealth(url, 1000);
    expect(result).toEqual({ ok: true, schemaVersion: 'v3', serverVersion: '0.3.0' });
  });

  it('probeHealth rejects with RemoteUnavailableError against a down server', async () => {
    await expect(probeHealth('http://127.0.0.1:1', 500)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('probeHealth rejects with RemoteUnavailableError on a malformed health response', async () => {
    fake.setHealthHandler(() => ({ status: 200, body: { ok: true } }));
    await expect(probeHealth(url, 1000)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });
});
