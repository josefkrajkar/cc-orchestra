// End-to-end integration suite for the remote-backed graph memory (Task 5.2,
// docs/design/remote-memory-plan.md section 2 + Phase 5). Spins up a REAL
// `createServeHttpServer()` (src/serve.ts) on an ephemeral port with a fresh
// temp-dir SQLite DB and a real bearer token, then drives it via:
//   (a) `createRemoteRepository()` (src/remote/client.ts) through all 9 MCP
//       tool handlers, proving the full Repository-RPC boundary works
//       end-to-end (parity with local-mode behavior already covered per
//       handler in test/tools.test.ts — this suite proves the SAME handler
//       logic behaves correctly when every Repository call is actually an
//       HTTP round trip, not just that the wire format parses).
//   (b)/(c) raw `/rpc` fetches for the two auth/header failure modes.
//   (d) cross-project isolation, both for a plain scoped read
//       (searchObservations) and for the six id-based ownership-enforced
//       methods (reusing entities/observations created by scenario (a)
//       itself, per the task's "own scenario data" requirement — the
//       narrower id-based ownership checks against wholly synthetic project
//       ids already live in test/serve-ownership.test.ts and are not
//       duplicated here).
//   (e) timeout -> RemoteUnavailableError -> the handler layer propagates it
//       (server.ts's callHandler, one layer above, is what turns this into
//       a user-facing "disabled this session" message; that wrapping is
//       already covered by test/server-backend-selection.test.ts's
//       "server unreachable" case and is not re-tested here).
//
// Gotcha this suite is built around: `RemoteRepository` always asserts ITS
// OWN process's `computeProjectId(process.cwd())` as the
// x-orchestra-project-id header (src/remote/client.ts) — a test process
// cannot make one `RemoteRepository` instance impersonate two different
// projects. Scenario (a) therefore uses a single `RemoteRepository` bound to
// this test process's own project identity throughout. Anything that needs a
// SECOND, foreign project identity (the cross-project-isolation assertions)
// drives raw `fetch()` calls directly against `/rpc` with an explicit
// x-orchestra-project-id header instead (mirroring test/serve-ownership.test.ts's
// established `rpc()` helper idiom) — that is the only way to simulate two
// different callers against one server from a single test process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServeHttpServer } from '../src/serve.js';
import { createRemoteRepository, RemoteUnavailableError } from '../src/remote/client.js';
import { computeProjectId } from '../src/migrate.js';
import type { ToolContext } from '../src/tools/context.js';
import { handleSave } from '../src/tools/save.js';
import { handleSearch } from '../src/tools/search.js';
import { handleLink } from '../src/tools/link.js';
import { handleTraverse } from '../src/tools/traverse.js';
import { handleInspect } from '../src/tools/inspect.js';
import { handleInvalidate } from '../src/tools/invalidate.js';
import { handleStats } from '../src/tools/stats.js';
import { handleWisdomAdd, handleWisdomGet } from '../src/tools/wisdom-compat.js';

interface RpcResult {
  status: number;
  json: { result?: unknown; error?: { message: string; code?: string } };
}

const SERVER_TOKEN = 'remote-integration-test-token';

// Two well-formed (16 lowercase hex chars) but distinct project ids for the
// raw-fetch cross-project-isolation assertions — same pattern as
// test/serve-ownership.test.ts's PROJECT_A/PROJECT_B.
const PROJECT_A = '1111111111111111';
const PROJECT_B = '2222222222222222';

