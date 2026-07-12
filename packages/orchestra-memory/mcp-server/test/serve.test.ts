import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SCHEMA_VERSION } from '../src/db/connection.js';
import { createServeHttpServer, SERVER_VERSION } from '../src/serve.js';
import { METHOD_NAMES } from '../src/remote/protocol.js';

interface RpcResult {
  status: number;
  json: { result?: unknown; error?: { message: string; code?: string } };
}

// Valid-format (16 lowercase hex chars) project id, sent as the
// x-orchestra-project-id header the client always asserts. These
// "dispatch every method" fixtures are all global scope, so the exact value
// doesn't matter for the P0 ownership checks — any well-formed header passes.
const DEFAULT_HEADER_PROJECT_ID = 'aaaaaaaaaaaaaaaa';

describe('serve (--serve-http)', () => {
  let tempDir: string;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-serve-'));
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db');
    process.env.ORCHESTRA_MEMORY_LISTEN = '127.0.0.1:0';

    server = createServeHttpServer();
    if (!server) throw new Error('test setup: createServeHttpServer() unexpectedly failed to start');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    delete process.env.ORCHESTRA_MEMORY_DB_PATH;
    delete process.env.ORCHESTRA_MEMORY_LISTEN;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

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

  it('GET /health returns ok with real schema/server versions', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION, serverVersion: SERVER_VERSION });
  });

  it('dispatches every Repository method over POST /rpc', async () => {
    const nodeA = (await rpc('upsertNode', [{ canonical: 'Alpha Node', kind: 'other', scope: 'global' }])).json
      .result as { id: number };
    const nodeB = (await rpc('upsertNode', [{ canonical: 'Beta Node', kind: 'other', scope: 'global' }])).json
      .result as { id: number };
    expect(nodeA.id).toBeTypeOf('number');
    expect(nodeB.id).toBeTypeOf('number');

    const obs1 = (
      await rpc('addObservation', [{ nodeId: nodeA.id, text: 'First observation for dispatch test.', scope: 'global' }])
    ).json.result as number;
    const obs2 = (
      await rpc('addObservation', [{ nodeId: nodeA.id, text: 'Second observation for dispatch test.', scope: 'global' }])
    ).json.result as number;
    const obs3 = (
      await rpc('addObservation', [{ nodeId: nodeA.id, text: 'Third observation for dispatch test.', scope: 'global' }])
    ).json.result as number;

    const edge1 = (
      await rpc('upsertEdge', [{ srcId: nodeA.id, predicate: 'relates_to', dstId: nodeB.id, scope: 'global' }])
    ).json.result as { id: number };
    const edge2 = (
      await rpc('upsertEdge', [{ srcId: nodeB.id, predicate: 'relates_to', dstId: nodeA.id, scope: 'global' }])
    ).json.result as { id: number };

    // Minimal-but-valid params per method, in the shape the wire protocol
    // expects (see remote/protocol.ts PROJECT_ID_PARAM_INDEX/OBJECT_FIELD
    // comments for which positions carry project_id). Methods that don't
    // need realistic fixtures (e.g. listObservationsForNode on a node with
    // no matching rows) are exercised with a "valid shape, empty result" call
    // — that is a legitimate success case, not a special case to special-case.
    const paramsByMethod: Record<string, unknown[]> = {
      upsertNode: [{ canonical: 'Gamma Node', kind: 'other', scope: 'global' }],
      addAlias: [nodeA.id, 'alpha-alias'],
      findSimilarNodes: ['Alpha', 'global'],
      addObservation: [{ nodeId: nodeA.id, text: 'Fourth observation for dispatch test.', scope: 'global' }],
      supersedeObservation: [obs1, obs2],
      invalidateObservation: [obs3],
      upsertEdge: [{ srcId: nodeA.id, predicate: 'connects_to', dstId: nodeB.id, scope: 'global' }],
      invalidateEdge: [edge2.id],
      supersedeEdge: [edge1.id, edge2.id],
      searchObservations: [{ query: 'observation' }],
      expandFromNodes: [[nodeA.id], 1],
      stats: [null],
      fetchVisibleEdges: [[nodeA.id, nodeB.id], null],
      findSupersedeTarget: [obs1],
      findNearDuplicate: ['completely unrelated near duplicate probe text', 'global', null],
      listNodes: [null, null, null],
      listObservationsForNode: [nodeA.id, null],
      listWisdomRows: [['convention'], null, 10],
      injectObservations: ['global', null, 10],
      highConfidenceObservations: ['global', null, 10],
      entityRoster: [null],
    };

    expect(Object.keys(paramsByMethod).sort()).toEqual([...METHOD_NAMES].sort());

    for (const method of METHOD_NAMES) {
      const params = paramsByMethod[method];
      const { status, json } = await rpc(method, params!);
      expect(status, `status for ${method}`).toBe(200);
      expect(json.error, `unexpected error for ${method}: ${JSON.stringify(json.error)}`).toBeUndefined();
    }
  });

  it('POST /rpc with an unknown method returns 400 with UNKNOWN_METHOD', async () => {
    const { status, json } = await rpc('notARealMethod', []);
    expect(status).toBe(400);
    expect(json.error?.code).toBe('UNKNOWN_METHOD');
  });

  it('POST /rpc with a missing method field returns 400', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/malformed request/);
  });

  it('POST /rpc with non-array params returns 400', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'stats', params: { not: 'an array' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/malformed request/);
  });

  it('POST /rpc with an invalid project_id format returns 400', async () => {
    const { status, json } = await rpc('stats', ['not-hex!']);
    expect(status).toBe(400);
    expect(json.error?.message).toBe('invalid project_id format');
  });

  it('GET on an unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBe('not found');
  });

  it('fails closed (process.exit(1), no server) when the DB cannot be opened', () => {
    // Point ORCHESTRA_MEMORY_DB_PATH at a path whose parent segment is a
    // FILE (not a directory), so mkdirSync inside openDb() throws.
    const brokenParent = join(tempDir, 'not-a-dir');
    writeFileSync(brokenParent, 'i am a file, not a directory');
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(brokenParent, 'nested', 'graph.db');

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
    expect(stderrChunks.join('')).toContain('failed to open database');
  });
});
