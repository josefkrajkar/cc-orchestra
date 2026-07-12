// Exercises the P0 security fix in src/serve.ts: server-side ownership
// enforcement for the six Repository methods that take a raw numeric id (or
// node id) with NO project_id param (addAlias, findSupersedeTarget,
// invalidateObservation, invalidateEdge, supersedeObservation, supersedeEdge).
// See docs/design/remote-memory-plan.md section 2 and remote/protocol.ts's
// PROJECT_ID_PARAM_INDEX/PROJECT_ID_OBJECT_FIELD comment for the full
// rationale: without this, a bearer-token holder could invalidate/supersede/
// alias ANY row in ANY project by enumerating small auto-increment ids, and
// use findSupersedeTarget as an oracle to learn a foreign row's projectId.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// Two well-formed (16 lowercase hex chars) but distinct project ids, standing
// in for two different clients/projects sharing one server + bearer token.
const PROJECT_A = 'aaaaaaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbbbbbbbbbb';

describe('serve (--serve-http) P0 ownership enforcement', () => {
  let tempDir: string;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-serve-ownership-'));
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

  /** `headerProjectId: null` omits the x-orchestra-project-id header entirely
   * (used only by the missing-header test); every other caller passes a
   * project id string. */
  async function rpc(
    method: string,
    params: unknown[],
    headerProjectId: string | null = PROJECT_A
  ): Promise<RpcResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (headerProjectId !== null) headers['x-orchestra-project-id'] = headerProjectId;
    const res = await fetch(`${baseUrl}/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, params }) });
    const json = (await res.json()) as RpcResult['json'];
    return { status: res.status, json };
  }

  it('rejects with 400 when x-orchestra-project-id header is missing', async () => {
    const { status, json } = await rpc('stats', [null], null);
    expect(status).toBe(400);
    expect(json.error?.message).toMatch(/x-orchestra-project-id/);
  });

  it('rejects with 400 when x-orchestra-project-id header is malformed', async () => {
    const { status, json } = await rpc('stats', [null], 'not-hex!');
    expect(status).toBe(400);
    expect(json.error?.message).toMatch(/x-orchestra-project-id/);
  });

  it('rejects with 403 when params project_id does not match the x-orchestra-project-id header', async () => {
    const { status, json } = await rpc('stats', [PROJECT_B], PROJECT_A);
    expect(status).toBe(403);
    expect(json.error?.message).toMatch(/project_id mismatch/);
  });

  it('findSupersedeTarget: returns the row for global and for own-project observations, null for another project\'s', async () => {
    const globalNode = (await rpc('upsertNode', [{ canonical: 'Global Node', kind: 'other', scope: 'global' }])).json
      .result as { id: number };
    const globalObs = (
      await rpc('addObservation', [{ nodeId: globalNode.id, text: 'A global fact.', scope: 'global' }])
    ).json.result as number;

    const nodeA = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Project A Node', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const obsA = (
      await rpc(
        'addObservation',
        [{ nodeId: nodeA.id, text: 'A fact owned by project A.', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as number;

    // Global: visible from either project's perspective.
    const globalFromA = await rpc('findSupersedeTarget', [globalObs], PROJECT_A);
    expect(globalFromA.status).toBe(200);
    expect((globalFromA.json.result as { id: number } | null)?.id).toBe(globalObs);
    const globalFromB = await rpc('findSupersedeTarget', [globalObs], PROJECT_B);
    expect((globalFromB.json.result as { id: number } | null)?.id).toBe(globalObs);

    // Own project: visible.
    const ownFromA = await rpc('findSupersedeTarget', [obsA], PROJECT_A);
    expect(ownFromA.status).toBe(200);
    expect((ownFromA.json.result as { id: number } | null)?.id).toBe(obsA);

    // Foreign project: nulled out, not an error (mirrors the "does not
    // exist" behavior save.ts/invalidate.ts already render for a missing row).
    const foreignFromB = await rpc('findSupersedeTarget', [obsA], PROJECT_B);
    expect(foreignFromB.status).toBe(200);
    expect(foreignFromB.json.result).toBeNull();
  });

  it("project B cannot invalidateObservation / supersedeObservation project A's observations over /rpc", async () => {
    const nodeA = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Obs Owner Node', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const obsA1 = (
      await rpc(
        'addObservation',
        [{ nodeId: nodeA.id, text: 'First project A fact.', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as number;
    const obsA2 = (
      await rpc(
        'addObservation',
        [{ nodeId: nodeA.id, text: 'Second project A fact.', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as number;

    const invalidateAttempt = await rpc('invalidateObservation', [obsA1], PROJECT_B);
    expect(invalidateAttempt.status).toBe(403);

    const supersedeAttempt = await rpc('supersedeObservation', [obsA1, obsA2], PROJECT_B);
    expect(supersedeAttempt.status).toBe(403);

    // Rows unchanged: still valid, not superseded, from project A's own view.
    const stillValid = (await rpc('findSupersedeTarget', [obsA1], PROJECT_A)).json.result as {
      invalidatedAt: string | null;
    } | null;
    expect(stillValid?.invalidatedAt).toBeNull();
  });

  it("project B cannot invalidateEdge / supersedeEdge project A's edges over /rpc", async () => {
    const nodeA1 = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Edge Src A', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const nodeA2 = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Edge Dst A', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const edgeA1 = (
      await rpc(
        'upsertEdge',
        [{ srcId: nodeA1.id, predicate: 'relates_to', dstId: nodeA2.id, scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const edgeA2 = (
      await rpc(
        'upsertEdge',
        [{ srcId: nodeA2.id, predicate: 'relates_to', dstId: nodeA1.id, scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };

    const invalidateAttempt = await rpc('invalidateEdge', [edgeA1.id], PROJECT_B);
    expect(invalidateAttempt.status).toBe(403);

    const supersedeAttempt = await rpc('supersedeEdge', [edgeA1.id, edgeA2.id], PROJECT_B);
    expect(supersedeAttempt.status).toBe(403);

    // Both edges still visible (not invalidated) from project A's own view.
    const visible = (
      await rpc('fetchVisibleEdges', [[nodeA1.id, nodeA2.id], PROJECT_A], PROJECT_A)
    ).json.result as unknown[];
    expect(visible.length).toBe(2);
  });

  it("project B cannot addAlias onto project A's node over /rpc", async () => {
    const nodeA = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Alias Target Node', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };

    const aliasAttempt = await rpc('addAlias', [nodeA.id, 'sneaky-alias'], PROJECT_B);
    expect(aliasAttempt.status).toBe(403);

    // Alias was never written: searching for it under project A's own scope
    // finds nothing.
    const matches = (
      await rpc('findSimilarNodes', ['sneaky-alias', 'project', PROJECT_A], PROJECT_A)
    ).json.result as unknown[];
    expect(matches).toHaveLength(0);
  });

  it('happy path: same-project invalidate/supersede/addAlias/findSupersedeTarget still work end-to-end over /rpc', async () => {
    const nodeA = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Happy Path Node', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const obsA1 = (
      await rpc(
        'addObservation',
        [{ nodeId: nodeA.id, text: 'Original fact for happy path.', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as number;
    const obsA2 = (
      await rpc(
        'addObservation',
        [{ nodeId: nodeA.id, text: 'Replacement fact for happy path.', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as number;

    const aliasResult = await rpc('addAlias', [nodeA.id, 'happy-alias'], PROJECT_A);
    expect(aliasResult.status).toBe(200);
    const matches = (
      await rpc('findSimilarNodes', ['happy-alias', 'project', PROJECT_A], PROJECT_A)
    ).json.result as Array<{ id: number }>;
    expect(matches.some((m) => m.id === nodeA.id)).toBe(true);

    const supersedeResult = await rpc('supersedeObservation', [obsA1, obsA2], PROJECT_A);
    expect(supersedeResult.status).toBe(200);
    const afterSupersede = (await rpc('findSupersedeTarget', [obsA1], PROJECT_A)).json.result as {
      invalidatedAt: string | null;
    } | null;
    expect(afterSupersede?.invalidatedAt).not.toBeNull();

    const invalidateResult = await rpc('invalidateObservation', [obsA2], PROJECT_A);
    expect(invalidateResult.status).toBe(200);
    const afterInvalidate = (await rpc('findSupersedeTarget', [obsA2], PROJECT_A)).json.result as {
      invalidatedAt: string | null;
    } | null;
    expect(afterInvalidate?.invalidatedAt).not.toBeNull();
  });

  it('rejects with 403 when an OBJECT_FIELD method (upsertNode) has a params projectId mismatching the x-orchestra-project-id header', async () => {
    // The existing 'rejects with 403 when params project_id does not match'
    // test above only exercises `stats`, a PROJECT_ID_PARAM_INDEX (positional)
    // method. upsertNode instead carries its project id on a `projectId`
    // field of the single input object at params[0] (PROJECT_ID_OBJECT_FIELD
    // in remote/protocol.ts) — this proves the object-field extraction path
    // is cross-checked against the header just as strictly as the positional
    // one.
    const { status, json } = await rpc(
      'upsertNode',
      [{ canonical: 'Mismatched Object Field Node', kind: 'other', scope: 'project', projectId: PROJECT_B }],
      PROJECT_A
    );
    expect(status).toBe(403);
    expect(json.error?.message).toMatch(/project_id mismatch/);
  });

  it('happy path: same-project invalidateEdge/supersedeEdge work end-to-end over /rpc', async () => {
    // The existing happy-path test above covers observations + addAlias but
    // not edges (its sibling denial test, "project B cannot invalidateEdge /
    // supersedeEdge project A's edges over /rpc", only exercises the
    // cross-project rejection). This covers the same-project SUCCESS path for
    // both edge methods.
    const nodeA1 = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Happy Edge Src', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const nodeA2 = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Happy Edge Dst', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const edgeA1 = (
      await rpc(
        'upsertEdge',
        [{ srcId: nodeA1.id, predicate: 'relates_to', dstId: nodeA2.id, scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };
    const edgeA2 = (
      await rpc(
        'upsertEdge',
        [{ srcId: nodeA2.id, predicate: 'relates_to', dstId: nodeA1.id, scope: 'project', projectId: PROJECT_A }],
        PROJECT_A
      )
    ).json.result as { id: number };

    const supersedeResult = await rpc('supersedeEdge', [edgeA1.id, edgeA2.id], PROJECT_A);
    expect(supersedeResult.status).toBe(200);

    const invalidateResult = await rpc('invalidateEdge', [edgeA2.id], PROJECT_A);
    expect(invalidateResult.status).toBe(200);

    // Both edges (the superseded original and the subsequently invalidated
    // replacement) are gone from project A's own visible-edges view.
    const visible = (
      await rpc('fetchVisibleEdges', [[nodeA1.id, nodeA2.id], PROJECT_A], PROJECT_A)
    ).json.result as unknown[];
    expect(visible.length).toBe(0);
  });

  // Regression guard for the id-param shape validation in serve.ts
  // (expectIntegerParams/ID_PARAM_COUNT): malformed ids on the six id-based
  // methods must produce a clean 400, never fall through to the ownership
  // lookup or a generic 500.
  it('rejects with 400 when an id-based method gets a non-integer id param', async () => {
    for (const [method, params] of [
      ['invalidateObservation', ['not-a-number']],
      ['findSupersedeTarget', [1.5]],
      ['addAlias', [null, 'alias']],
      ['supersedeEdge', [1, 'two']],
    ] as [string, unknown[]][]) {
      const { status, json } = await rpc(method, params, PROJECT_A);
      expect(status, `${method} should 400 on non-integer id`).toBe(400);
      expect(json.error?.message).toMatch(/integer id param/);
    }
  });

  it('rejects with 400 when an id-based method gets too few params', async () => {
    for (const [method, params] of [
      ['supersedeObservation', [1]],
      ['supersedeEdge', []],
      ['invalidateEdge', []],
    ] as [string, unknown[]][]) {
      const { status, json } = await rpc(method, params, PROJECT_A);
      expect(status, `${method} should 400 on too few params`).toBe(400);
      expect(json.error?.message).toMatch(/integer id param/);
    }
  });
});