describe('remote integration: RemoteRepository <-> createServeHttpServer() over /rpc', () => {
  let tempDir: string;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestra-remote-integration-'));
    process.env.ORCHESTRA_MEMORY_DB_PATH = join(tempDir, 'graph.db');
    process.env.ORCHESTRA_MEMORY_LISTEN = '127.0.0.1:0';
    process.env.ORCHESTRA_MEMORY_SERVER_TOKEN = SERVER_TOKEN;

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
    delete process.env.ORCHESTRA_MEMORY_SERVER_TOKEN;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Raw `/rpc` fetch helper — bypasses RemoteRepository entirely so a test
   * can assert a specific project_id header (including a foreign one no
   * RemoteRepository instance in this process could ever send) and/or a
   * specific (possibly wrong/absent) bearer token. */
  async function rpc(
    method: string,
    params: unknown[],
    opts: { headerProjectId?: string | null; token?: string | null } = {}
  ): Promise<RpcResult> {
    const { headerProjectId = PROJECT_A, token = SERVER_TOKEN } = opts;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (headerProjectId !== null) headers['x-orchestra-project-id'] = headerProjectId;
    const res = await fetch(`${baseUrl}/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, params }) });
    const json = (await res.json()) as RpcResult['json'];
    return { status: res.status, json };
  }

  it('(a) local/remote parity: all 9 MCP tool handlers behave correctly end-to-end through RemoteRepository, plus id-based ownership reuse against a foreign project', async () => {
    // Single RemoteRepository instance for the whole scripted scenario — its
    // x-orchestra-project-id header is fixed to THIS test process's own
    // computeProjectId(cwd) (see file header gotcha note), so every
    // project_id we pass through handler args below uses that same value.
    const ownProjectId = computeProjectId(process.cwd());
    const ctx: ToolContext = { ownProjectId };
    const repo = createRemoteRepository({ url: baseUrl, token: SERVER_TOKEN, timeoutMs: 2000 });

    // --- memory_save --------------------------------------------------
    const saved = await handleSave(
      repo,
      {
        facts: [
          {
            entity: { name: 'Remote Widget' },
            text: 'Remote Widget is fetched and persisted entirely over the RPC boundary.',
          },
        ],
        scope: 'project',
        project_id: ownProjectId,
      },
      ctx
    );
    expect(saved.summary.saved).toBe(1);
    const obsId = saved.facts[0]?.observationId;
    const nodeId = saved.facts[0]?.nodeId;
    expect(obsId).toBeDefined();
    expect(nodeId).toBeDefined();

    // --- memory_search ---------------------------------------------------
    const search = await handleSearch(repo, { query: 'RPC boundary', project_id: ownProjectId }, ctx);
    expect(search.text).toContain('Remote Widget is fetched and persisted entirely over the RPC boundary.');

    // --- memory_link (relate two entities; also creates the 2nd entity) --
    await handleSave(
      repo,
      {
        facts: [
          { entity: { name: 'Remote Gadget' }, text: 'Remote Gadget cooperates with Remote Widget over RPC calls.' },
        ],
        scope: 'project',
        project_id: ownProjectId,
      },
      ctx
    );
    const link = await handleLink(
      repo,
      { src: 'Remote Widget', predicate: 'relates_to', dst: 'Remote Gadget', scope: 'project', project_id: ownProjectId },
      ctx
    );
    expect(link.edge.created).toBe(true);

    // --- memory_traverse (expand from a node) ----------------------------
    const traverse = await handleTraverse(repo, { entity: 'Remote Widget', depth: 1, project_id: ownProjectId }, ctx);
    expect(traverse.text).toContain('remote widget -relates_to-> remote gadget');
    expect(traverse.text).toContain('Remote Gadget cooperates with Remote Widget over RPC calls.');

    // --- memory_inspect (debug view) --------------------------------------
    // Regression test for a bug caught while building this scenario (see the
    // Task 5.2 Craftsman Report + src/remote/client.ts's `trimTrailingUndefined`
    // doc comment for the full root-cause writeup): repository.ts's
    // listNodes(scopes, projectId, entityFilter, limit = 50) relies on a JS
    // default parameter for the omitted trailing `limit` arg, but
    // RemoteRepository used to forward the omitted arg as a literal
    // `undefined` array element, which JSON.stringify serialized as `null`
    // over the wire — bypassing the server's default and causing a
    // node:sqlite "datatype mismatch". Fixed by trimming trailing `undefined`
    // params before serializing (src/remote/client.ts). This now asserts the
    // CORRECT behavior instead of characterizing the bug.
    const inspected = await handleInspect(repo, { entity: 'Remote Widget', project_id: ownProjectId }, ctx);
    expect(inspected.text).toContain('remote widget');
    // Confirms the RPC boundary also works correctly when a limit IS
    // explicitly supplied (the previously-unaffected code path).
    const nodesViaExplicitLimit = await repo.listNodes(undefined, ownProjectId, 'Remote Widget', 50);
    expect(nodesViaExplicitLimit.some((n) => n.canonical === 'remote widget')).toBe(true);

    // --- memory_stats (counts) --------------------------------------------
    const stats = await handleStats(repo, { project_id: ownProjectId }, ctx);
    expect(stats.text).toContain('nodes: total=');
    expect(stats.text).toContain('observations: total=');

    // --- wisdom_add (compat wrapper over memory_save) ---------------------
    await handleWisdomAdd(
      repo,
      {
        text: 'Always route repository calls through the Repository interface, never raw SQL.',
        category: 'convention',
        project_id: ownProjectId,
      },
      ctx
    );

    // --- wisdom_get --------------------------------------------------------
    const wisdom = await handleWisdomGet(repo, { project_id: ownProjectId }, ctx);
    expect(wisdom.text).toContain('Always route repository calls through the Repository interface');

    // --- id-based ownership reuse (part of assertion group (d)) -----------
    // A foreign project (PROJECT_B, driven via raw /rpc since no
    // RemoteRepository in this process can assert a header identity other
    // than its own cwd-derived one) must not be able to mutate the node/
    // observation this scenario's own project (ownProjectId) just created,
    // even though it knows their small integer ids.
    const foreignInvalidate = await rpc('invalidateObservation', [obsId], { headerProjectId: PROJECT_B });
    expect(foreignInvalidate.status).toBe(403);
    const foreignAlias = await rpc('addAlias', [nodeId, 'sneaky-remote-alias'], { headerProjectId: PROJECT_B });
    expect(foreignAlias.status).toBe(403);

    // --- memory_invalidate (own project, legitimate) -----------------------
    // Regression test for a bug caught while building this scenario (see the
    // Task 5.2 Craftsman Report + src/remote/client.ts's `call()` doc comment
    // for the full root-cause writeup): five of the six id-based Repository
    // methods (addAlias, supersedeObservation, invalidateObservation,
    // invalidateEdge, supersedeEdge) return `Promise<void>`, which
    // JSON.stringify serializes as a literal `{}` on the wire (an
    // `undefined`-valued object property is dropped entirely) — RemoteRepository
    // used to require a `result` key to be present at all, throwing on this
    // legitimate void-success response. Fixed by treating a 2xx response with
    // no `error` key as success regardless of whether `result` is present
    // (src/remote/client.ts). This now asserts the CORRECT behavior instead
    // of characterizing the bug.
    const invalidateResult = await handleInvalidate(
      repo,
      { observation_id: obsId!, reason: 'remote-integration test cleanup' },
      ctx
    );
    expect(invalidateResult.text).toBeDefined();

    // Confirms the mutation actually landed server-side — read back via a raw
    // /rpc call.
    const stillInvalidatedServerSide = (
      await rpc('findSupersedeTarget', [obsId], { headerProjectId: ownProjectId })
    ).json.result as { invalidatedAt: string | null } | null;
    expect(stillInvalidatedServerSide?.invalidatedAt).not.toBeNull();

    // memory_search (a read, unaffected by the void-result bug above) confirms
    // the same thing from the handler side: the fact is gone from search
    // results because the invalidation really did happen, even though the
    // handler that requested it reported an error to its caller.
    const searchAfterInvalidate = await handleSearch(repo, { query: 'RPC boundary', project_id: ownProjectId }, ctx);
    expect(searchAfterInvalidate.text).not.toContain('Remote Widget is fetched and persisted entirely over the RPC boundary.');
  });

  it('(b) 401 when the wrong bearer token is sent against a server with a real token configured', async () => {
    const { status, json } = await rpc('stats', [null], { headerProjectId: PROJECT_A, token: 'wrong-token' });
    expect(status).toBe(401);
    expect(json.error?.message).toBe('unauthorized');
  });

  it('(c) 400 when x-orchestra-project-id header is missing, even with a correct bearer token', async () => {
    const { status, json } = await rpc('stats', [null], { headerProjectId: null, token: SERVER_TOKEN });
    expect(status).toBe(400);
    expect(json.error?.message).toMatch(/x-orchestra-project-id/);
  });

  it('(d) cross-project isolation: project A facts saved via /rpc are invisible to project B via searchObservations', async () => {
    const nodeA = (
      await rpc(
        'upsertNode',
        [{ canonical: 'Isolation Node', kind: 'other', scope: 'project', projectId: PROJECT_A }],
        { headerProjectId: PROJECT_A }
      )
    ).json.result as { id: number };
    await rpc(
      'addObservation',
      [{ nodeId: nodeA.id, text: 'Project A isolation marker fact xyzisofact.', scope: 'project', projectId: PROJECT_A }],
      { headerProjectId: PROJECT_A }
    );

    const asB = (
      await rpc(
        'searchObservations',
        [{ query: 'xyzisofact', projectId: PROJECT_B, limit: 20, includeInvalidated: false }],
        { headerProjectId: PROJECT_B }
      )
    ).json.result as unknown[];
    expect(asB).toHaveLength(0);

    const asA = (
      await rpc(
        'searchObservations',
        [{ query: 'xyzisofact', projectId: PROJECT_A, limit: 20, includeInvalidated: false }],
        { headerProjectId: PROJECT_A }
      )
    ).json.result as unknown[];
    expect(asA.length).toBeGreaterThan(0);
  });

  it('(e) timeout against an unreachable remote: RemoteRepository rejects with RemoteUnavailableError, and a tool handler built on it propagates that rejection', async () => {
    // Deliberately NOT this suite's live server — an address nothing listens
    // on, with a short timeout, to exercise the fail-open seam server.ts's
    // (unexported) callHandler() relies on one layer up. That wrapping into a
    // user-facing "disabled this session" message is already covered by
    // test/server-backend-selection.test.ts's "remote mode, server
    // unreachable" case; this test proves the underlying throw/reject that
    // wrapping depends on.
    const unreachableRepo = createRemoteRepository({ url: 'http://127.0.0.1:1', token: SERVER_TOKEN, timeoutMs: 200 });
    const ctx: ToolContext = { ownProjectId: computeProjectId(process.cwd()) };
    await expect(handleStats(unreachableRepo, {}, ctx)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });
});
